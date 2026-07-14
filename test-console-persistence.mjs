import { chromium } from 'playwright';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJob3BlZ2l2ZXJAbWFsZ25zb2Z0LmNvbSIsImlhdCI6MTc4MzY5NTg2NCwiZXhwIjoxNzgzNzEwMjY0fQ.yhWEsI6HHCv33j3EtH1C7et-neM-rJmLSlJ4OBtMR6s';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.createContext();
  const page = await context.newPage();

  try {
    // localStorage에 토큰 설정
    await page.goto('http://localhost:9000', { waitUntil: 'networkidle' });
    await page.evaluate((token) => {
      localStorage.setItem('token', token);
    }, TOKEN);

    console.log('1️⃣  AI 콘솔 페이지로 이동...');
    await page.goto('http://localhost:9000/console', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // 프로젝트 select 로드 대기
    await page.waitForSelector('select.form-select', { timeout: 5000 });
    const projects = await page.locator('select.form-select option').count();
    console.log(`   📌 프로젝트 옵션 수: ${projects}개`);

    if (projects <= 1) {
      console.log('❌ 선택 가능한 프로젝트가 없습니다.');
      await browser.close();
      process.exit(1);
    }

    console.log('2️⃣  첫 번째 프로젝트 선택...');
    const selectEl = page.locator('select.form-select');
    await selectEl.selectOption({ index: 1 });
    await page.waitForTimeout(1500);

    const selectedProject = await selectEl.inputValue();
    console.log(`   ✅ 선택된 프로젝트 ID: ${selectedProject}`);

    // 세션 목록 로드 대기
    let selectedSession = null;
    try {
      await page.waitForSelector('.console-session-item', { timeout: 3000 });
      const sessionItems = await page.locator('.console-session-item').count();
      console.log(`   📌 사용 가능한 세션: ${sessionItems}개`);

      if (sessionItems > 0) {
        console.log('3️⃣  첫 번째 세션 선택...');
        const firstSession = page.locator('.console-session-item').first();
        await firstSession.click();
        await page.waitForTimeout(1000);

        // 활성 세션 ID 획득
        selectedSession = await page.evaluate(() => {
          const active = document.querySelector('.console-session-item.active');
          if (active) {
            // data-session-id 또는 첫 번째 인자에서 얻기
            return active.getAttribute('data-session-id') || active.textContent.split('\n')[0];
          }
          return null;
        });
        console.log(`   ✅ 선택된 세션: ${selectedSession}`);
      }
    } catch (e) {
      console.log('   ℹ️  세션이 없습니다 (정상)');
    }

    // localStorage 상태 확인 (새로고침 전)
    console.log('\n4️⃣  새로고침 전 localStorage 상태:');
    const beforeRefresh = await page.evaluate(() => ({
      projectId: localStorage.getItem('console_selectedProjectId'),
      sessionId: localStorage.getItem('console_currentSessionId'),
    }));
    console.log(`   projectId: ${beforeRefresh.projectId}`);
    console.log(`   sessionId: ${beforeRefresh.sessionId}`);

    if (!beforeRefresh.projectId) {
      console.log('❌ 프로젝트 ID가 저장되지 않았습니다!');
      await browser.close();
      process.exit(1);
    }

    console.log('\n5️⃣  페이지 새로고침...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    console.log('\n6️⃣  새로고침 후 상태 확인:');

    // select 요소 복구 확인
    const selectValue = await page.locator('select.form-select').inputValue();
    console.log(`   select 값: ${selectValue}`);

    // localStorage 확인
    const afterRefresh = await page.evaluate(() => ({
      projectId: localStorage.getItem('console_selectedProjectId'),
      sessionId: localStorage.getItem('console_currentSessionId'),
    }));
    console.log(`   localStorage projectId: ${afterRefresh.projectId}`);
    console.log(`   localStorage sessionId: ${afterRefresh.sessionId}`);

    // 결과 판정
    console.log('\n📊 테스트 결과:');
    let passed = true;

    if (selectValue === selectedProject) {
      console.log('   ✅ 프로젝트 select 복구됨');
    } else {
      console.log(`   ❌ 프로젝트 select 미복구 (기대: ${selectedProject}, 실제: ${selectValue})`);
      passed = false;
    }

    if (afterRefresh.projectId === selectedProject) {
      console.log('   ✅ projectId localStorage 복구됨');
    } else {
      console.log(`   ❌ projectId 미복구 (기대: ${selectedProject}, 실제: ${afterRefresh.projectId})`);
      passed = false;
    }

    if (selectedSession) {
      if (afterRefresh.sessionId === selectedSession) {
        console.log('   ✅ sessionId localStorage 복구됨');
      } else {
        console.log(`   ⚠️  sessionId 미복구 (기대: ${selectedSession}, 실제: ${afterRefresh.sessionId})`);
        // 세션은 복구 안 되어도 일단 통과(선택적)
      }
    }

    console.log(passed ? '\n✅ 테스트 통과!' : '\n❌ 테스트 실패!');
    await browser.close();
    process.exit(passed ? 0 : 1);

  } catch (error) {
    console.error('❌ 테스트 오류:', error.message);
    await browser.close();
    process.exit(1);
  }
})();
