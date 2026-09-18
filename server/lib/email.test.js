// server/lib/email.js(sendEmail) 단위테스트 — 설계 정본 docs/design/email-send-tool.md §6.5·§12.
//
// audit_logs/users는 mock하지 않는다 — node:sqlite 위에 0001(users/audit_logs 초기 정의 발췌) +
// 0009→0030(audit_logs 누적 마이그레이션 실물)을 그대로 적용한 진짜 SQLite로 돌려서 U-5(json_extract
// 기반 부분 UNIQUE 인덱스가 실제로 생성되고 중복을 막는지)를 실물로 증명한다
// (server/dao/google-login-flows.test.js·server/api/plugin-deploys.test.js의 실DDL 패턴 계승).
//
// ⚠️ 0001 파일 전체를 그대로 실행하지 않는다 — FTS 트리거(BEGIN...END)가 세미콜론을 포함해
// 이 테스트들이 쓰는 "세미콜론으로 split" 방식의 실행기와 맞지 않는다. users/audit_logs 초기
// 정의만 0001에서 그대로 옮겨 적었다(2026-09-18 확인, 문자 하나 다르지 않음) — 이후 audit_logs는
// 0009~0030 실 마이그레이션 파일을 그대로 적용해 CHECK enum·인덱스가 실제 배포 상태와 동일하다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sendEmail, checkEmailRateLimit, raceTimeout, FROM_ADDRESS } from './email.js'
import { RENDERER_VERSION, escapeHtml } from './markdown.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))
const AUDIT_MIGRATION_FILES = [
  '0009_audit_logs_oauth_actions.sql',
  '0018_add_admin_usage_sync_audit_action.sql',
  '0021_audit_logs_employee_id_action.sql',
  '0023_audit_logs_shared_workstation_action.sql',
  '0026_audit_logs_google_action.sql',
  '0030_audit_logs_email_send_action.sql'
]

const INITIAL_DDL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK(role IN ('employee','administrator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(email)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'user.role_changed',
    'device_token.issued','device_token.revoked',
    'admin.cross_user_view'
  )),
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
`

/** D1 prepare().bind().run()/.first()/.all() 인터페이스를 흉내내는 얇은 어댑터
 *  (server/dao/google-login-flows.test.js·server/api/plugin-deploys.test.js와 동일 패턴). */
function makeSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  for (const stmt of INITIAL_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    raw.exec(stmt)
  }
  for (const file of AUDIT_MIGRATION_FILES) {
    const ddl = readFileSync(MIGRATIONS_DIR + file, 'utf8')
    for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
      raw.exec(stmt)
    }
  }
  return {
    raw,
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => {
            const info = raw.prepare(sql).run(...args)
            return { meta: { changes: info.changes } }
          },
          first: async () => raw.prepare(sql).get(...args) || null,
          all: async () => ({ results: raw.prepare(sql).all(...args) })
        })
      }
    }
  }
}

let idCounter = 0
function insertUser(db, { status = 'active' } = {}) {
  const id = `user-${++idCounter}`
  const now = new Date().toISOString()
  db.raw
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'employee', ?, ?, ?)`
    )
    .run(id, `emp${idCounter}@malgnsoft.com`, `직원${idCounter}`, status, now, now)
  return id
}

function makeRl(success = true) {
  return { limit: vi.fn().mockResolvedValue({ success }) }
}

function makeEmailBinding(impl) {
  return { send: vi.fn(impl || (async () => ({ messageId: 'msg-1' }))) }
}

function baseEnv({ db, rl, email } = {}) {
  return {
    DB: db || makeSqliteDb(),
    EMAIL_SEND_RL: rl === undefined ? makeRl(true) : rl,
    EMAIL: email === undefined ? makeEmailBinding() : email
  }
}

function args(overrides = {}) {
  return {
    userId: overrides.userId,
    deviceId: 'dev-1',
    to: 'ok@malgnsoft.com',
    subject: '제목',
    text: '본문',
    projectId: null,
    idempotencyKey: `dev-1:sess-1:${Date.now()}:email`,
    ...overrides
  }
}

async function expectRejected(promise, code) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('sendEmail — 바인딩 부재(fail-closed, §4.4)', () => {
  it('EMAIL_SEND_RL 미주입 → CONFIG_ERROR, send 호출 0', async () => {
    const email = makeEmailBinding()
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db, rl: null, email })
    await expectRejected(sendEmail(env, args({ userId })), 'CONFIG_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('EMAIL 미주입 → CONFIG_ERROR, send 호출 0', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db, email: null })
    await expectRejected(sendEmail(env, args({ userId })), 'CONFIG_ERROR')
  })
})

