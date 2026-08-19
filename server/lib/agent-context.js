// agent_get_context(mcp-tools.md §4.14) 조합 로직 — server/lib/context.js(project_get_context)와
// 같은 "필요한 맥락만 조합" 철학이지만 project_id가 아니라 user_id+agent_name 스코프다
// (architecture.md §0 결정21). agent-scores.js의 getLatestForAgent+listHistoryForAgent,
// agent-learnings.js의 listRecentForAgent 3개를 독립 조회해 조합한다. 일부 조회만 실패해도
// (예: scores 조회만 타임아웃) 나머지는 정상 반환하고 실패한 section만 null/빈 배열로 채운다
// (전부 실패했을 때만 도구 전체 에러) — context.js §4.1과 동일 비정상 케이스 처리 원칙(§4.14).
import * as agentScoresLib from './agent-scores.js'
import * as agentLearningsLib from './agent-learnings.js'

function toLatestScore(row) {
  if (!row) return null
  return {
    overallScore: row.overall_score,
    dimensionScores: row.dimension_scores ? JSON.parse(row.dimension_scores) : null,
    improvementNote: row.improvement_note ?? null,
    createdAt: row.created_at
  }
}

function toScoreHistory(rows) {
  return rows.map((r) => ({ overallScore: r.overall_score, createdAt: r.created_at }))
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
    agentScoresLib.getLatestForAgent(db, userId, agentName)
      .then((row) => { out.latestScore = toLatestScore(row) })
      .catch(() => { out.latestScore = null; failures.push('latestScore') }),
    agentScoresLib.listHistoryForAgent(db, userId, agentName, scoreHistoryLimit)
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
