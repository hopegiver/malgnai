// 회사 카탈로그(agents/skills/knowledge) 읽기 전용 REST — 신규 스코프. scope='company'만
// 노출한다(private 스코프는 v1 범위 아님, migrations/0006 주석 참고). 인증은 이 저장소 기존
// 방식(JWT, server/middleware/jwt-auth.js 전역 미들웨어) 그대로 — 별도 인증 체계를 만들지 않는다.
// 쓰기(동기화)는 server/api/admin-catalog.js(administrator 전용)가 담당하고 이 라우터는 조회만 한다.
import { Hono } from 'hono'
import * as catalogDao from '../dao/catalog.js'

const ITEM_TYPES = ['agent', 'skill', 'knowledge']

const catalog = new Hono()

// GET /api/catalog?type=agent|skill|knowledge — scope='company'만. type 미지정 시 전체.
catalog.get('/', async (c) => {
  const type = c.req.query('type') || undefined
  if (type && !ITEM_TYPES.includes(type)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `type must be one of ${ITEM_TYPES.join(', ')}` } }, 400)
  }
  const list = await catalogDao.listCompanyItems(c.env.DB, type)
  return c.json({
    data: list.map((row) => ({
      id: row.id,
      item_type: row.item_type,
      slug: row.slug,
      display_name: row.display_name,
      description: row.description,
      latest_synced_at: row.latest_synced_at,
      latest_promotion_status: row.latest_promotion_status,
      latest_evaluator_score: row.latest_evaluator_score
    }))
  })
})

// GET /api/catalog/:id — 상세: 목록 필드 + 최신 content_md 전문 + 승격이력 + 스코어 이력
// (evaluator/personal_aggregate/self_service를 섞지 않고 rater_type별로 분리해 반환 — 프론트가
// 공식점수와 개인집계를 혼동해 렌더링하지 않도록).
catalog.get('/:id', async (c) => {
  const id = c.req.param('id')
  const item = await catalogDao.findCompanyItemById(c.env.DB, id)
  if (!item) return c.json({ error: { code: 'NOT_FOUND', message: 'catalog item not found' } }, 404)

  const [latestVersion, promotions, scores] = await Promise.all([
    catalogDao.getLatestVersion(c.env.DB, id),
    catalogDao.listPromotionsForItem(c.env.DB, id),
    catalogDao.listScoresForItem(c.env.DB, id)
  ])

  const scoresByRaterType = { evaluator: [], personal_aggregate: [], self_service: [] }
  for (const s of scores) {
    const bucket = scoresByRaterType[s.rater_type] || (scoresByRaterType[s.rater_type] = [])
    bucket.push({
      id: s.id,
      overall_score: s.overall_score,
      dimension_scores: s.dimension_scores ? JSON.parse(s.dimension_scores) : null,
      rater_id: s.rater_id,
      verified: !!s.verified,
      note: s.note,
      created_at: s.created_at
    })
  }

  return c.json({
    id: item.id,
    item_type: item.item_type,
    slug: item.slug,
    display_name: item.display_name,
    description: item.description,
    source_path: item.source_path,
    created_at: item.created_at,
    updated_at: item.updated_at,
    content_md: latestVersion ? latestVersion.content_md : null,
    latest_synced_at: latestVersion ? latestVersion.synced_at : null,
    promotions: promotions.map((p) => ({
      id: p.id,
      catalog_item_version_id: p.catalog_item_version_id,
      status: p.status,
      reviewer: p.reviewer,
      note: p.note,
      created_at: p.created_at
    })),
    scores: scoresByRaterType
  })
})

export default catalog