describe('sendEmail — 레이트리밋(§4)', () => {
  it('한도 초과(success:false) → RATE_LIMITED, send 호출 0', async () => {
    const email = makeEmailBinding()
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db, rl: makeRl(false), email })
    await expectRejected(sendEmail(env, args({ userId })), 'RATE_LIMITED')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('checkEmailRateLimit — limit() 예외 시 fail-closed로 throw(RATE_LIMIT_UNAVAILABLE), 기존 checkRateLimit()과 반대', async () => {
    const rl = { limit: vi.fn().mockRejectedValue(new Error('boom')) }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(checkEmailRateLimit(rl, 'u1')).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('sendEmail 전체 흐름에서도 limit() 예외 시 RATE_LIMIT_UNAVAILABLE로 거부되고 send 호출 0', async () => {
    const email = makeEmailBinding()
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const rl = { limit: vi.fn().mockRejectedValue(new Error('boom')) }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = baseEnv({ db, rl, email })
    await expectRejected(sendEmail(env, args({ userId })), 'RATE_LIMIT_UNAVAILABLE')
    expect(email.send).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('sendEmail — E-8 국소 방어(비활성 사용자, §10.3)', () => {
  it("status='disabled' 사용자 → FORBIDDEN, send 호출 0", async () => {
    const email = makeEmailBinding()
    const db = makeSqliteDb()
    const userId = insertUser(db, { status: 'disabled' })
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId })), 'FORBIDDEN')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('존재하지 않는 userId → FORBIDDEN(존재 여부를 노출하지 않음)', async () => {
    const email = makeEmailBinding()
    const db = makeSqliteDb()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId: 'ghost' })), 'FORBIDDEN')
  })
})

describe('sendEmail — 입력 상한(§5)', () => {
  it('to 6개 → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    const to = Array.from({ length: 6 }, (_, i) => `u${i}@malgnsoft.com`)
    await expectRejected(sendEmail(env, args({ userId, to })), 'VALIDATION_ERROR')
  })

  it('subject 201자 → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    await expectRejected(sendEmail(env, args({ userId, subject: 'a'.repeat(201) })), 'VALIDATION_ERROR')
  })

  it('text 한글 20,000자(바이트 상한 초과) → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    await expectRejected(sendEmail(env, args({ userId, text: '가'.repeat(20000) })), 'VALIDATION_ERROR')
  })

  it('text 10,000자를 넘는 문자 길이만으로도 VALIDATION_ERROR(바이트 이전에 길이로 걸림)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    await expectRejected(sendEmail(env, args({ userId, text: 'a'.repeat(10001) })), 'VALIDATION_ERROR')
  })
})

describe('sendEmail — CRLF/NUL 헤더 인젝션(§6.3·§6.5)', () => {
  it('subject에 CRLF → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    await expectRejected(sendEmail(env, args({ userId, subject: 'a\r\nBcc: attacker@evil.com' })), 'VALIDATION_ERROR')
  })

  it('to에 개행이 섞이면 → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const env = baseEnv({ db })
    await expectRejected(sendEmail(env, args({ userId, to: 'a@malgnsoft.com\nCc: x@y.com' })), 'VALIDATION_ERROR')
  })

  it('subject에 공백(스페이스) 정상 문자열은 통과', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, subject: 'a b' }))
    expect(out.ok).toBe(true)
  })

  it('text에 개행이 여러 번 있어도 통과(본문 개행은 정상)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, text: '1줄\n2줄\n\n4줄' }))
    expect(out.ok).toBe(true)
  })

  it('text에 <script>가 있어도 통과하고, 생성된 html에는 이스케이프되어 실린다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, text: '<script>alert(1)</script>' }))
    expect(out.ok).toBe(true)
    const sentArg = email.send.mock.calls[0][0]
    expect(sentArg.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(sentArg.html).not.toContain('<script>')
  })
})

