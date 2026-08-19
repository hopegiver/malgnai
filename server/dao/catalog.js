// catalog_items / catalog_item_versions / catalog_promotions / catalog_scores DAO
// (migrations/0006_catalog_items.sql). 두 진입점(server/lib/catalog-sync.js의 GitHub 동기화 +
// server/api/catalog.js의 REST 읽기)이 같은 4개 테이블을 쓰기 때문에 DAO로 분리한다
// (backend-api-implementation-patterns "DAO 유무 판단" 기준 — 여러 진입점이 같은 테이블을 쓰면 DAO).
import { newId } from '../lib/ulid.js'

/** scope='company' 카탈로그 항목 upsert(plugin_name+item_type+slug 유니크). 파싱 실패로
 *  displayName/description이 null이어도 항목 자체는 조용히 빼지 않고 그대로 반영한다. */
export async function upsertCompanyItem(db, { pluginName, itemType, slug, displayName, description, sourcePath }) {
  const now = new Date().toISOString()
  const existing = await db.prepare(
    `SELECT * FROM catalog_items WHERE scope = 'company' AND plugin_name = ? AND item_type = ? AND slug = ?`
  ).bind(pluginName, itemType, slug).first()

  if (existing) {
    await db.prepare(
      `UPDATE catalog_items SET display_name = ?, description = ?, source_path = ?, updated_at = ? WHERE id = ?`
    ).bind(displayName ?? null, description ?? null, sourcePath, now, existing.id).run()
    return { id: existing.id, created: false }
  }

  const id = newId()
  try {
    await db.prepare(
      `INSERT INTO catalog_items (id, scope, owner_user_id, plugin_name, item_type, slug, display_name, description, source_path, created_at, updated_at)
       VALUES (?, 'company', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, pluginName, itemType, slug, displayName ?? null, description ?? null, sourcePath, now, now).run()
    return { id, created: true }
  } catch (e) {
    // 동시 sync 레이스(관리자 수동 트리거 vs cron 겹침)로 다른 요청이 먼저 만들었으면 그 행을 갱신.
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare(
        `SELECT * FROM catalog_items WHERE scope = 'company' AND plugin_name = ? AND item_type = ? AND slug = ?`
      ).bind(pluginName, itemType, slug).first()
      if (row) {
        await db.prepare(
          `UPDATE catalog_items SET display_name = ?, description = ?, source_path = ?, updated_at = ? WHERE id = ?`
        ).bind(displayName ?? null, description ?? null, sourcePath, now, row.id).run()
        return { id: row.id, created: false }
      }
    }
    throw e
  }
}

export async function getLatestVersion(db, catalogItemId) {
  return db.prepare(
    'SELECT * FROM catalog_item_versions WHERE catalog_item_id = ? ORDER BY synced_at DESC LIMIT 1'
  ).bind(catalogItemId).first()
}

/** content_sha가 직전 최신 버전과 같으면 새 행을 만들지 않고 스킵한다(catalog-sync.js). */
export async function insertVersionIfChanged(db, catalogItemId, contentSha, contentMd) {
  const latest = await getLatestVersion(db, catalogItemId)
  if (latest && latest.content_sha === contentSha) return { id: latest.id, created: false }

  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO catalog_item_versions (id, catalog_item_id, content_sha, content_md, synced_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, catalogItemId, contentSha, contentMd, now).run()
  return { id, created: true }
}

/** GET /api/catalog?type= — scope='company'만. 각 항목의 최신 동기화 시각/최신 승격상태/최신
 *  evaluator 공식점수를 상관 서브쿼리로 함께 반환(SQLite에는 DISTINCT ON이 없어 이 방식을 쓴다). */
export async function listCompanyItems(db, itemType) {
  let sql = `
    SELECT
      ci.id, ci.item_type, ci.slug, ci.display_name, ci.description,
      (SELECT civ.synced_at FROM catalog_item_versions civ
        WHERE civ.catalog_item_id = ci.id ORDER BY civ.synced_at DESC LIMIT 1) AS latest_synced_at,
      (SELECT cp.status FROM catalog_promotions cp
        JOIN catalog_item_versions civ ON civ.id = cp.catalog_item_version_id
        WHERE civ.catalog_item_id = ci.id ORDER BY cp.created_at DESC LIMIT 1) AS latest_promotion_status,
      (SELECT cs.overall_score FROM catalog_scores cs
        JOIN catalog_item_versions civ ON civ.id = cs.catalog_item_version_id
        WHERE civ.catalog_item_id = ci.id AND cs.rater_type = 'evaluator'
        ORDER BY cs.created_at DESC LIMIT 1) AS latest_evaluator_score
    FROM catalog_items ci
    WHERE ci.scope = 'company'
  `
  const params = []
  if (itemType) {
    sql += ' AND ci.item_type = ?'
    params.push(itemType)
  }
  sql += ' ORDER BY ci.item_type, ci.slug'
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}

export async function findCompanyItemById(db, id) {
  return db.prepare(`SELECT * FROM catalog_items WHERE id = ? AND scope = 'company'`).bind(id).first()
}

/** GET /api/catalog/:id 승격이력(전체, 최신순). */
export async function listPromotionsForItem(db, catalogItemId) {
  const { results } = await db.prepare(
    `SELECT cp.* FROM catalog_promotions cp
     JOIN catalog_item_versions civ ON civ.id = cp.catalog_item_version_id
     WHERE civ.catalog_item_id = ? ORDER BY cp.created_at DESC`
  ).bind(catalogItemId).all()
  return results
}

/** GET /api/catalog/:id 스코어 이력(전체, 최신순) — rater_type별 분리는 라우트에서 처리
 *  (프론트가 evaluator/personal_aggregate를 섞어 렌더링하지 않도록). */
export async function listScoresForItem(db, catalogItemId) {
  const { results } = await db.prepare(
    `SELECT cs.* FROM catalog_scores cs
     JOIN catalog_item_versions civ ON civ.id = cs.catalog_item_version_id
     WHERE civ.catalog_item_id = ? ORDER BY cs.created_at DESC`
  ).bind(catalogItemId).all()
  return results
}
