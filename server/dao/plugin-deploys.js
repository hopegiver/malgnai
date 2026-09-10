// plugin_deploys DAO (migrations/0027_plugin_deploys.sql) — CI 인바운드 배포알림(POST /notify)과
// 직원 조회(GET /)가 같은 테이블을 쓰므로 DAO로 분리한다(backend-api-implementation-patterns
// "DAO 유무 판단" 기준). 설계 정본: docs/design/plugin-deploy-notify.md §7·§8.
import { newId } from '../lib/ulid.js'

/** 인입 처리의 멱등 지점(§8.2). `INSERT ... ON CONFLICT DO NOTHING RETURNING`으로 "반환 행이
 *  있는가"라는 구조적 신호로 신규/중복을 판별한다 — dao/catalog.js의 `e.message.includes('UNIQUE')`
 *  방식(드라이버 에러 문구 의존)을 재사용하지 않는다(§8.2 근거). 로컬 `wrangler d1 execute --local`
 *  실측으로 D1(SQLite)이 이 조합을 지원함을 확인했다(설계가 예고한 폴백은 불필요).
 *  경합(동시 재시도 2건)에도 안전 — 둘 중 하나만 행을 반환받는다. */
export async function insertIfAbsent(db, { pluginName, version, commitHash, repository, deployedAt, receivedAt }) {
  const id = newId()
  const { results } = await db.prepare(
    `INSERT INTO plugin_deploys (id, plugin_name, version, commit_hash, repository, deployed_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (plugin_name, version, commit_hash) DO NOTHING
     RETURNING id, plugin_name, version, commit_hash, repository, deployed_at, received_at`
  ).bind(id, pluginName, version, commitHash, repository ?? null, deployedAt, receivedAt).all()

  if (results && results.length > 0) {
    return { created: true, row: results[0] }
  }

  // 반환 행 없음 = 유니크 충돌(이미 같은 (plugin_name,version,commit_hash) 행 존재) — 재전송(200)
  // 응답은 최초 수신 당시 행 값 그대로여야 한다(§6.2 "id·received_at이 바뀌지 않는다").
  const row = await findByNaturalKey(db, pluginName, version, commitHash)
  if (!row) {
    // 이론상 도달 불가(m-4) — ON CONFLICT 직후 같은 자연키로 조회했는데 행이 없다면 동시 삭제 등
    // 예기치 못한 경합이다. 호출부(server/api/plugin-deploys.js)가 row.plugin_name 등 하위 필드에
    // 바로 접근하므로, 여기서 막지 않으면 TypeError로 원인이 마스킹된 500이 된다. 명시적으로
    // 승격시켜 onError 로그(console.error('[unhandled]', err))에 실제 원인이 남게 한다.
    const e = new Error(`plugin_deploys conflict lookup returned no row for natural key (${pluginName}, ${version}, ${commitHash})`)
    e.name = 'InternalError'
    throw e
  }
  return { created: false, row }
}

/** 자연 키(멱등 키)로 기존 행을 찾는다. insertIfAbsent()의 재전송 분기 + 테스트에서 재사용. */
export async function findByNaturalKey(db, pluginName, version, commitHash) {
  return db.prepare(
    `SELECT id, plugin_name, version, commit_hash, repository, deployed_at, received_at
     FROM plugin_deploys WHERE plugin_name = ? AND version = ? AND commit_hash = ?`
  ).bind(pluginName, version, commitHash).first()
}

/** 전역 sync 쿨다운 게이트의 저장소(security 정밀검토 M-1, migrations/0028). 새 테이블·새 바인딩을
 *  만들지 않고 plugin_deploys에 얹은 컬럼 하나(sync_triggered_at)에서 derive한다. plugin_name으로
 *  필터하지 않는 **전역** 조회다 — syncCatalog()가 소진하는 GitHub API 요청 한도는 어떤 튜플로
 *  트리거됐는지와 무관하게 계정 전체가 공유하므로, 공격자가 plugin_name까지 바꿔 지어내도
 *  이 게이트가 보는 "마지막 트리거 시각"은 하나로 유지된다. */
export async function getLastSyncTriggeredAt(db) {
  const row = await db.prepare(
    `SELECT MAX(sync_triggered_at) AS last FROM plugin_deploys WHERE sync_triggered_at IS NOT NULL`
  ).bind().first()
  return row && row.last ? row.last : null
}

/** sync를 실제로 걸기로 결정한 바로 그 요청의 행에 트리거 시각(=receivedAt)을 기록한다. 응답을
 *  만들기 전, waitUntil로 넘기기 전에 동기적으로 기록해 경합 창을 최소화한다 — D1은 요청 간
 *  트랜잭션이 없어 완벽한 원자성은 아니지만, 정상 트래픽(하루 0~수 회)에서는 이 창이 문제가 될
 *  동시성 자체가 없다(호출부 server/api/plugin-deploys.js의 쿨다운 게이트 주석 참고). */
export async function markSyncTriggered(db, id, triggeredAt) {
  await db.prepare(`UPDATE plugin_deploys SET sync_triggered_at = ? WHERE id = ?`).bind(triggeredAt, id).run()
}

/** GET /api/plugin-deploys?plugin=&limit= — "현재 버전"의 정의(§6.5)는 이 목록의 data[0]:
 *  ORDER BY received_at DESC, id DESC(ULID가 시간정렬 가능이라 동률 타이브레이커로 정확히 작동). */
export async function listRecent(db, { pluginName, limit }) {
  let sql = `
    SELECT id, plugin_name, version, commit_hash, repository, deployed_at, received_at
    FROM plugin_deploys
  `
  const params = []
  if (pluginName) {
    sql += ' WHERE plugin_name = ?'
    params.push(pluginName)
  }
  sql += ' ORDER BY received_at DESC, id DESC LIMIT ?'
  params.push(limit)
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}
