// email_send MCP 도구의 발송 로직 전부 — 검증·정규화·수신자 도메인 게이트·이스케이프·푸터·
// 감사 INSERT·레이트리밋·env.EMAIL.send() 호출. 단일 진입점 sendEmail()만 export한다
// (docs/design/email-send-tool.md §9.2 — 게이트가 이 함수 안에 있어야 새 호출 경로가 생겨도
// 우회가 불가능하다). mcp/agent.js는 이 함수를 얇게 호출만 한다.
//
// 설계 정본: docs/design/email-send-tool.md. 아래 각 절 번호는 그 문서를 가리킨다.
import * as usersDao from '../dao/users.js'
import { buildRecordStatement } from '../dao/audit-logs.js'
import { sha256Hex } from './tokens.js'
import { parseIdempotencyKey } from './idempotency.js'
import { renderMarkdownSubset, escapeHtml as escapeHtmlMd, RENDERER_VERSION } from './markdown.js'

// ---------------------------------------------------------------------------
// 상수 (§5.1·§6.4-4·§9.1)
// ---------------------------------------------------------------------------

// 🔴 발신 주소 — wrangler.jsonc의 send_email.allowed_sender_addresses와 반드시 같은 문자열이어야
// 한다(한쪽만 바꾸면 E_VALIDATION_ERROR로 전건 실패). 같이 바꿀 파일: wrangler.jsonc / 이 상수 /
// docs/design/email-send-tool.md §2.3.
export const FROM_ADDRESS = 'malgnai@apiserver.kr'
// 표시명은 권위를 참칭하지 않는 서버 상수로 고정한다 — 사용자 입력을 받지 않는다(§2.6-1).
const FROM_DISPLAY_NAME = '맑은소프트 malgnai-hub (자동발송)'

// 🔴 보안 경계다. 넓히려면 커밋·리뷰를 거쳐야 하므로 vars/환경변수가 아니라 코드 상수로 둔다
//    (환경변수면 대시보드에서 배포 없이 조용히 넓힐 수 있다). 이 값을 바꾸면 같이 바꿀 것:
//    mcp/agent.js의 email_send description / docs/mcp-tools.md §4.16 /
//    docs/design/email-send-tool.md D9·§6.4.
const ALLOWED_RECIPIENT_DOMAINS = Object.freeze(new Set(['malgnsoft.com']))

const MAX_RECIPIENTS = 5
const MAX_ADDR_LEN = 254
const MAX_LOCAL_LEN = 64
const MAX_SUBJECT_LEN = 200
const MAX_TEXT_LEN = 10000
const MAX_TEXT_BYTES = 40960
const DAILY_LIMIT = 50
const SEND_TIMEOUT_MS = 15000

// 헤더로 들어가는 모든 값(subject, to[i])에 적용한다. text(본문)에는 적용하지 않는다 — 개행은
// 본문의 정상 내용이다(§6.3). CRLF + NUL + 유니코드 줄바꿈(LINE SEPARATOR/PARAGRAPH SEPARATOR)을
// 막는다. ⚠️ 정규식/문자열 리터럴에 NUL 이스케이프 표기를 직접 적지 않는다 — 이 저장소의
// 파일 저장 경로가 그 시퀀스를 실제 NUL 바이트로 되살려 파일을 binary로 만드는 사고가 있었다
// (docs/design/email-send-tool.md 작성 중 실측). 그래서 코드 포인트 숫자 배열로 판정한다.
const HEADER_UNSAFE_CODEPOINTS = new Set([0x0d, 0x0a, 0, 0x2028, 0x2029]) // \r \n NUL LS PS
function hasHeaderUnsafeChar(s) {
  for (let i = 0; i < s.length; i++) {
    if (HEADER_UNSAFE_CODEPOINTS.has(s.codePointAt(i))) return true
  }
  return false
}

