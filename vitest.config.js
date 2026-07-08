import { defineConfig } from 'vitest/config'

// API 통합 테스트 전용 설정(performance/vitest.config.js 참고). 브라우저 없이 순수 fetch 로
// 이미 기동 중인 로컬 서버(:9000)를 호출하므로 무겁지 않지만, DB I/O가 섞인 통합 테스트라
// 기본 타임아웃보다 여유를 둔다.
export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 10000,
  },
})