// 🔴 §6.4-2 판정표를 그대로 케이스화 — D9 수신자 도메인 게이트. endsWith/includes/서브도메인
// 매칭 구현으로 회귀하면 이 스위트가 잡아낸다.
describe('sendEmail — 🔴 수신자 도메인 게이트(D9·§6.4) 판정표 전 행', () => {
  const allowCases = ['hong@malgnsoft.com', 'Hong.GD@MalgnSoft.Com', ' hong@malgnsoft.com']
  for (const to of allowCases) {
    it(`허용: ${JSON.stringify(to)}`, async () => {
      const db = makeSqliteDb()
      const userId = insertUser(db)
      const email = makeEmailBinding()
      const env = baseEnv({ db, email })
      const out = await sendEmail(env, args({ userId, to }))
      expect(out.ok).toBe(true)
      expect(email.send).toHaveBeenCalledTimes(1)
    })
  }

  const domainRejectCases = [
    ['evil@malgnsoft.com.attacker.kr', 'includes 구현이었다면 통과했을 함정'],
    ['malgnsoft.com@attacker.kr', '로컬파트에 도메인을 심는 함정'],
    ['evil@evilmalgnsoft.com', 'endsWith의 대표 함정'],
    ['x@sub.malgnsoft.com', '서브도메인 불허'],
    ['x@malgnsoft.co.kr', '다른 TLD']
  ]
  for (const [to, why] of domainRejectCases) {
    it(`RECIPIENT_DOMAIN_NOT_ALLOWED: ${to} (${why})`, async () => {
      const db = makeSqliteDb()
      const userId = insertUser(db)
      const email = makeEmailBinding()
      const env = baseEnv({ db, email })
      await expectRejected(sendEmail(env, args({ userId, to })), 'RECIPIENT_DOMAIN_NOT_ALLOWED')
      expect(email.send).not.toHaveBeenCalled()
    })
  }

  const validationRejectCases = [
    ['x@malgnsoft.com.', '후행 점'],
    ['x@xn--malgnsoft-2b3b.com', 'punycode'] // ASCII visible이라 문법은 통과 → 아래 별도 검증
  ]
  it('x@malgnsoft.com. (후행 점) → VALIDATION_ERROR(EMAIL_RE 불통과)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'x@malgnsoft.com.' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('x@xn--malgnsoft-2b3b.com (punycode, 디코딩하지 않는다) → RECIPIENT_DOMAIN_NOT_ALLOWED', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'x@xn--malgnsoft-2b3b.com' })), 'RECIPIENT_DOMAIN_NOT_ALLOWED')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('hоng@malgnsoft.com (로컬파트에 키릴 о, 혼동문자) → VALIDATION_ERROR(B4 ASCII 게이트)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'hпng@malgnsoft.com' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('x@malgnsоft.com (도메인에 키릴 о) → VALIDATION_ERROR(B4)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'x@malgnsоft.com' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('x@ｍalgnsoft.com (전각 문자) → VALIDATION_ERROR(B4)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'x@ｍalgnsoft.com' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('"홍길동" <hong@malgnsoft.com> (표시명 형식) → VALIDATION_ERROR(B3)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: '"홍길동" <hong@malgnsoft.com>' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('hong@malgnsoft.com> (닫는 꺾쇠만) → VALIDATION_ERROR(B3)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'hong@malgnsoft.com>' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('a@b@malgnsoft.com (@ 2개) → VALIDATION_ERROR(B5)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'a@b@malgnsoft.com' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('hong@malgnsoft.com\\r\\nBcc: x@evil.kr → VALIDATION_ERROR(B4/제어문자)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, to: 'hong@malgnsoft.com\r\nBcc: x@evil.kr' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  // 🔴 부분발송 없음 — 배열 중 1개만 도메인 위반이어도 전체 거부하고, 감사 INSERT도 send도 0회.
  it("['ok@malgnsoft.com','bad@attacker.kr'] → RECIPIENT_DOMAIN_NOT_ALLOWED + send 호출 0 + audit INSERT도 0", async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(
      sendEmail(env, args({ userId, to: ['ok@malgnsoft.com', 'bad@attacker.kr'] })),
      'RECIPIENT_DOMAIN_NOT_ALLOWED'
    )
    expect(email.send).not.toHaveBeenCalled()
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='email.send'").get()
    expect(row.n).toBe(0)
  })

  it('도메인 위반 시 console.warn이 도메인만 남기고 주소 전체는 남기지 않는다(§6.4-5)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expectRejected(sendEmail(env, args({ userId, to: 'bad@attacker.kr' })), 'RECIPIENT_DOMAIN_NOT_ALLOWED')
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = spy.mock.calls[0][0]
    expect(logged.evt).toBe('email.recipient_domain_blocked')
    expect(logged.rejectedDomains).toEqual(['attacker.kr'])
    expect(JSON.stringify(logged)).not.toContain('bad@attacker.kr')
    spy.mockRestore()
  })

  it('도메인 게이트에서 거부되면 idempotencyKey를 소모하지 않는다(같은 키로 재호출 가능, §6.4-5)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000000:email'
    await expectRejected(sendEmail(env, args({ userId, to: 'bad@attacker.kr', idempotencyKey })), 'RECIPIENT_DOMAIN_NOT_ALLOWED')
    // 같은 키로 주소만 고쳐 재호출 — 성공해야 한다(키가 소모되지 않았다는 증거).
    const out = await sendEmail(env, args({ userId, to: 'ok@malgnsoft.com', idempotencyKey }))
    expect(out.ok).toBe(true)
    expect(out.deduplicated).toBeUndefined()
  })
})

describe('sendEmail — 감사 INSERT 실패 시 발송하지 않음(fail-closed, §3.7 — 가장 중요한 테스트)', () => {
  it('audit_logs INSERT가 실패하면 env.EMAIL.send는 호출되지 않는다(AUDIT_WRITE_FAILED)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    // audit_logs INSERT만 실패하게 만든다(테이블 자체를 지우면 §4.3의 L2 COUNT 쿼리도 함께
    // 깨져 "무엇이 실패했나"가 불명확해진다) — BEFORE INSERT 트리거로 INSERT만 표적 차단해
    // DB 장애(§10 E-1)를 이 INSERT 지점에서만 정확히 재현한다.
    db.raw.exec("CREATE TRIGGER block_audit_insert BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END")
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId })), 'AUDIT_WRITE_FAILED')
    expect(email.send).not.toHaveBeenCalled()
  })
})

