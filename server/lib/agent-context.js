// agent_get_context(mcp-tools.md §4.14) 조합 로직 — server/lib/context.js(project_get_context)와
// 같은 "필요한 맥락만 조합" 철학. 2026-08-28부터 scores와 learnings의 스코프가 서로 다르다
// (정본 decision `01m13thq2gbc0hw6tcc4yqh2sq`, 같은 날 읽기 스코프 재승인 — agent-scores.js 상단
// 주석 참고): latestScore/scoreHistory는 agentName→catalog_items 경로로 찾은 "카탈로그 자산의
// 모든 버전을 걸친 통산" 스코프(agent-scores.js), recentLearnings는 그대로 user_id+agent_name
// 스코프(agent-learnings.js, 변경 없음) — 에이전트 코드 품질은 회사 공용 자산이지만 개인 학습
// 경험은 사람에게 속하기 때문. 3개를 독립 조회해 조합한다. 일부 조회만 실패해도(예: scores 조회만
// 타임아웃, 또는 agentName이 아직 카탈로그에 동기화되지 않아 latestScore/scoreHistory가 자연히
// null/빈배열) 나머지는 정상 반환하고 실패한 section만 null/빈 배열로 채운다(전부 실패했을 때만
// 도구 전체 에러) — context.js §4.1과 동일 비정상 케이스 처리 원칙(§4.14).
//
// [버전 식별자를 응답에 싣는 이유] 통산 조회로 넓히면 서로 다른 버전(=서로 다른 MD 내용)의 점수가
// 한 목록에 섞인다. catalogItemVersionId/versionSyncedAt을 각 점수 항목에 함께 실어 "이 점수가
// 어느 버전에 붙었고 그 버전이 언제 동기화됐는지" 호출자(주로 evaluator)가 구분할 수 있게 한다 —
// 안 그러면 "MD를 고치기 전 점수인지 후 점수인지" 알 길이 없어 통산 조회의 목적(점수 왕복 워크플로
// 복원)이 반감된다.
import * as agentScoresLib from './agent-scores.js'
import * as agentLearningsLib from './agent-learnings.js'

function toLatestScore(row) {
  if (!row) return null
  return {
    overallScore: row.overall_score,
    dimensionScores: row.dimension_scores ? JSON.parse(row.dimension_scores) : null,
    note: row.note ?? null,
    raterType: row.rater_type,
    verified: !!row.verified,
    catalogItemVersionId: row.catalog_item_version_id,
    versionSyncedAt: row.version_synced_at,
    createdAt: row.created_at
  }
}

function toScoreHistory(rows) {
  return rows.map((r) => ({
    overallScore: r.overall_score,
    createdAt: r.created_at,
    raterType: r.rater_type,
    verified: !!r.verified,
    catalogItemVersionId: r.catalog_item_version_id,
    versionSyncedAt: r.version_synced_at
  }))
}

function toRecentLearnings(rows) {
  return rows.map((r) => ({
    type: r.type,
    title: r.title,
    content: r.content,
    source: r.source ?? null,
    createdAt: r.created_at
  }))
}

export async function getAgentContext(db, userId, agentName, { learningLimit = 10, scoreHistoryLimit = 10 } = {}) {
  const out = { agentName, latestScore: null, scoreHistory: [], recentLearnings: [] }
  const failures = []

  const tasks = [
    agentScoresLib.getLatestForAgent(db, agentName)
      .then((row) => { out.latestScore = toLatestScore(row) })
      .catch(() => { out.latestScore = null; failures.push('latestScore') }),
    agentScoresLib.listHistoryForAgent(db, agentName, scoreHistoryLimit)
      .then((rows) => { out.scoreHistory = toScoreHistory(rows) })
      .catch(() => { out.scoreHistory = null; failures.push('scoreHistory') }),
    agentLearningsLib.listRecentForAgent(db, userId, agentName, learningLimit)
      .then((rows) => { out.recentLearnings = toRecentLearnings(rows) })
      .catch(() => { out.recentLearnings = null; failures.push('recentLearnings') })
  ]

  await Promise.all(tasks)

  if (failures.length === tasks.length) {
    const e = new Error('all agent context sections failed')
    e.name = 'InternalError'
    throw e
  }
  return out
}
