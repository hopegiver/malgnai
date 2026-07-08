// activity-log.js — activity_logs 의 **유일한 쓰기 관문**(reviewer §6 채택).
//
// 왜 단일 관문인가:
//   - level/category 정규화(activity-normalize.js)를 INSERT 직전에 반드시 통과시켜, 엔진 직접 INSERT가
//     normalize 를 우회하던 갭(P3.5)을 구조적으로 제거한다(system→telemetry, autonomy_toggle→audit).
//   - 두 기록 주체(웹 POST·자율엔진 lib)가 같은 컬럼 목록/정규화를 공유 → 매핑·SQL 복제 소거(m-4).
//
// 동기 함수: sqlite-adapter 의 WrappedStatement/SyncTxStatement 는 .run() 이 동기라 db·tx 양쪽에서
//   동일하게 동작한다. → 자율엔진의 db.transaction((tx)=>{...}) 경계 안에서 tx 를 넘겨 호출하면
//   기존 트랜잭션 원자성에 영향 없이 감사로그가 함께 커밋/롤백된다.
import { normalizeActivity } from './activity-normalize.js'

const COLUMNS = 'id, project_id, command_id, agent_name, action, detail, level, category, title, target_ref, result, links_json, correlation_id, created_at'
const INSERT_SQL = `INSERT INTO activity_logs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
// 멱등 upsert(웹 POST 아웃박스 재전송 안전). created_at 은 DO UPDATE 에서 제외 → 최초 기록시각 보존.
const UPSERT_SQL = INSERT_SQL + ` ON CONFLICT(id) DO UPDATE SET
    project_id=excluded.project_id, command_id=excluded.command_id,
    agent_name=excluded.agent_name, action=excluded.action, detail=excluded.detail,
    level=excluded.level, category=excluded.category, title=excluded.title,
    target_ref=excluded.target_ref, result=excluded.result,
    links_json=excluded.links_json, correlation_id=excluded.correlation_id`

/**
 * logActivity — activity_logs 에 1행 기록(정규화 포함). 유일한 쓰기 경로.
 * @param {object} dbOrTx  D1 호환 db 또는 트랜잭션 tx 파사드(둘 다 prepare().bind().run() 동기).
 * @param {object} input   { agent_name*, action*, detail?, project_id?, command_id?, level?, category?, title?, target_ref?, result?, links?, links_json?, correlation_id?, id?, created_at? }
 * @param {object} [opts]  { upsert?: boolean }  true=id 기준 멱등 upsert(웹 POST), false=순수 append(엔진 감사).
 * @returns {object} 기록된 행(정규화 적용값).
 */
export function logActivity(dbOrTx, input = {}, { upsert = false } = {}) {
  const n = normalizeActivity(input)
  const id = input.id || crypto.randomUUID()
  const created_at = input.created_at || new Date().toISOString()
  dbOrTx.prepare(upsert ? UPSERT_SQL : INSERT_SQL).bind(
    id, n.project_id || null, n.command_id || null, n.agent_name, n.action, n.detail || null,
    n.level, n.category, n.title, n.target_ref, n.result, n.links_json, n.correlation_id, created_at,
  ).run()
  return {
    id, project_id: n.project_id ?? null, command_id: n.command_id ?? null,
    agent_name: n.agent_name, action: n.action, detail: n.detail ?? null,
    level: n.level, category: n.category, title: n.title, target_ref: n.target_ref,
    result: n.result, links_json: n.links_json, correlation_id: n.correlation_id, created_at,
  }
}