describe('sendEmail — 멱등성(D4·§3.5)', () => {
  it('같은 idempotencyKey로 2회 호출 시 send 호출 횟수 1, 두 번째 응답은 재발송하지 않되 성공을 단언하지 않는다(F-1)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000001:email'
    const first = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(first.ok).toBe(true)
    expect(first.deduplicated).toBeUndefined()

    // F-1(security H-1 = reviewer C-1) — 감사 행은 "시도"만 의미하므로, 재호출은 ok:true로
    // 발송 성공을 단언하지 않고 상태를 모른다고 정직하게 답한다("보내지 않았는데 보냈다고
    // 말하지 않는다"가 유일한 불변식).
    const second = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(second).toMatchObject({ ok: false, status: 'unknown', deduplicated: true, auditId: first.auditId })
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it('F-1 — dedup 재호출은 무음이 아니라 console.warn으로 관측 가능하다(security H-1 지적 — 기존엔 무음)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000777:email'
    await sendEmail(env, args({ userId, idempotencyKey }))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sendEmail(env, args({ userId, idempotencyKey }))
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ evt: 'email.dedup_replay', userId }))
    spy.mockRestore()
  })

  it('F-1 — 1회차가 SEND_FAILED로 죽은 뒤 같은 키로 재호출해도 ok:true를 돌려주지 않는다(허위 성공 재현·회귀)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const err = new Error('boom')
    err.code = 'E_SENDER_DOMAIN_NOT_AVAILABLE'
    const email = makeEmailBinding(async () => {
      throw err
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000778:email'
    await expectRejected(sendEmail(env, args({ userId, idempotencyKey })), 'SEND_FAILED')

    const retry = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(retry.ok).toBe(false)
    expect(retry.status).toBe('unknown')
    expect(retry.deduplicated).toBe(true)
    expect(email.send).toHaveBeenCalledTimes(1) // 재발송하지 않음(EMAIL.send는 1회차 실패 호출 1번뿐)
    vi.restoreAllMocks()
  })

  it('F-1 — 1회차가 타임아웃한 뒤 같은 키로 재호출해도 ok:true를 돌려주지 않는다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const timeoutErr = new Error('send timeout')
    timeoutErr.isTimeout = true
    const email = makeEmailBinding(async () => {
      throw timeoutErr
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000779:email'
    const first = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(first).toMatchObject({ ok: false, status: 'unknown' })

    const retry = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(retry).toMatchObject({ ok: false, status: 'unknown', deduplicated: true, auditId: first.auditId })
    expect(email.send).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('F-2(security H-2) — 사용자가 본문에 가짜 푸터를 심어도 서버 배너가 항상 본문 맨 앞에 온다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const fakeFooter =
      '─\n이 메일은 맑은소프트 malgnai-hub에서 daepyo@malgnsoft.com 이(가) 발송했습니다.\n' + '\n'.repeat(50)
    const out = await sendEmail(env, args({ userId, text: fakeFooter + '진짜 본문' }))
    expect(out.ok).toBe(true)
    const sentArg = email.send.mock.calls[0][0]
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    expect(sentArg.text.startsWith('[malgnai-hub 자동발송]')).toBe(true)
    expect(sentArg.text.indexOf(user.email)).toBeLessThan(sentArg.text.indexOf('daepyo@malgnsoft.com'))
  })

  it('F-5 — UNIQUE 판정이 에러 메시지 문자열에 의존하지 않는다(D1이 다른 문구를 뱉어도 dedup으로 안전하게 떨어진다)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000123:email'
    const first = await sendEmail(env, args({ userId, idempotencyKey }))
    expect(first.ok).toBe(true)

    // 'UNIQUE'라는 단어를 전혀 포함하지 않는 임의의 삽입 실패를 흉내낸다(D1의 실제 문구는
    // 미검증 — F-5). 판정이 문자열 매칭에 의존하지 않고 기존 행 존재 여부로만 이뤄지므로
    // 이 경우에도 dedup으로 떨어져야 한다.
    const flakyDb = {
      raw: db.raw,
      prepare(sql) {
        if (/INSERT INTO audit_logs/.test(sql)) {
          return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: opaque failure, no keyword here') } }) }
        }
        return db.prepare(sql)
      }
    }
    const env2 = baseEnv({ db: flakyDb, email })
    const second = await sendEmail(env2, args({ userId, idempotencyKey }))
    expect(second).toMatchObject({ ok: false, status: 'unknown', deduplicated: true, auditId: first.auditId })
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it('F-6 — 같은 idempotencyKey에 다른 본문이 오면 조용한 멱등이 아니라 명시적 충돌 에러로 거부한다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758000456:email'
    const first = await sendEmail(env, args({ userId, idempotencyKey, text: '원본 본문' }))
    expect(first.ok).toBe(true)
    await expectRejected(
      sendEmail(env, args({ userId, idempotencyKey, text: '다른 본문으로 재사용' })),
      'IDEMPOTENCY_KEY_CONFLICT'
    )
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it('F-7 — replyTo(호출자 users.email)에 CRLF가 있으면 CONFIG_ERROR로 거부하고 send 호출 0', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    db.raw.prepare('UPDATE users SET email = ? WHERE id = ?').run('bad@malgnsoft.com\r\nBcc: evil@x.com', userId)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId })), 'CONFIG_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('F-3/M-2 회귀 — audit_logs에 명명된 인덱스가 정확히 4개다(재생성 블록에서 idx_audit_email_idem이 빠지면 3으로 줄어든다)', async () => {
    const db = makeSqliteDb()
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs' AND name NOT LIKE 'sqlite_autoindex%'")
      .all()
    expect(rows.map((r) => r.name).sort()).toEqual(['idx_audit_actor', 'idx_audit_created', 'idx_audit_email_idem', 'idx_audit_target'])
  })

  it('F-4/M-4 — 감사 metadata_json에 필수 필드(to/subject/bodyHash/replyTo/from/toCount/deviceId/sessionId)가 사용자 원문 기준으로 정확히 저장된다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const { sha256Hex } = await import('./tokens.js')
    const out = await sendEmail(env, args({ userId, to: ['ok@malgnsoft.com'], subject: '점검 안내', text: '본문 원문' }))
    const row = db.raw.prepare('SELECT metadata_json FROM audit_logs WHERE id = ?').get(out.auditId)
    const meta = JSON.parse(row.metadata_json)
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    expect(meta.op).toBe('attempt')
    expect(meta.to).toEqual(['ok@malgnsoft.com'])
    expect(meta.toCount).toBe(1)
    expect(meta.subject).toBe('점검 안내')
    expect(meta.replyTo).toBe(user.email)
    expect(meta.from).toBe(FROM_ADDRESS)
    expect(meta.footerApplied).toBe(true)
    expect(meta.deviceId).toBe('dev-1')
    expect(meta.sessionId).toBe('sess-1')
    // N-6과 함께 해결 — bodyHash는 배너·푸터를 붙이기 전의 사용자 원문 기준이어야 한다.
    expect(meta.bodyHash).toBe(await sha256Hex('본문 원문'))
  })

  it('U-5 실증 — json_extract 기반 부분 UNIQUE 인덱스가 실제 SQLite에 생성되고, 동시성 없이도 중복 INSERT를 원자적으로 막는다', async () => {
    const db = makeSqliteDb()
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_email_idem'")
      .get()
    expect(idx).toBeTruthy()
  })
})