// 표시명 형식(§6.4-1 B3) — "홍길동" <a@malgnsoft.com> 같은 입력을 거부한다. 주소만 받는다.
const DISPLAY_NAME_UNSAFE_RE = /[<>"(),;:`[\]]/

// ASCII 가시문자만(§6.4-1 B4) — 유니코드 혼동문자·전각문자·내부 공백·제어문자를 이 한 줄로 전부 막는다.
const ASCII_VISIBLE_RE = /^[\x21-\x7E]+$/

// §6.3 — 실용 정규식(완전한 RFC 5322 파서 아님). 최종 판정은 Cloudflare가 한다.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

// ---------------------------------------------------------------------------
// 에러 헬퍼 — §6.4-4: errorResult(err)가 err.message만 직렬화하므로, e.name/e.code와 함께
// e.message를 반드시 "<CODE>: <설명>" 형식으로 만든다(§8.3의 모든 코드에 동일 적용).
// ---------------------------------------------------------------------------
function makeError(name, code, detail) {
  const e = new Error(`${code}: ${detail}`)
  e.name = name
  e.code = code
  return e
}
const validationError = (detail) => makeError('ValidationError', 'VALIDATION_ERROR', detail)
const recipientDomainError = (rejected) =>
  makeError(
    'RecipientDomainNotAllowedError',
    'RECIPIENT_DOMAIN_NOT_ALLOWED',
    `수신자는 @malgnsoft.com 주소만 허용됩니다. 거부된 수신자: ${rejected.join(', ')}`
  )
const forbiddenError = (detail) => makeError('ForbiddenError', 'FORBIDDEN', detail)
const rateLimitedError = (detail) => makeError('RateLimitedError', 'RATE_LIMITED', detail)
const rateLimitUnavailableError = (detail) => makeError('RateLimitUnavailableError', 'RATE_LIMIT_UNAVAILABLE', detail)
const configError = (detail) => makeError('ConfigError', 'CONFIG_ERROR', detail)
const auditWriteFailedError = (detail) => makeError('AuditWriteFailedError', 'AUDIT_WRITE_FAILED', detail)
// F-6(reviewer M-7) — 같은 idempotencyKey에 다른 본문(수신자/제목/본문해시)이 오면 조용한
// 멱등이 아니라 명시적 충돌로 거부한다.
const idempotencyConflictError = (detail) => makeError('IdempotencyConflictError', 'IDEMPOTENCY_KEY_CONFLICT', detail)
const sendFailedError = (err) =>
  makeError('SendFailedError', 'SEND_FAILED', `${err && err.code ? err.code : 'unknown'}: ${(err && err.message) || String(err)}`)

// ---------------------------------------------------------------------------
// §4.5 — 기존 checkRateLimit()(auth-google.js/plugin-deploys.js, 둘 다 fail-open)을 고치지 않고
// 전용 함수를 새로 둔다. 이 함수는 **fail-closed**다: .limit()이 throw하면 통과가 아니라 거부.
// 바인딩 자체의 존재 여부는 sendEmail()의 1단계(§9.3)에서 먼저 확인하므로 여기서는 다루지 않는다.
// ---------------------------------------------------------------------------
export async function checkEmailRateLimit(rl, userId) {
  try {
    const { success } = await rl.limit({ key: `email-send:${userId}` })
    return success
  } catch (err) {
    // fail-open인 기존 checkRateLimit()과 의도적으로 다르다(§4.4) — 이메일은 안 나가도 서비스가
    // 죽지 않으므로, 레이트리밋 상태를 신뢰할 수 없을 때는 거부하는 편이 남용 리스크가 낮다.
    console.error('[email] rate limit check failed, rejecting request (fail-closed)', err)
    throw rateLimitUnavailableError('rate limit check unavailable')
  }
}

// ---------------------------------------------------------------------------
// HTML 이스케이프(§6.2) — D6: html을 입력으로 받지 않고 text에서 서버가 결정론적으로 파생한다.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildHtml(textWithFooter) {
  return (
    `<pre style="white-space:pre-wrap;word-break:break-word;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;font-size:14px;margin:0">` +
    escapeHtml(textWithFooter) +
    `</pre>`
  )
}

// ---------------------------------------------------------------------------
// §14.4 — format:'markdown' 경로. plain 경로(buildHtml, 위)는 이 절이 한 글자도 건드리지
// 않는다. 배너·푸터·컨테이너는 renderMarkdownSubset()이 모른다(§14.11) — 여기서 렌더 결과
// 바깥에 조립한다(I-4: 사용자 본문이 서버 블록을 위조·은폐할 수 없다).
// ---------------------------------------------------------------------------
const MD_CONTAINER_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;font-size:14px;line-height:1.6;color:#222;word-break:break-word"
const MD_BANNER_STYLE = 'background:#eef3fb;border-left:4px solid #1a5fb4;padding:10px 12px;margin:0 0 16px;font-size:13px;color:#333'
const MD_FOOTER_STYLE = 'margin:16px 0 0;padding-top:10px;border-top:1px solid #ddd;font-size:12px;color:#666'

