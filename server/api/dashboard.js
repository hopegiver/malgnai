import { Hono } from 'hono'
import ProjectsDao from '../dao/projects.js'
import ActivitiesDao from '../dao/activities.js'
import AgentsDao from '../dao/agents.js'
import CommandsDao from '../dao/commands.js'
import ClaudeDao from '../dao/claude.js'
import ContextDao from '../dao/context.js'
import { estimateCost, blendedCostForTokens, familyEffectiveRates } from '../lib/pricing.js'

const router = new Hono()

// Claude Code 월 정액 구독료(실지출). 대표님 = Max $100/월. 요금제 변경 시 PLAN_MONTHLY_USD 환경변수로 조정.
const PLAN_MONTHLY_USD = Number(process.env.PLAN_MONTHLY_USD) || 100

router.get('/', async (c) => {
  const db = c.env.DB
  const projects = new ProjectsDao(db)
  const activities = new ActivitiesDao(db)
  const agents = new AgentsDao(db)
  const commands = new CommandsDao(db)
  const claude = new ClaudeDao(db)
  const context = new ContextDao(db)

  const [
    byStatus, allProjects, recentActivities, allAgents, inbox,
    modelUsage, recentActivity, projectAgg, monthlyTokens, openIssues,
  ] = await Promise.all([
    projects.countByStatus(),
    projects.findAll('active', 10, 0),
    activities.findAll({ limit: 20 }),
    agents.findAll({}),
    commands.inboxSummary(), // B-4 경영 통제센터: 승인 대기/위험도/실패/자동화/비용 집계
    claude.findModelUsage(),               // 누적 모델 사용량 → 비용 환산
    claude.getRecentActivity(7),           // 최근 7일 가동 현황
    claude.getProjectSessionAggregates({ limit: 5 }), // 프로젝트별 AI 투입 Top
    claude.getMonthlyTokenStats(),         // 이번 달 일별 토큰 → blended 비용
    context.issues(null, { status: 'open', limit: 5 }), // 전역 열린 이슈 Top
  ])

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)

  // AI 비용: 누적은 model_usage(토큰 종류 분해됨)로 정밀 환산, 이번 달은 token_stats(총량)로 blended 근사.
  const cumulative = estimateCost(modelUsage)
  // 이번 달은 token_stats(총량)를 family별 실효단가(누적 기준)로 환산 → 누적과 같은 단가 체계.
  const effRates = familyEffectiveRates(cumulative)
  let monthUsd = 0
  for (const t of monthlyTokens) monthUsd += blendedCostForTokens(t.model, t.tokens, effRates)
  // family별 비용 집계 + 분해 바 퍼센트(누적 기준).
  const byFamily = { opus: 0, sonnet: 0, haiku: 0 }
  for (const m of cumulative.models) byFamily[m.family] = (byFamily[m.family] || 0) + m.cost_usd
  const famTotal = byFamily.opus + byFamily.sonnet + byFamily.haiku || 1
  const pct = {
    opus: byFamily.opus / famTotal * 100,
    sonnet: byFamily.sonnet / famTotal * 100,
    haiku: byFamily.haiku / famTotal * 100,
  }

  return c.json({
    total_projects: total,
    by_status: byStatus,
    active_projects: allProjects.map(p => ({ id: p.id, name: p.name, updated_at: p.updated_at })),
    recent_activities: recentActivities,
    agents: allAgents,
    inbox, // { pending, pending_high, pending_medium, pending_low, scheduled_pending, failed, total_cost_usd }
    // --- 경영 계기판 강화(2026-06-24) ---
    // 실비용은 Claude Code 월 정액 구독($100 고정). total_usd/month_usd는 "API 종량 환산 시"
    // 가상 금액으로, 정액 구독 대비 '절감효과'를 산정하는 데만 쓴다(실지출 아님).
    ai_cost: {
      plan_usd: PLAN_MONTHLY_USD,              // 실제 월 정액 구독료(고정 실지출)
      api_equiv_total: cumulative.total_usd,   // API 종량 환산 시 누적(가상)
      api_equiv_month: monthUsd,               // API 종량 환산 시 이번 달(가상)
      saved_month: Math.max(0, monthUsd - PLAN_MONTHLY_USD), // 이번 달 절감효과(환산−정액)
      total_tokens: cumulative.total_tokens,
      models: cumulative.models,               // 모델별 환산/토큰
      by_family: byFamily,                     // { opus, sonnet, haiku } 환산($)
      pct,                                     // 분해 바 퍼센트
      estimated: true,                         // 추정치 표기용
    },
    ai_activity: recentActivity,               // { days, messages, sessions, tools, projects }
    open_issues_top: openIssues,               // 전역 열린 이슈 severity 우선
    project_ai_top: projectAgg,                // 프로젝트별 세션 집계 Top5
  })
})

export default router