describe('sendEmail — 발송 성공 시 헤더·발신자·회신주소(§3.3·§8.2)', () => {
  it('발송 호출 인자에 X-Malgnai-Hub-Audit-Id가 감사 행 id와 일치하고, replyTo=호출자 이메일, from=FROM_ADDRESS', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId }))
    const sentArg = email.send.mock.calls[0][0]
    expect(sentArg.headers['X-Malgnai-Hub-Audit-Id']).toBe(out.auditId)
    expect(sentArg.from.email).toBe(FROM_ADDRESS)
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    expect(sentArg.replyTo).toBe(user.email)
    expect(sentArg.text).toContain(user.email) // 푸터에도 노출(§2.6-3)
  })
})

describe('sendEmail — 발송 실패/타임아웃(§10 E-2·E-3)', () => {
  it('env.EMAIL.send()가 throw하면 감사 행은 남고 SEND_FAILED로 거부된다(허위 음성 금지)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const err = new Error('upstream boom')
    err.code = 'E_SENDER_DOMAIN_NOT_AVAILABLE'
    const email = makeEmailBinding(async () => {
      throw err
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId })), 'SEND_FAILED')
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='email.send'").get()
    expect(row.n).toBe(1)
    vi.restoreAllMocks()
  })

  // sendEmail() 전체(crypto.subtle·D1 등 실비동기 계층 다수)를 fake timer와 섞으면 어느 계층이
  // 진짜 타이머인지 불확실해져 테스트가 불안정해진다 — 그래서 sendEmail()이 실제로 쓰는
  // raceTimeout() 자체를 직접 검증한다(§9.3 9번의 메커니즘과 완전히 동일한 함수).
  it('raceTimeout — 15초 내에 안 끝나면 취소가 아니라 isTimeout 플래그가 실린 예외로 대기를 포기한다(§10 E-3)', async () => {
    vi.useFakeTimers()
    try {
      const neverResolves = new Promise(() => {})
      const promise = raceTimeout(neverResolves, 15000)
      const assertion = expect(promise).rejects.toMatchObject({ isTimeout: true })
      await vi.advanceTimersByTimeAsync(15000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('raceTimeout — 원본 promise가 타임아웃 전에 성공하면 그 결과를 그대로 반환한다', async () => {
    const result = await raceTimeout(Promise.resolve({ messageId: 'm1' }), 15000)
    expect(result).toEqual({ messageId: 'm1' })
  })

  it('sendEmail — env.EMAIL.send()가 raceTimeout이 만드는 isTimeout 예외를 만나면 throw 대신 ok:false를 반환하고 감사 행은 남는다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const timeoutErr = new Error('send timeout')
    timeoutErr.isTimeout = true
    const email = makeEmailBinding(async () => {
      throw timeoutErr
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId }))
    expect(out).toMatchObject({ ok: false, status: 'unknown' })
    expect(out.auditId).toBeTruthy()
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='email.send'").get()
    expect(row.n).toBe(1)
    vi.restoreAllMocks()
  })
})

describe('sendEmail — 일일 볼륨 상한(L2, §4.3)', () => {
  it('24시간 이내 50건이 이미 있으면 51번째 시도는 RATE_LIMITED, send 호출 0', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const now = new Date().toISOString()
    for (let i = 0; i < 50; i++) {
      db.raw
        .prepare(
          `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
           VALUES (?, ?, 'email.send', 'email', 'x@malgnsoft.com', ?, ?)`
        )
        .run(`aud-${i}`, userId, JSON.stringify({ idempotencyKey: `k-${i}` }), now)
    }
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId })), 'RATE_LIMITED')
    expect(email.send).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// docs/design/email-send-tool.md §14(설계 라운드 2 — 마크다운 서브셋). §14.10의 T-I(26~31) +