/** format:'markdown'의 html 파트를 조립한다. attributionLine은 plain 경로(배너/푸터)와
 *  같은 상수에서 나온 문자열이어야 한다(§14.5 구현 규약 — 문구를 두 번 타이핑하지 말 것).
 *  ⚠️ attributionLine 안의 replyToEmail은 여기서 별도로 escapeHtml()해야 한다 — plain 경로는
 *  banner+text+footer 전체를 한 번에 이스케이프해서 자동으로 커버되지만, markdown 경로는
 *  배너·푸터를 본문과 따로 조립하므로 그 자동 커버가 사라진다(§14.4-6 경고 박스). */
function buildMarkdownHtml(text, attributionLine) {
  const { html: rendered, linkCount, linkHosts } = renderMarkdownSubset(text)
  const attributionHtml = escapeHtmlMd(attributionLine)
  const bannerHtml = `<div style="${MD_BANNER_STYLE}">[malgnai-hub 자동발송] ${attributionHtml}</div>`
  const footerHtml = `<div style="${MD_FOOTER_STYLE}">${attributionHtml}</div>`
  const html = `<div style="${MD_CONTAINER_STYLE}">\n${bannerHtml}\n${rendered}\n${footerHtml}\n</div>`
  return { html, linkCount, linkHosts }
}

// ---------------------------------------------------------------------------
// §6.4-1 — 수신자 1개 판정 절차(A~F). 문법(B) 실패는 즉시 VALIDATION_ERROR로 전체 호출을
// 중단한다(부분발송 개념이 없다 — 애초에 요청이 잘못됐다). 도메인(D) 실패는 이 함수에서 던지지
// 않고 호출부가 전 원소를 다 검사한 뒤 한꺼번에 판단한다(§6.4-1 E — 전부-or-전무).
// ---------------------------------------------------------------------------
function validateRecipientSyntax(raw) {
  if (typeof raw !== 'string') throw validationError('recipient must be a string')
  const trimmed = raw.trim() // B2 — 선행/후행 공백만 제거(정상 입력으로 본다)
  if (!trimmed) throw validationError('recipient must not be empty')
  if (DISPLAY_NAME_UNSAFE_RE.test(trimmed)) throw validationError('recipient must be a bare address, not a display-name form')
  if (!ASCII_VISIBLE_RE.test(trimmed)) throw validationError('recipient must contain ASCII visible characters only')
  const parts = trimmed.split('@')
  if (parts.length !== 2) throw validationError('recipient must contain exactly one @')
  const [local, domain] = parts
  if (trimmed.length > MAX_ADDR_LEN) throw validationError(`recipient must be <= ${MAX_ADDR_LEN} chars`)
  if (local.length > MAX_LOCAL_LEN) throw validationError(`recipient local part must be <= ${MAX_LOCAL_LEN} chars`)
  if (!EMAIL_RE.test(trimmed)) throw validationError('recipient is not a syntactically valid email address')
  if (hasHeaderUnsafeChar(trimmed)) throw validationError('recipient contains unsafe control characters')
  return { local, domain }
}

/** §6.4-1 전체 절차 A~F. 반환: 정규화된 수신자 주소 배열(중복 제거, 도메인 소문자화). 도메인
 *  위반이 하나라도 있으면 부분발송 없이 RECIPIENT_DOMAIN_NOT_ALLOWED로 전체 거부한다(§6.4-1 E). */
function resolveRecipients(rawTo, { userId, deviceId } = {}) {
  const items = Array.isArray(rawTo) ? rawTo : [rawTo] // A — 배열화
  if (items.length < 1 || items.length > MAX_RECIPIENTS) {
    throw validationError(`to must have 1..${MAX_RECIPIENTS} recipients`)
  }

  const accepted = []
  const rejected = [] // { addr, domain } — D 위반만 여기 모인다
  for (const raw of items) {
    const { local, domain } = validateRecipientSyntax(raw) // B1~B6 — 실패 시 즉시 throw
    const domainLower = domain.toLowerCase() // C — 도메인만 소문자화, 로컬파트는 보존
    const addr = `${local}@${domainLower}`
    // D — 완전일치(===) 비교만. endsWith/includes/startsWith/앵커 없는 정규식/slice(-2) 절대 금지
    // (evil@malgnsoft.com.attacker.kr, evil@evilmalgnsoft.com, x@sub.malgnsoft.com을 통과시킨다).
    if (ALLOWED_RECIPIENT_DOMAINS.has(domainLower)) {
      accepted.push(addr)
    } else {
      rejected.push({ addr, domain: domainLower })
    }
  }

  if (rejected.length > 0) {
    // 관측만 하고 감사 행은 남기지 않는다(§6.4-5) — 도메인만 남기고 주소 전체는 남기지 않는다.
    console.warn({
      evt: 'email.recipient_domain_blocked',
      userId,
      deviceId: deviceId || null,
      rejectedDomains: [...new Set(rejected.map((r) => r.domain))],
      toCount: items.length
    })
    throw recipientDomainError(rejected.map((r) => r.addr))
  }

  const unique = [...new Set(accepted)] // F — 정규화 결과 기준 중복 제거
  if (unique.length === 0) throw validationError('recipients resolved to an empty set')
  return unique
}

