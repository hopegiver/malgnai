// agent_score_record/agent_get_context 공통 구현 — catalog_scores(catalog_item_version_id 스코프)
// 기반으로 전면 재정의(2026-08-28, 정본 decision `01m13thq2gbc0hw6tcc4yqh2sq`, malgnai-hub
// projectId `01m0vr55135n2ychx4w5d3rj1x`). 옛 user_id+agent_name 스코프 전용 테이블(migrations/0005
// 도입, 0015에서 DROP)은 더 이상 존재하지 않는다 — 이 파일은 그 테이블을 참조하지 않는다.
//
// [왜 catalog_scores인가] malgn-agent 에이전트는 전 직원이 동일 코드를 공유하므로 점수는 개인이
// 아니라 agentName(+버전) 단위 품질 지표여야 "이 버전이 실제로 개선됐나"를 볼 수 있다. catalog_scores
// (migrations/0006, catalog_item_version_id 스코프, rater_type/verified 기존 보유)를 재사용해
// 새 테이블 없이 스키마 전체의 불변성 원칙(매번 새 행 INSERT)을 그대로 따른다.
//
// [idempotencyKey 처리 방침 — PM 보고 필요] catalog_scores 테이블에는 idempotency_key 컬럼이
// 없다(임의 컬럼 추가 금지 지시, 이번 세션 범위 밖). decisions/issues/works/agent_learnings처럼
// "idempotency_key UNIQUE 위반 시 기존 행 반환"하는 DB 레벨 재전송 감지를 이 도구에서는 걸 수
// 없다. 대안으로 애플리케이션 레벨에서 (catalog_item_version_id, rater_id, overall_score, note)
// 조합으로 최근 N초 이내 중복을 탐지하는 방법도 검토했으나, 정상적으로 같은 값을 연속 재채점하는
// 케이스(예: evaluator가 같은 점수를 의도적으로 재확인)와 구분할 수 없어 채택하지 않았다.
// 결론: idempotencyKey는 호출 계약 유지 + 향후 컬럼 추가 시 재사용할 sessionId 추출용으로만
// 검증(필수 입력)하고, 매번 새 행을 INSERT한다 — 클라이언트가 네트워크 실패 후 동일
// idempotencyKey로 재전송하면 중복 행이 생길 수 있다(같은 값이므로 "최신 점수" 조회 결과에는
// 영향 없음 — created_at DESC LIMIT 1이 그중 하나를 반환할 뿐이고 history에 중복 1건이 더 보일
// 뿐이다). 이 트레이드오프가 운영상 문제(예: 대시보드에서 중복이 눈에 띄게 쌓임)가 되면
// catalog_scores에 idempotency_key 컬럼 추가를 PM 승인 하에 재검토한다.
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'
import * as catalogDao from '../dao/catalog.js'

const MAX_DIMENSION_SCORES_BYTES = 4 * 1024
const MAX_NOTE_LENGTH = 4000 // 병합 전 improvementNote+evaluatorNote 각 ≤2000자 한도를 승계
const RATER_TYPES = ['evaluator', 'personal_aggregate', 'self_service']

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

function notFoundError(message) {
  const e = new Error(message)
  e.name = 'NotFoundError'
  return e
}

function byteLength(str) {
  return new TextEncoder().encode(str).length
}

/** agentName → catalog_items(scope='company', item_type='agent') → 최신 catalog_item_versions.
 *  둘 중 하나라도 없으면 NOT_FOUND(카탈로그 미동기 에이전트) — record/getContext 양쪽이 공유. */
async function resolveLatestAgentVersion(db, agentName) {
  const item = await catalogDao.findCompanyItemBySlug(db, 'agent', agentName)
  if (!item) return null
  return catalogDao.getLatestVersion(db, item.id)
}

/** agent_score_record. verified는 클라이언트 입력을 받지 않고 raterType==='evaluator'일 때만
 *  서버가 1로 강제한다(self_service가 "공식 점수"를 자칭하지 못하게, idea.md §12.3과 동일 이유).
 *  rater_id는 항상 ctx.props.userId에서 온 userId — 클라이언트가 보낸 값은 절대 신뢰하지 않는다. */
export async function recordAgentScore(db, { userId, agentName, overallScore, dimensionScores, note, raterType, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!agentName || typeof agentName !== 'string') throw validationError('agentName is required')
  if (!RATER_TYPES.includes(raterType)) throw validationError(`raterType must be one of ${RATER_TYPES.join(',')}`)
  if (typeof overallScore !== 'number' || Number.isNaN(overallScore) || overallScore < 0 || overallScore > 100) {
    throw validationError('overallScore must be a number 0..100')
  }
  if (note != null && String(note).length > MAX_NOTE_LENGTH) throw validationError(`note must be <= ${MAX_NOTE_LENGTH} chars`)

  let dimensionScoresJson = null
  if (dimensionScores != null) {
    if (typeof dimensionScores !== 'object' || Array.isArray(dimensionScores)) {
      throw validationError('dimensionScores must be an object')
    }
    dimensionScoresJson = JSON.stringify(dimensionScores)
    if (byteLength(dimensionScoresJson) > MAX_DIMENSION_SCORES_BYTES) {
      throw validationError('dimensionScores must be <= 4KB when serialized')
    }
  }

  const item = await catalogDao.findCompanyItemBySlug(db, 'agent', agentName)
  if (!item) throw notFoundError(`agent not found in company catalog: ${agentName}`)
  const version = await catalogDao.getLatestVersion(db, item.id)
  if (!version) throw notFoundError(`agent has no synced catalog version: ${agentName}`)

  // idempotencyKey 자체는 DB에 저장하지 않는다(위 파일 상단 주석 — catalog_scores에 컬럼 없음).
  // parseIdempotencyKey는 형식 유효성만 훑는 부작용 없는 호출.
  parseIdempotencyKey(idempotencyKey)

  const verified = raterType === 'evaluator' ? 1 : 0
  const id = newId()
  const now = new Date().toISOString()

  await db.prepare(
    `INSERT INTO catalog_scores (id, catalog_item_version_id, overall_score, dimension_scores, rater_type, rater_id, verified, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    version.id,
    overallScore,
    dimensionScoresJson,
    raterType,
    userId,
    verified,
    note != null ? String(note).slice(0, MAX_NOTE_LENGTH) : null,
    now
  ).run()

  return { id, createdAt: now, catalogItemVersionId: version.id, verified: !!verified }
}

/** agent_get_context용 — agentName의 최신 동기화 버전을 먼저 찾은 뒤 그 버전 id로 최신 1행.
 *  카탈로그에 없는 agentName은 에러가 아니라 null(agent-context.js가 latestScore=null로 흡수). */
export async function getLatestForAgent(db, agentName) {
  const version = await resolveLatestAgentVersion(db, agentName)
  if (!version) return null
  return db.prepare(
    'SELECT * FROM catalog_scores WHERE catalog_item_version_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(version.id).first()
}

/** agent_get_context용 — overallScore+createdAt 추이용 최신순 N개(같은 버전 스코프). */
export async function listHistoryForAgent(db, agentName, limit = 10) {
  const version = await resolveLatestAgentVersion(db, agentName)
  if (!version) return []
  const { results } = await db.prepare(
    'SELECT overall_score, created_at, rater_type, verified FROM catalog_scores WHERE catalog_item_version_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(version.id, limit).all()
  return results
}