// T-B(22·25, 배너·푸터 조립이 필요해 markdown.test.js에서는 검증할 수 없는 항목) + T-G(32,
// 배너·푸터 포함 전문 골든 스냅샷)를 여기 담는다. 이 구획 위의 기존 케이스는 한 건도 고치지
// 않았다(추가만) — 고쳐야 통과한다면 그건 plain 경로를 깬 것이다(§14.11 backend-dev 체크리스트).
// ---------------------------------------------------------------------------
function insertUserWithEmail(db, email) {
  const id = `user-${++idCounter}`
  const now = new Date().toISOString()
  db.raw
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'employee', 'active', ?, ?)`
    )
    .run(id, email, '직원', now, now)
  return id
}

describe('sendEmail — format:\'markdown\' 통합(T-I, §14.10)', () => {
  it('26. format:markdown + 수신자 도메인 위반 → RECIPIENT_DOMAIN_NOT_ALLOWED, send 호출 0(렌더가 게이트보다 뒤임을 고정)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(
      sendEmail(env, args({ userId, to: 'bad@attacker.kr', format: 'markdown', text: '**굵게**' })),
      'RECIPIENT_DOMAIN_NOT_ALLOWED'
    )
    expect(email.send).not.toHaveBeenCalled()
  })

  it('27. format:markdown + subject에 CRLF → VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(
      sendEmail(env, args({ userId, format: 'markdown', subject: 'a\r\nBcc: attacker@evil.com' })),
      'VALIDATION_ERROR'
    )
    expect(email.send).not.toHaveBeenCalled()
  })

  it('28. 감사 INSERT 실패 시 markdown 경로에서도 send 호출 0(fail-closed 회귀)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    db.raw.exec("CREATE TRIGGER block_audit_insert_md BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END")
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, format: 'markdown', text: '**굵게**' })), 'AUDIT_WRITE_FAILED')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('29. 같은 idempotencyKey·같은 원문·다른 format → IDEMPOTENCY_KEY_CONFLICT(E-26)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const idempotencyKey = 'dev-1:sess-1:1758001000:email'
    const text = '같은 본문'
    const first = await sendEmail(env, args({ userId, idempotencyKey, text, format: 'plain' }))
    expect(first.ok).toBe(true)
    await expectRejected(
      sendEmail(env, args({ userId, idempotencyKey, text, format: 'markdown' })),
      'IDEMPOTENCY_KEY_CONFLICT'
    )
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it('30. format 미지정 → 기존 <pre> 출력과 바이트 단위로 동일(plain 무변경 회귀 감지기)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const text = '1줄\n2줄 **굵게처럼 보이는 문자** <script>x</script>'
    const noFormat = await sendEmail(env, args({ userId, text, idempotencyKey: 'dev-1:sess-1:1758001100:email' }))
    const explicitPlain = await sendEmail(env, args({ userId, text, format: 'plain', idempotencyKey: 'dev-1:sess-1:1758001101:email' }))
    expect(noFormat.ok).toBe(true)
    expect(explicitPlain.ok).toBe(true)
    const htmlA = email.send.mock.calls[0][0].html
    const htmlB = email.send.mock.calls[1][0].html
    expect(htmlA).toBe(htmlB)
    expect(htmlA.startsWith('<pre ')).toBe(true)
    expect(htmlA).toContain('&lt;script&gt;x&lt;/script&gt;')
    // 마크다운 토큰(**)이 조금도 서식으로 해석되지 않는다 — plain은 escape만 거친다.
    expect(htmlA).toContain('**굵게처럼 보이는 문자**')

    // L-2(reviewer) — "두 호출이 서로 같다"만으로는 buildHtml() 자체가 바뀌어 양쪽 다 달라지는
    // 회귀를 통과시킬 수 있다. 기대 html **전문**을 골든 리터럴로 고정한다(§14.4-1 — plain
    // 경로는 한 글자도 바뀌지 않아야 한다). user.email은 insertUser()가 동적으로 채번하므로
    // 하드코딩하지 않고 DB에서 그대로 읽어 기대값을 조립한다.
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    const attribution = `이 메일은 맑은소프트 malgnai-hub에서 ${user.email} 이(가) 발송했습니다.`
    const textWithFooter = `[malgnai-hub 자동발송] ${attribution}\n\n${text}\n\n─\n${attribution}`
    const expectedHtml =
      `<pre style="white-space:pre-wrap;word-break:break-word;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;font-size:14px;margin:0">` +
      escapeHtml(textWithFooter) +
      `</pre>`
    expect(htmlA).toBe(expectedHtml)
  })

  it('m-7 — server/lib/email.js의 로컬 escapeHtml()과 server/lib/markdown.js의 escapeHtml()이 같은 입력에 같은 결과를 낸다(중복 정의는 통합하지 않되 동치를 고정, plain 경로 무변경 원칙)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const text = `특수문자 모음 & < > " ' 그리고 한글도 섞음`
    const out = await sendEmail(env, args({ userId, text, idempotencyKey: 'dev-1:sess-1:1758001200:email' }))
    expect(out.ok).toBe(true)
    const html = email.send.mock.calls[0][0].html
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    const attribution = `이 메일은 맑은소프트 malgnai-hub에서 ${user.email} 이(가) 발송했습니다.`
    const textWithFooter = `[malgnai-hub 자동발송] ${attribution}\n\n${text}\n\n─\n${attribution}`
    // email.js 내부(로컬) escapeHtml()이 만든 결과가 markdown.js가 export하는 escapeHtml()을
    // 같은 문자열에 적용한 결과와 바이트 단위로 같다 — 두 구현이 갈라지면 이 단언이 깨진다.
    expect(html).toBe(
      `<pre style="white-space:pre-wrap;word-break:break-word;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;font-size:14px;margin:0">` +
      escapeHtml(textWithFooter) +
      `</pre>`
    )
  })

  it('31. format:markdown 발송 성공 시 metadata에 bodyFormat/renderer/linkCount/linkHosts가 기록되고 bodyHash는 여전히 sha256(원문)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const { sha256Hex } = await import('./tokens.js')
    const text = '[포털](https://portal.malgnsoft.com/a)'
    const out = await sendEmail(env, args({ userId, text, format: 'markdown' }))
    expect(out.ok).toBe(true)
    const row = db.raw.prepare('SELECT metadata_json FROM audit_logs WHERE id = ?').get(out.auditId)
    const meta = JSON.parse(row.metadata_json)
    expect(meta.bodyFormat).toBe('markdown')
    expect(meta.renderer).toBe(RENDERER_VERSION)
    expect(meta.linkCount).toBe(1)
    expect(meta.linkHosts).toEqual(['portal.malgnsoft.com'])
    expect(meta.bodyHash).toBe(await sha256Hex(text))
  })

  it('m-4 — format:markdown 발송 성공 응답에 bodyFormat이 실려 호출자가 서식 적용 여부를 확인할 수 있다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, text: '**굵게**', format: 'markdown' }))
    expect(out.ok).toBe(true)
    expect(out.bodyFormat).toBe('markdown')
    // 기존 필드는 제거·개명되지 않았다.
    expect(out).toMatchObject({ ok: true, to: ['ok@malgnsoft.com'] })
    expect(typeof out.auditId).toBe('string')
    expect(typeof out.sentAt).toBe('string')
  })

  it("m-4 — format 미지정(기본 'plain') 발송 성공 응답에도 bodyFormat:'plain'이 실린다", async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId }))
    expect(out.ok).toBe(true)
    expect(out.bodyFormat).toBe('plain')
  })

  it("m-9 — format:'markdown'일 때 text 파트(실제 발송값)는 사용자 원문 마크다운을 그대로 보존한다(I-1의 실물 증거)", async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const text = '자세한 내용은 [사내 포털](https://portal.malgnsoft.com/notice/12)을 보세요.\n\n**굵게**도 있습니다.'
    const out = await sendEmail(env, args({ userId, text, format: 'markdown' }))
    expect(out.ok).toBe(true)
    const sentText = email.send.mock.calls[0][0].text
    // 원문 마크다운 문법(`[표시](URL)`, `**굵게**`)이 text 파트에서 평문화되지 않고 글자
    // 그대로 남아 있다 — html 파트만 렌더되고 text 파트는 §14.4-1이 규정한 대로 원문 그대로다.
    expect(sentText).toContain('자세한 내용은 [사내 포털](https://portal.malgnsoft.com/notice/12)을 보세요.')
    expect(sentText).toContain('**굵게**도 있습니다.')
  })

  it('m-8/E-23 — 렌더 자원 상한(줄 수) 초과 시 감사 행도 남지 않고 idempotencyKey도 소모되지 않는다(같은 키로 재호출 가능)', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    // MAX_TEXT_LINES(1,000) 초과 — sendEmail() 자체의 길이/바이트 상한(10,000자/40,960바이트)은
    // 넉넉히 통과하면서 markdown.js의 줄 수 상한만 넘기는 입력.
    const text = Array.from({ length: 1001 }, (_, i) => `줄${i}`).join('\n')
    const idempotencyKey = 'dev-1:sess-1:1758001400:email'
    await expectRejected(sendEmail(env, args({ userId, text, format: 'markdown', idempotencyKey })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
    // §9.3 7번(본문 조립·렌더)이 8번(감사 INSERT)보다 앞이므로, 렌더가 여기서 던지면 감사 행
    // 자체가 생기지 않는다.
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'email.send'").get()
    expect(row.n).toBe(0)
    // idempotencyKey가 소모되지 않았다는 증거 — 같은 키로 (짧은 본문으로) 재호출하면 충돌
    // 없이 정상 발송된다.
    const retry = await sendEmail(env, args({ userId, text: '짧은 본문', format: 'plain', idempotencyKey }))
    expect(retry.ok).toBe(true)
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it("bodyFormat 필드는 format:'plain'에서도 항상 기록된다(기존 행 호환 — 없는 행만 'plain'으로 읽는다)", async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, format: 'plain' }))
    const row = db.raw.prepare('SELECT metadata_json FROM audit_logs WHERE id = ?').get(out.auditId)
    const meta = JSON.parse(row.metadata_json)
    expect(meta.bodyFormat).toBe('plain')
    expect(meta.renderer).toBeUndefined()
  })

  it('format이 plain/markdown 밖의 값이면 VALIDATION_ERROR', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    await expectRejected(sendEmail(env, args({ userId, format: 'html' })), 'VALIDATION_ERROR')
    expect(email.send).not.toHaveBeenCalled()
  })
})