function validateSubject(subject) {
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > MAX_SUBJECT_LEN) {
    throw validationError(`subject must be 1..${MAX_SUBJECT_LEN} chars`)
  }
  if (hasHeaderUnsafeChar(subject)) throw validationError('subject contains unsafe control characters')
  return subject
}

function validateText(text) {
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT_LEN) {
    throw validationError(`text must be 1..${MAX_TEXT_LEN} chars`)
  }
  // §5.3 — 문자 길이(UTF-16 코드유닛)와 UTF-8 바이트를 둘 다 검사한다. 한글/이모지는 3~4바이트라
  // 길이만 보면 실제 페이로드가 커질 수 있다.
  const bodyBytes = new TextEncoder().encode(text).byteLength
  if (bodyBytes > MAX_TEXT_BYTES) throw validationError(`text must be <= ${MAX_TEXT_BYTES} UTF-8 bytes`)
  return bodyBytes
}

// §9.3 9번 — env.EMAIL.send()는 AbortSignal을 지원하지 않는다. 취소가 아니라 "대기 포기"로
// 처리한다(§10 E-3). server/lib/prom-client.js의 withRouteBudget과 동일 패턴(Promise.race +
// finally에서 clearTimeout). export하는 이유는 오직 테스트(email.test.js)가 sendEmail() 전체
// (crypto.subtle·D1 등 다른 실비동기 계층)를 거치지 않고 이 타임아웃 메커니즘만 fake timer로
// 빠르게 검증하기 위함이다 — sendEmail()의 공개 계약(단일 진입점)에는 영향이 없다.
export async function raceTimeout(promise, ms) {
  let timer
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('send timeout')
      e.isTimeout = true
      reject(e)
    }, ms)
  })
  try {
    return await Promise.race([promise, budget])
  } finally {
    clearTimeout(timer)
  }
}

/** email_send MCP 도구의 단일 진입점(§9.2·§9.3). REST 라우트는 만들지 않지만(D7), 나중에 생기면
 *  이 함수를 그대로 재사용한다(§7 뒤집기 조건) — 그래서 이 함수는 MCP 전용 개념(this.props 등)에
 *  의존하지 않고 순수 인자만 받는다.
 *
 *  projectId는 이미 호출부(mcp/agent.js)가 resolveProjectById()로 본인 소유를 확인한 뒤 넘기는
 *  값(또는 null)이다 — 이 함수 안에서 다시 소유권을 확인하지 않는다(§8.2 기존 agent_learning_record
 *  패턴과 동일 분업).
 *
 *  타임아웃(E-3)만 예외적으로 throw하지 않고 { ok:false, status:'unknown', ... }를 반환한다(§8.3
 *  "타임아웃" 출력 예시 — 재시도 가능함을 알리는 정상 응답이지 MCP 에러가 아니다). 그 외 실패는
 *  전부 throw하고 mcp/agent.js의 errorResult(e)가 e.message를 그대로 직렬화한다. */
