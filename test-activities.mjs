import { chromium } from 'playwright'

async function test() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  
  try {
    // 로그인
    await page.goto('http://127.0.0.1:9000/login', { waitUntil: 'networkidle' })
    await page.fill('input[name="username"]', 'admin')
    await page.fill('input[name="password"]', 'admin')
    await page.click('button[type="submit"]')
    await page.waitForNavigation()
    
    // 활동 페이지
    await page.goto('http://127.0.0.1:9000/activities', { waitUntil: 'networkidle' })
    
    // 탭 확인
    const hasCommandTab = await page.locator('button:has-text("명령 큐")').isVisible()
    const hasLogTab = await page.locator('button:has-text("활동 로그")').isVisible()
    
    console.log('✓ 명령 큐 탭:', hasCommandTab)
    console.log('✓ 활동 로그 탭:', hasLogTab)
    
    // 스크린샷
    await page.screenshot({ path: '/private/tmp/claude-501/-Users-hopegiver-workspace-malgnai/dbffdf86-7b59-4266-b3e3-d5b8a021d2f2/scratchpad/activities-commands.png' })
    
    // 활동 로그 탭으로 이동
    await page.click('button:has-text("활동 로그")')
    await page.waitForTimeout(500)
    
    // 스크린샷
    await page.screenshot({ path: '/private/tmp/claude-501/-Users-hopegiver-workspace-malgnai/dbffdf86-7b59-4266-b3e3-d5b8a021d2f2/scratchpad/activities-logs.png' })
    
    console.log('✓ 테스트 완료')
  } catch (e) {
    console.error('오류:', e.message)
  } finally {
    await browser.close()
  }
}

test()