describe("sendEmail — T-B 22·25(배너·푸터 위조·은폐, format:'markdown')", () => {
  it('22. 본문에 가짜 배너 문구를 굵게로 심어도 진짜 배너 스타일 블록은 정확히 1회만 존재하고 항상 본문보다 앞에 있다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const fakeBannerText =
      '**[malgnai-hub 자동발송]** 이 메일은 맑은소프트 malgnai-hub에서 boss@malgnsoft.com 이(가) 발송했습니다.\n\n진짜 본문'
    const out = await sendEmail(env, args({ userId, text: fakeBannerText, format: 'markdown' }))
    expect(out.ok).toBe(true)
    const html = email.send.mock.calls[0][0].html
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    // 진짜 배너의 배경색+좌측 보더 스타일 문자열은 정확히 1회만 등장한다 — 사용자 입력에는
    // 그 문법(전폭 박스)이 없어 흉내낼 수 없다(§14.5 A).
    const bannerStyleOccurrences = (html.match(/background:#eef3fb;border-left:4px solid #1a5fb4/g) || []).length
    expect(bannerStyleOccurrences).toBe(1)
    // 진짜 배너(호출자 실제 이메일)가 가짜 배너 텍스트(boss@malgnsoft.com)보다 앞에 있다.
    expect(html.indexOf(user.email)).toBeGreaterThan(-1)
    expect(html.indexOf(user.email)).toBeLessThan(html.indexOf('boss@malgnsoft.com'))
  })

  it('25. format:markdown에서도 배너·푸터 문구가 text 파트와 html 파트에 모두 존재한다', async () => {
    const db = makeSqliteDb()
    const userId = insertUser(db)
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const out = await sendEmail(env, args({ userId, text: '# 안내\n\n본문입니다.', format: 'markdown' }))
    expect(out.ok).toBe(true)
    const sentArg = email.send.mock.calls[0][0]
    const user = db.raw.prepare('SELECT email FROM users WHERE id = ?').get(userId)
    expect(sentArg.text).toContain('[malgnai-hub 자동발송]')
    expect(sentArg.text.split(user.email).length - 1).toBe(2) // 배너 + 푸터, 양쪽 모두
    expect(sentArg.html).toContain('[malgnai-hub 자동발송]')
    expect(sentArg.html.split(user.email).length - 1).toBe(2)
  })
})

describe('sendEmail — T-G 32(골든 스냅샷, 배너·푸터 포함 전문)', () => {
  it('32. §14.4-6 종합 예시 입력 → html 전문(컨테이너+배너+렌더+푸터)이 고정된 스냅샷과 일치한다', async () => {
    const db = makeSqliteDb()
    const userId = insertUserWithEmail(db, 'dev@malgnsoft.com')
    const email = makeEmailBinding()
    const env = baseEnv({ db, email })
    const text = `## 9월 정기점검 안내

점검은 **9/20(토) 02:00~04:00**에 진행합니다. 대상은 아래와 같습니다.

- 사내 포털
- *일부* 배치 작업
- 로그 수집기(\`otel-collector\`)

자세한 내용은 [점검 공지](https://portal.malgnsoft.com/notice/12)를 확인하세요.

1. 02:00 서비스 중단
2. 04:00 정상화`

    const out = await sendEmail(env, args({ userId, text, format: 'markdown', subject: '9월 정기점검' }))
    expect(out.ok).toBe(true)
    const html = email.send.mock.calls[0][0].html

    const attribution = '이 메일은 맑은소프트 malgnai-hub에서 dev@malgnsoft.com 이(가) 발송했습니다.'
    const expected = [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Helvetica Neue\',sans-serif;font-size:14px;line-height:1.6;color:#222;word-break:break-word">',
      `<div style="background:#eef3fb;border-left:4px solid #1a5fb4;padding:10px 12px;margin:0 0 16px;font-size:13px;color:#333">[malgnai-hub 자동발송] ${attribution}</div>`,
      // ⚠️ §14.4-6 예시는 "## 제목"을 <h2>로 보이지만, §14.2-1·§14.4-4 블록 규칙표는 둘 다
      // "#→h2 / ##→h3 / ###→h4"로 일관되게 규정한다. 규칙표(두 곳 독립 일치)를 정본으로 채택했다
      // — server/lib/markdown.test.js의 동일 주석 참고, PM/설계자에게 별도 보고 대상.
      '<h3 style="font-size:16px;font-weight:600;margin:16px 0 8px">9월 정기점검 안내</h3>',
      '<p style="margin:0 0 12px">점검은 <strong>9/20(토) 02:00~04:00</strong>에 진행합니다. 대상은 아래와 같습니다.</p>',
      '<ul style="margin:0 0 12px;padding-left:20px">\n' +
        '<li style="margin:2px 0">사내 포털</li>\n' +
        '<li style="margin:2px 0"><em>일부</em> 배치 작업</li>\n' +
        '<li style="margin:2px 0">로그 수집기(<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px">otel-collector</code>)</li>\n' +
        '</ul>',
      '<p style="margin:0 0 12px">자세한 내용은 <a href="https://portal.malgnsoft.com/notice/12" rel="noopener noreferrer" style="color:#1a5fb4;text-decoration:underline">점검 공지</a> <span style="color:#666;font-size:12px">&lt;https://portal.malgnsoft.com/notice/12&gt;</span>를 확인하세요.</p>',
      '<ol start="1" style="margin:0 0 12px;padding-left:22px">\n' +
        '<li style="margin:2px 0">02:00 서비스 중단</li>\n' +
        '<li style="margin:2px 0">04:00 정상화</li>\n' +
        '</ol>',
      `<div style="margin:16px 0 0;padding-top:10px;border-top:1px solid #ddd;font-size:12px;color:#666">${attribution}</div>`,
      '</div>'
    ].join('\n')

    expect(html).toBe(expected)
  })
})
