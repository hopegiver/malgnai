import { defineConfig } from 'vitest/config'

// API 통합 테스트 전용 설정(performance/vitest.config.js 참고). 브라우저 없이 순수 fetch 로
// 이미 기동 중인 로컬 서버(:9000)를 호출하므로 무겁지 않지만, DB I/O가 섞인 통합 테스트라
// 기본 타임아웃보다 여유를 둔다.
export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 10000,
    // .claude/worktrees/* 는 Workflow 도구가 만드는 임시 git worktree(테스트 파일 사본을
    // 포함)다. 자동정리가 안 되고 잔존하면 vitest 기본 glob이 재귀적으로 주워 담아
    // pnpm run test:api 를 오염시킨 사고가 있었다(2026-07-12) — 명시적으로 제외한다.
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
  },
})
