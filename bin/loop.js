#!/usr/bin/env node
/**
 * bin/loop.js — malgnai 단순 코어의 "루프(깨어남)" 단일 러너(docs/design/simple-core.md P4).
 *
 * 이 프로세스가 곧 5줄 본질의 심장이다: 깨어난다 → (1) 프로젝트 due 스폰(spawn-due) →
 *   (2) 명령 큐 1건 claim·실행(poll) → 다음 깨어남까지 종료.
 *
 * com.malgnai.autoloop(60s, spawn-due 호출) + com.malgnai.poll(90s, claim/실행) 2개
 *   LaunchAgent 를 이 스크립트 1개 + LaunchAgent 1개(com.malgnai.loop, 60s)로 통합했다
 *   (LaunchAgent 8→5). 내부 로직은 lib/spawn-due.js·lib/poll-commands.js 그대로
 *   재사용(순서만 결합) — 동작 회귀 없음, 관리 표면만 줄인다.
 *
 * ⚠️ 실행 인프라 재설계(docs/design/execution-infra-redesign.md §2, v3 최종) 이후 역할 변화:
 *   이 (1)+(2) 순서는 더 이상 "유일한 실행 경로"가 아니다. 이제 커맨드 대부분은 즉시디스패치
 *   두 경로(사람 승인 시 PATCH /api/commands/:id/review, spawn-due 스폰 직후 둘 다
 *   server/lib/dispatch-worker.js 를 직접 호출)로 즉시 실행된다. 이 스크립트의 spawnDueOnce/
 *   pollOnce 는 그 두 즉시디스패치 경로가 놓쳤거나(claim 레이스 패배) 실패한 것만 걷어가는
 *   **안전망**으로 역할이 바뀌었다 — 여전히 60s 마다 돌아야 하지만, "정상 경로에서는 대부분 할 일이
 *   없는 게 정상"이라는 전제가 바뀐 지점이다.
 *
 * 환경변수: MALGNAI_SERVER_URL, MALGNAI_API_KEY(둘 다 두 하위 모듈이 공유).
 */
import { spawnDueOnce } from './lib/spawn-due.js'
import { pollOnce } from './lib/poll-commands.js'

async function main() {
  await spawnDueOnce().catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'loop_spawn_due_error', error: e.message })))
  await pollOnce().catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'loop_poll_error', error: e.message })))
}

main()
