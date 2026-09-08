#!/usr/bin/env node
// 사용량 화면(/usage) KST day-boundary 전환 배포전 런타임 검증 — 재실행 가능 스크립트.
//
// 배경: docs/design/usage-kst-day-boundary.md (하루 경계 UTC→KST 전환). 이 스크립트는
// (1) 프런트 기본 조회기간(from/to)이 KST 달력일 기준으로 정확한지,
// (2) KST 00~09시(구현 이전엔 UTC 날짜가 아직 전날이라 "오늘"이 하루 밀리던 구간)에도
//     하루 밀림이 재현되지 않는지,
// (3) 상류(Grafana) 데이터가 없어 생기는 "데이터 없음" 상태와 화면이 실제로 깨지는 상태를
//     스크린샷으로 구분해 남긴다.
//
// 왜 프로젝트 루트의 playwright.config.js/e2e 대신 tests/에 두었나:
//   루트 playwright.config.js는 BASE_URL 기본값이 legacy 앱 포트(9000, 이 프로젝트가 아닌
//   구 malgnai 저장소)이고 참조하는 e2e/auth.setup.js·"전역 shot 인증"이 이 배포 환경에
//   존재하지 않는 미사용 템플릿이다(@playwright/test도 devDependencies에 없음). 그 스캐폴드를
//   그대로 신뢰하면 엉뚱한 서버를 검증하게 되므로, 이 저장소의 실제 dev 서버 포트
//   (wrangler.jsonc dev.port, 기본 8004)를 향하는 plain playwright 스크립트로 별도 작성했다.
//
// 사전 준비(1회, 실행 전 수동):
//   1) 로컬 wrangler dev가 8004 포트로 떠 있어야 한다(`pnpm dev`, 또는 이미 떠 있으면 재사용).
//   2) 실계정 비번을 흔들지 않기 위해 임시 QA 유저를 로컬 D1(sqlite)에 직접 만든다:
//        node --input-type=module -e "
//          import { hashPassword } from './server/lib/tokens.js'
//          console.log(await hashPassword('<임시비번>'))"
//      위 출력(pbkdf2$...)을 아래 INSERT의 password_hash에 넣어 로컬 D1 sqlite
//      (.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite)에 실행:
//        INSERT INTO users (id,email,name,password_hash,role,status,created_at,updated_at)
//        VALUES ('qa-verify-kst-01','qa-verify-kst@malgnai.local','QA Verify KST',
//                '<위 해시>','administrator','active',datetime('now'),datetime('now'));
//      "데이터 없음 vs 깨짐" gap 시나리오까지 보려면 employee_id도 임의값으로 채운다
//      (UPDATE users SET employee_id='qa-verify-kst' WHERE id='qa-verify-kst-01').
//   3) 검증이 끝나면 반드시 DELETE FROM users WHERE id='qa-verify-kst-01' 로 정리한다.
//
// 실행(Playwright는 전역 공유 캐시를 쓰므로 ~/.claude/tools/ 등 playwright가 설치된
// 디렉터리에서 실행해야 모듈 해석이 된다 — 프로젝트 자체엔 playwright 의존성이 없다):
//   cp tests/verify-usage-kst-day-boundary.mjs ~/.claude/tools/
//   TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
//     -d '{"email":"qa-verify-kst@malgnai.local","password":"<임시비번>"}' | jq -r .token)
//   cd ~/.claude/tools && QA_TOKEN="$TOKEN" BASE_URL=http://127.0.0.1:8004 \
//     SHOT_DIR=/path/to/output node verify-usage-kst-day-boundary.mjs
//
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8004'
const TOKEN = process.env.QA_TOKEN
const SHOT_DIR = process.env.SHOT_DIR || '.'
if (!TOKEN) {
  console.error('QA_TOKEN env not set (임시 QA 유저로 로그인해 얻은 JWT)')
  process.exit(1)
}

async function run(label, { timezoneId, fixedUtcIso } = {}) {
  const browser = await chromium.launch()
  const context = await browser.newContext({ timezoneId })
  const page = await context.newPage()

  // 주의: fixedUtcIso를 실제 "지금"보다 너무 미래로 잡으면 로그인 시 발급된 JWT의 exp(iat+4h)를
  // 넘겨버려 프런트가 토큰을 만료로 판단하고 /login으로 리다이렉트한다 — 이는 KST 버그와 무관한
  // 아티팩트다. KST 00~09시 재현은 "미래로 보내기"가 아니라 "UTC 달력일은 아직 어제인 시각으로
  // 이동"으로 한다(예: 오늘 05:00 KST = 어제 20:00 UTC).
  if (fixedUtcIso) {
    await page.clock.install({ time: new Date(fixedUtcIso) })
  }

  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

  await page.goto(BASE + '/')
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN)
  await page.goto(BASE + '/usage', { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 10000 })

  const redirectedToLogin = page.url().includes('/login')

  const browserToday = await page.evaluate(() => {
    const d = new Date()
    const pad = (v) => String(v).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })

  const dateInputCount = await page.locator('input[type=date]').count()
  const fromVal = dateInputCount ? await page.locator('input[type=date]').nth(0).inputValue() : null
  const toVal = dateInputCount ? await page.locator('input[type=date]').nth(1).inputValue() : null
  const alertTexts = await page.locator('.alert').allInnerTexts()

  const shotPath = `${SHOT_DIR}/usage-${label}.png`
  await page.screenshot({ path: shotPath, fullPage: true })

  const result = { label, redirectedToLogin, browserToday, fromVal, toVal, alertTexts, consoleErrors, shotPath }
  console.log(JSON.stringify(result, null, 2))
  await browser.close()
  return result
}

const results = []
results.push(await run('kst-normal', { timezoneId: 'Asia/Seoul' }))
// 오늘 05:00 KST = 어제 20:00 UTC — "KST 달력일은 이미 오늘인데 UTC 달력일은 아직 어제"인
// 하루 밀림 재현 지점. fixedUtcIso는 실행 시점 기준으로 동적으로 계산한다.
const now = new Date()
const kst0500Today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), -9 + 5, 0, 0))
results.push(await run('kst-early-morning', { timezoneId: 'Asia/Seoul', fixedUtcIso: kst0500Today.toISOString() }))

const bugFree = results[0].browserToday === results[1].browserToday && !results.some((r) => r.redirectedToLogin)
console.log('\n=== RESULT ===')
console.log('day-shift 재현 여부:', bugFree ? '재현 안 됨(정상)' : '재현됨(버그 의심) 또는 토큰 만료 리다이렉트 — 상세 로그 확인')
