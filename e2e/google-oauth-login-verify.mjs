#!/usr/bin/env node
// Google 로그인 도입 회귀 검증 스크립트 — docs/design/google-oauth-login.md 기준.
// QA 검증(tests/../docs/qa/google-oauth-login-test-report.md)에서 수행한 화면 검증을
// 그대로 재실행할 수 있도록 만든 단일 스크립트. 로컬 `pnpm dev`(wrangler dev --local,
// 127.0.0.1:8004)가 이미 떠 있어야 한다.
//
// ⚠️ 루트 playwright.config.js(testDir: e2e/, baseURL 기본 9000)는 이 저장소가 아닌 레거시 앱을
// 가리키는 알려진 이슈라 이 스크립트는 그 config를 쓰지 않고 `playwright` 패키지를 직접 구동한다.
//
// 실행: node e2e/google-oauth-login-verify.mjs
// 필요 시 BASE_URL 환경변수로 대상 서버를 바꿀 수 있다(기본 http://localhost:8004).
//
// 검증 항목(각각 PASS/FAIL로 콘솔에 출력, 스크린샷은 docs/screenshots/google-oauth-login/qa-verify/):
//   1) /login 화면에 자체인증 폼(#loginEmail/#loginPw)과 Google 버튼이 병존한다
//   2) 자체인증 제출이 성공해 대시보드로 이동하고, localStorage.token이 보호된 API에서 200을 받는다
//   3) 자체인증 제출 실패(오답 비밀번호)가 에러 메시지를 보여주고 리다이렉트하지 않는다
//   4) 무음 재로그인 루프차단(§4.3 (a)) — mh_g_linked=1인 상태로 /login을 2회 방문해도
//      /api/auth/google/start 요청은 1회만 발생한다(프런트 sessionStorage/localStorage 마커 기반).
//      Google 왕복 자체는 재현 불가(.dev.vars가 더미)이므로 /start 응답만 경량 mock으로 대체하고
//      "요청 횟수"라는 관측 가능한 사실만 검증한다.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE_URL = process.env.BASE_URL || 'http://localhost:8004'
const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots', 'google-oauth-login', 'qa-verify')
mkdirSync(SHOT_DIR, { recursive: true })

const QA_EMAIL = process.env.QA_EMAIL || 'qa-google-oauth-test@malgnsoft.com'
const QA_PASSWORD = process.env.QA_PASSWORD || 'QaOauthTest2026!'

let passCount = 0
let failCount = 0
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (ok) { passCount++; console.log(`PASS - ${name}${detail ? ' :: ' + detail : ''}`) }
  else { failCount++; console.log(`FAIL - ${name}${detail ? ' :: ' + detail : ''}`) }
}

async function main() {
  const browser = await chromium.launch()

  // ---------------------------------------------------------------------
  // 1) 화면 병존 확인 + 2)/3) 자체인증 성공/실패
  // ---------------------------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })

    const emailVisible = await page.locator('#loginEmail').isVisible().catch(() => false)
    const pwVisible = await page.locator('#loginPw').isVisible().catch(() => false)
    const googleBtnVisible = await page.getByRole('button', { name: /Google로 로그인/ }).isVisible().catch(() => false)
    await page.screenshot({ path: path.join(SHOT_DIR, '01-login-coexist.png') })
    record('1) 자체인증 폼 + Google 버튼 병존', emailVisible && pwVisible && googleBtnVisible,
      `email=${emailVisible} pw=${pwVisible} googleBtn=${googleBtnVisible}`)

    // 3) 실패 케이스 먼저(성공 후 상태가 리다이렉트되므로 순서상 실패를 먼저 검증)
    await page.fill('#loginEmail', QA_EMAIL)
    await page.fill('#loginPw', 'wrong-password-xyz')
    await page.getByRole('button', { name: '로그인', exact: true }).click()
    await page.waitForTimeout(500)
    const errorVisible = await page.locator('.alert-danger').isVisible().catch(() => false)
    const stillOnLogin = page.url().includes('/login')
    await page.screenshot({ path: path.join(SHOT_DIR, '02-selfauth-fail.png') })
    record('3) 자체인증 실패 시 에러 표시 + 화면 유지', errorVisible && stillOnLogin,
      `errorVisible=${errorVisible} url=${page.url()}`)

    // 2) 성공 케이스
    await page.fill('#loginEmail', QA_EMAIL)
    await page.fill('#loginPw', QA_PASSWORD)
    await page.getByRole('button', { name: '로그인', exact: true }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(300)
    const token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null)
    const navigatedAway = !page.url().includes('/login')
    await page.screenshot({ path: path.join(SHOT_DIR, '03-selfauth-success.png') })

    let protectedApiOk = false
    let protectedApiStatus = null
    if (token) {
      const res = await page.request.get(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      protectedApiStatus = res.status()
      protectedApiOk = res.status() === 200
    }
    record('2) 자체인증 성공 — 화면 전환 + localStorage 토큰으로 보호된 API 200',
      navigatedAway && !!token && protectedApiOk,
      `navigatedAway=${navigatedAway} tokenPresent=${!!token} /api/auth/me=${protectedApiStatus}`)

    await context.close()
  }

  // ---------------------------------------------------------------------
  // 4) 무음 재로그인 루프차단 — /login 2회 방문, /start 요청 횟수 관측
  // ---------------------------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()

    let startRequestCount = 0
    // /start 요청을 가로채 실제 Google/서버를 타지 않고 "무음 실패" 콜백 결과만 흉내낸다
    // (.dev.vars가 더미라 실제 Google 왕복은 이 저장소 범위에서 재현 불가 — 정직하게 mock 명시).
    await page.route('**/api/auth/google/start*', async (route) => {
      startRequestCount++
      await route.fulfill({
        status: 302,
        headers: { Location: '/login#ge=silent_unavailable&gs=1' },
        body: '',
      })
    })

    // 최초 진입 — mh_g_linked를 세팅해 두어야 무음 시도 조건(§4.3.1)을 만족한다.
    await page.goto(`${BASE_URL}/login`)
    await page.evaluate(() => localStorage.setItem('mh_g_linked', '1'))

    // 방문 1 — 무음 시도가 발동해야 한다(요청 1회).
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const countAfterVisit1 = startRequestCount
    const silentOffAfterVisit1 = await page.evaluate(() => localStorage.getItem('mh_g_silent_off')).catch(() => null)

    // 방문 2 — 같은 탭에서 재방문. sessionStorage(mh_g_silent_tried) + localStorage(mh_g_silent_off)
    // 둘 다 이미 세워져 있어야 하므로 추가 요청이 발생하면 안 된다.
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const countAfterVisit2 = startRequestCount

    record('4) 무음 재로그인 루프차단 — 2회 방문에도 /start 요청 1회',
      countAfterVisit1 === 1 && countAfterVisit2 === 1,
      `visit1 누적=${countAfterVisit1}, visit2 누적=${countAfterVisit2}, silentOff마커=${silentOffAfterVisit1}`)

    await context.close()
  }

  await browser.close()

  console.log('')
  console.log(`=== 결과: ${passCount} PASS / ${failCount} FAIL (총 ${results.length}) ===`)
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('스크립트 실행 중 예외:', err)
  process.exit(1)
})
