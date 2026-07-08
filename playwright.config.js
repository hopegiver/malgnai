// E2E 스캐폴드 템플릿 — 프로젝트 repo에 복사해 쓴다.
// 브라우저는 전역 공유 캐시(~/Library/Caches/ms-playwright)를 그대로 사용한다.
// 로그인은 전역 shot 인증(레시피/storageState)을 재사용한다(e2e/auth.setup.js).
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:9000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',   // 실패 재현용 trace (npx playwright show-trace)
    screenshot: 'only-on-failure',
  },
  projects: [
    // 1) 인증 세션 준비(전역 shot 인증 재사용) → e2e/.auth/user.json
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    // 2) 인증된 상태로 테스트 실행
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
    // 모바일도 검증하려면 주석 해제
    // {
    //   name: 'mobile',
    //   use: { ...devices['iPhone 15 Pro'], storageState: 'e2e/.auth/user.json' },
    //   dependencies: ['setup'],
    // },
  ],
});