export async function sendEmail(env, { userId, deviceId, to, subject, text, format, projectId, idempotencyKey }) {
  // 1) 바인딩 존재 확인(§9.3 1단계, §4.4 fail-closed) — 로컬/미배포 환경에서 이 도구가 아예
  //    동작하지 않는 것이 바람직한 성질이다(개발 중 실수로 진짜 수신자에게 보내는 경로를 열지 않음).
  if (!env.EMAIL) throw configError('EMAIL binding is not configured')
  if (!env.EMAIL_SEND_RL) throw configError('EMAIL_SEND_RL binding is not configured')

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    throw validationError('idempotencyKey must be 1..200 chars')
  }

  // 2) L1 레이트리밋(userId 키, fail-closed, §4.2·§4.4·§4.5)
  const rlOk = await checkEmailRateLimit(env.EMAIL_SEND_RL, userId)
  if (!rlOk) throw rateLimitedError('rate limit exceeded (5 per 60s)')

  // 3) 사용자 조회 — status!=='active'는 FORBIDDEN(§10.3, E-8 국소 방어. deviceAuthMiddleware
  //    자체는 고치지 않는다). replyTo/푸터에 쓸 user.email을 이 한 번의 조회로 함께 얻는다.
  const user = await usersDao.findById(env.DB, userId)
  if (!user || user.status !== 'active') throw forbiddenError('user is not active')
  const replyToEmail = user.email
  // F-7(security Low) — 헤더로 들어가는 값은 예외 없이 CRLF/NUL 검사를 거친다(§6.3 원칙에
  // "모든 값"이라 적었으면서 replyTo만 빠져 있었다). 이 값은 이번 요청에서 사용자가 직접
  // 입력하지 않고 관리자가 등록한 users.email에서 오지만, 헤더에 그대로 실리는 이상 출처가
  // 상대적으로 신뢰돼도 예외를 두지 않는다.
  if (hasHeaderUnsafeChar(replyToEmail)) {
    throw configError('replyTo (user email) contains unsafe control characters — fix the user record before sending')
  }

  // 4) 입력 검증(§5·§6) — subject/text 상한과 CRLF, to 문법·상한
  const subjectValidated = validateSubject(subject)
  const bodyBytes = validateText(text)

  // 4a) format(§14.7) — 게이트는 이 단일 진입점 안에 있어야 한다는 원칙 그대로, zod(1차)에
  //     이어 여기서 2차 검증한다. 기본값은 'plain'(호출자가 명시하지 않으면 서식이 조용히
  //     생기지 않는다 — §14.7-2 선택 이유 1).
  const bodyFormat = format === undefined || format === null ? 'plain' : format
  if (bodyFormat !== 'plain' && bodyFormat !== 'markdown') {
    throw validationError("format must be 'plain' or 'markdown'")
  }

  // 4b·4c) 🔴 수신자 도메인 게이트(D9·§6.4) + 중복 제거. 여기서 막히면 감사 행도 남지 않고
  //        idempotencyKey도 소모되지 않는다(§6.4-5) — 사용자가 주소를 고쳐 같은 키로 재호출 가능.
  const recipients = resolveRecipients(to, { userId, deviceId })

  // 5) projectId는 호출부가 이미 resolveProjectById()로 검증했다 — 여기서는 그대로 받는다.

  // 6) L2 일일 볼륨 상한(사용자당 24시간 50건, §4.3) — idx_audit_actor로 커버, 추가 인덱스 불필요.
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const countRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE actor_user_id = ? AND action = 'email.send' AND created_at > ?`)
    .bind(userId, cutoffIso)
    .first()
  if ((countRow ? countRow.n : 0) >= DAILY_LIMIT) {
    throw rateLimitedError(`daily limit (${DAILY_LIMIT}) reached; resets 24h after your earliest send in the window`)
  }

  // 7) 본문 조립 — bodyHash는 푸터를 붙이기 전의 사용자 원문 text 기준(§3.2 — 감사 대상은 "사용자가
  //    무엇을 썼는가"이지 서버가 결정론적으로 붙이는 상수 푸터가 아니다).
  const bodyHash = await sha256Hex(text)
  // F-2(security H-2) — 귀속 표시를 본문 앞뒤 모두에 둔다. 사용자가 본문 안에 렌더링상 구분
  // 불가능한 가짜 푸터(같은 구분선 + 타인 주소)를 흉내내고 개행 다수로 진짜 푸터를 화면 밖으로
  // 밀어내도, 서버가 붙이는 배너는 항상 사용자 입력보다 앞서 있어 첫 화면에서 반드시 보인다
  // (설계 §2.6 — 사내 피싱의 필수 완화책). bodyHash는 여전히 배너·푸터를 붙이기 전의 사용자
  // 원문 text 기준을 유지한다(서버가 붙이는 상수는 해시 대상이 아니다).
  const attributionLine = `이 메일은 맑은소프트 malgnai-hub에서 ${replyToEmail} 이(가) 발송했습니다.`
  const banner = `[malgnai-hub 자동발송] ${attributionLine}\n\n`
  const footer = `\n\n─\n${attributionLine}`
  const textWithFooter = banner + text + footer
  // format:'plain'은 현행 그대로(§14.4-1 — 한 글자도 바꾸지 않는다). format:'markdown'만
  // renderMarkdownSubset()을 거친다 — 자원 상한(§14.8) 초과 시 여기서 VALIDATION_ERROR가 던져져
  // 감사 INSERT(8번, 아래)에 도달하지 않는다(§14.11 체크리스트 19 — 순서 유지).
  let html
  let mdLinkCount
  let mdLinkHosts
  if (bodyFormat === 'markdown') {
    const built = buildMarkdownHtml(text, attributionLine)
    html = built.html
    mdLinkCount = built.linkCount
    mdLinkHosts = built.linkHosts
  } else {
    html = buildHtml(textWithFooter)
  }
  const { sessionId } = parseIdempotencyKey(idempotencyKey)

  const metadata = {
    op: 'attempt',
    idempotencyKey,
    from: FROM_ADDRESS,
    replyTo: replyToEmail,
    to: recipients,
    toCount: recipients.length,
    subject: subjectValidated,
    bodyHash,
    bodyBytes,
    bodyFormat,
    footerApplied: true,
    deviceId: deviceId || null,
    sessionId
  }
  if (projectId) metadata.projectId = projectId
  // §14.6-1 — renderer/linkCount/linkHosts는 bodyFormat==='markdown'일 때만 싣는다.
  if (bodyFormat === 'markdown') {
    metadata.renderer = RENDERER_VERSION
    metadata.linkCount = mdLinkCount
    metadata.linkHosts = mdLinkHosts
  }

  // 8) 🔴 감사 INSERT — 발송(9)보다 반드시 먼저, 실패하면 발송에 도달할 수 없다(fail-closed,
  //    §3.7). .catch(()=>{})로 흘리지 않는다. UNIQUE 위반(멱등 재호출)만 별도 분기하고, 그 외
  //    모든 예외는 AUDIT_WRITE_FAILED로 발송을 중단시킨다.
  const { id: auditId, stmt } = buildRecordStatement(env.DB, {
    actorUserId: userId,
    action: 'email.send',
    targetType: 'email',
    targetId: recipients[0], // idx_audit_target이 "이 주소로 누가 언제 보냈나"를 커버(§3.2)
    metadata
  })
  try {
    await stmt.run()
  } catch (e) {
    // F-5(reviewer M-6) — D1이 실제로 뱉는 UNIQUE 위반 메시지 형식은 미검증이고, node:sqlite의
    // 'UNIQUE constraint failed' 문자열 매칭만으로 판정하면 D1에서 문구가 다를 때 정당한 멱등
    // 재호출이 AUDIT_WRITE_FAILED로 떨어져 호출자가 새 idempotencyKey로 재시도해 중복 발송이
    // 날 수 있다. 그래서 에러 메시지 문자열에 의존하지 않고, INSERT가 실패하면 원인과 무관하게
    // 항상 (actor_user_id, idempotencyKey)로 기존 행을 먼저 조회한다 — 있으면 멱등 재호출,
    // 없으면 (UNIQUE든 다른 원인이든) 안전한 방향인 AUDIT_WRITE_FAILED로 떨어진다(fail-closed는
    // 그대로 유지하고 판정 폭만 넓어졌다).
    let existing
    try {
      existing = await env.DB
        .prepare(
          `SELECT id, created_at, metadata_json FROM audit_logs WHERE actor_user_id = ? AND action = 'email.send' AND json_extract(metadata_json, '$.idempotencyKey') = ?`
        )
        .bind(userId, idempotencyKey)
        .first()
    } catch (e2) {
      throw auditWriteFailedError((e && e.message) || 'audit log insert failed')
    }
    if (!existing) {
      // UNIQUE 위반처럼 보였는데 행이 없거나(이론상 도달 불가), 다른 원인의 삽입 실패다.
      throw auditWriteFailedError((e && e.message) || 'audit log insert failed')
    }

    // F-6(reviewer M-7) — 같은 키라도 본문(수신자/제목/본문해시)이 다르면 조용한 멱등이 아니라
    // 명시적 충돌로 거부한다. 그대로 두면 에이전트가 고정 키를 쓸 때 두 번째 메일부터 영원히
    // 안 나가면서 매번 "성공"처럼 보이는 응답이 온다.
    let existingMeta = {}
    try {
      existingMeta = JSON.parse(existing.metadata_json || '{}')
    } catch (e3) {
      existingMeta = {}
    }
    const contentChanged =
      existingMeta.bodyHash !== bodyHash ||
      existingMeta.subject !== subjectValidated ||
      JSON.stringify(existingMeta.to || []) !== JSON.stringify(recipients) ||
      // §14.6-1 — 기존 행(마이그레이션 이전)은 bodyFormat이 없을 수 있으므로 'plain'으로 읽는다.
      (existingMeta.bodyFormat || 'plain') !== bodyFormat
    if (contentChanged) {
      throw idempotencyConflictError(
        `idempotencyKey reused with different content (to/subject/body) — use a new idempotencyKey: ${idempotencyKey}`
      )
    }

    // F-1(security H-1 = reviewer C-1) — "시도" 행의 존재만으로 발송 성공을 단언하지 않는다.
    // 이 감사 행은 §3.6대로 "보내려고 시도했다"만 의미하고, 1회차 호출이 발송 전에(예: M-1
    // 도메인 온보딩 미완 — 배포 첫날의 기본 상태) 이미 실패했을 수 있다. "보내지 않았는데
    // 보냈다고 말하지 않는다"가 유일한 불변식이라 여기서 ok:true 성공 단언을 걷어내고 상태를
    // 모른다고 정직하게 답한다. 감사행에 발송 결과를 기록하는 구조 개선(op:'attempt'→'sent'
    // 갱신)은 배포 직전에 감사 경로로 새 쓰기를 추가하는 별도 Sensitive 변경이라 이번 라운드
    // 에서는 하지 않는다 — 후속 라운드로 미룬다(패널 합의, §3.6은 그대로 유지).
    console.warn({ evt: 'email.dedup_replay', auditId: existing.id, userId, deviceId: deviceId || null })
    return {
      ok: false,
      status: 'unknown',
      deduplicated: true,
      auditId: existing.id,
      sentAt: existing.created_at,
      message:
        '이전 시도의 발송 결과가 확인되지 않았습니다(이 감사 행은 "발송을 시도했다"만 의미하며 실제 배달을 보장하지 않습니다). ' +
        "Cloudflare Email Sending 로그에서 X-Malgnai-Hub-Audit-Id로 실제 발송 여부를 확인하세요. 내용을 바꿔 다시 보내려면 새 idempotencyKey를 쓰세요."
    }
  }

  // 9) 발송 — Promise.race로 15초 대기 포기(취소가 아니다, §10 E-3). 타임아웃은 예외가 아니라
  //    ok:false 응답으로 반환한다(§8.3) — 이미 감사 INSERT는 끝났으므로 재시도는 같은
  //    idempotencyKey로 하면 UNIQUE가 중복 발송을 막는다.
  let result
  try {
    result = await raceTimeout(
      env.EMAIL.send({
        to: recipients,
        from: { email: FROM_ADDRESS, name: FROM_DISPLAY_NAME },
        replyTo: replyToEmail,
        subject: subjectValidated,
        text: textWithFooter,
        html,
        headers: { 'X-Malgnai-Hub-Audit-Id': auditId }
      }),
      SEND_TIMEOUT_MS
    )
  } catch (e) {
    if (e && e.isTimeout) {
      console.error({ evt: 'email.send_timeout', auditId, status: 'unknown' })
      return {
        ok: false,
        status: 'unknown',
        auditId,
        message:
          '발송 결과를 확인하지 못했습니다(15초 초과). 실제로 발송됐을 수 있습니다. 같은 idempotencyKey로 다시 호출해도 재발송되지 않습니다 — ' +
          "그 호출은 이전 시도의 상태를 그대로 돌려줍니다(ok:false, status:'unknown'). 실제 발송 여부는 Cloudflare Email Sending 로그로 확인하세요."
      }
    }
    console.error({ evt: 'email.send_failed', auditId, code: e && e.code, message: e && e.message })
    throw sendFailedError(e)
  }

  // 10) 결과 로깅 + 11) 반환
  const sentAt = new Date().toISOString()
  console.log({ evt: 'email.sent', auditId, messageId: result && result.messageId, toCount: recipients.length })
  return { ok: true, auditId, messageId: result && result.messageId, to: recipients, sentAt }
}
