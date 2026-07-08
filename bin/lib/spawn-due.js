/**
 * spawn-due.js — 분산 전환(설계 §2.3) 경량 due 스폰 로직.
 *
 * 로직은 **없다** — 스폰 결정(due 판정 + 락 + 예산 + next_run_at 갱신 + command INSERT)은
 *   전부 서버가 단일 트랜잭션으로 처리한다(B3 해소). 이 모듈은 `POST /api/lead/spawn-due` 를
 *   X-API-Key 로 1회 호출하고 응답을 1줄 JSON 으로 로깅만 한다.
 *
 * distributed 가 유일 경로다(central=malgnai-lead 는 제거됨). 마스터 자율 스위치(autonomy_enabled)가
 *   ON 이고 due 인 프로젝트가 있을 때만 실제 스폰이 일어난다(OFF 면 spawn-due 가 즉시 종료, 비용0).
 *
 * bin/loop.js 가 매 틱 첫 단계로 import 하고, bin/run-autonomous-cycles.js 가 수동 디버깅용
 *   CLI 래퍼로 import 한다.
 *
 * 환경변수: MALGNAI_SERVER_URL(서버), MALGNAI_API_KEY(필수, X-API-Key; .dev.vars 폴백).
 */
import { resolveApiKey } from './load-api-key.js'

/** spawnDueOnce — POST /api/lead/spawn-due 1회 호출 + 구조화 로그 1줄. 성공 시 true, 실패 시 false. */
export async function spawnDueOnce(serverUrl = process.env.MALGNAI_SERVER_URL || 'http://localhost:9000') {
  const apiKey = resolveApiKey()
  if (!apiKey) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'error', reason: 'MALGNAI_API_KEY 미설정' }))
    return false
  }
  try {
    const res = await fetch(`${serverUrl}/api/lead/spawn-due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: '{}',
    })
    const data = await res.json().catch(() => ({}))
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'spawn_due', status: res.status, ...data }))
    return res.ok
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'error', reason: e.message }))
    return false
  }
}
