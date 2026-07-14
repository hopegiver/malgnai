import { Hono } from 'hono'
import ProjectsDao from '../dao/projects.js'
import ActivitiesDao from '../dao/activities.js'
import AgentsDao from '../dao/agents.js'
import CommandsDao from '../dao/commands.js'
import ClaudeDao from '../dao/claude.js'
import ContextDao from '../dao/context.js'
import { estimateCost, blendedCostForTokens, familyEffectiveRates } from '../lib/pricing.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSuperAdmin } from '../lib/roles.js'

const router = new Hono()

// Claude Code 월 정액 구독료(실지출). 대표님 = Max $100/월. 요금제 변경 시 PLAN_MONTHLY_USD 환경변수로 조정.
const PLAN_MONTHLY_USD = Number(process.env.PLAN_MONTHLY_USD) || 100

// (2026-07-14 버그 수정) authMiddleware 추가 — 이 라우트만 유일하게 인증이 없었다(다른 모든
//   server/api/*.js 라우터는 authMiddleware 를 건다). 인증이 없으면 c.get('user')가 항상
//   undefined 라 commands.inboxSummary()에 스코프를 넘길 수 없었고, 그 결과 홈 대시보드
//   "승인 대기 N건"이 시스템 전체(모든 사용자의 모든 프로젝트) 집계가 되어 /approvals
//   (GET /api/commands?inbox=pending, 요청자 소유권으로 스코핑됨)와 숫자가 어긋났다.
router.get('/', authMiddleware, async (c) => {
  const db = c.env.DB
  const projects = new ProjectsDao(db)
  const activities = new ActivitiesDao(db)
  const agents = new AgentsDao(db)
  const commands = new CommandsDao(db)
  const claude = new ClaudeDao(db)
  const context = new ContextDao(db)
  // super_admin은 모니터링 목적으로 소유권 스코프를 건너뛰어 전체 집계를 본다(commands.js
  // GET '/'·projects.js GET '/' 와 동일 패턴). 그 외 role은 프로젝트/활동/이슈/AI투입 전부
  // 소유자+협업자 스코프로 제한한다 — 이전엔 inboxSummary()만 스코핑되고 나머지(프로젝트 수,
  // 최근 활동, 열린 이슈, 프로젝트별 AI 투입 Top)는 시스템 전체가 그대로 노출되던 버그
  // (2026-07-14 수정).
  const me = c.get('user')
  const superAdmin = isSuperAdmin(me?.role)
  const user = superAdmin ? undefined : me?.sub

  const [
    byStatus, allProjects, recentActivities, allAgents, inbox,
    modelUsage, recentActivity, projectAgg, monthlyTokens, openIssues,
  ] = await Promise.all([
    projects.countByStatus(user),
    projects.findAll('active', 10, 0, undefined, user),
    activities.findAll({ limit: 20, user }),
    agents.findAll({}),
    // B-4 경영 통제센터: 승인 대기/위험도/실패/자동화/비용 집계. GET /api/commands?inbox=pending
    // (server/api/commands.js, /approvals 화면의 목록 소스)와 동일한 소유권 스코프를 쓴다
    // (server/dao/commands.js findAll의 user 필터와 같은 projectAccessWhere 재사용) — 홈 배너
    // 숫자와 승인함 실제 목록이 항상 일치해야 하기 때문(클릭해서 처리 가능한 건수 = 보이는 숫자).
    commands.inboxSummary(user),
    // ai_cost/ai_activity(모델 사용량·누적 비용·가동현황)는 특정 프로젝트 소유권과 무관한
    // "기계 전체" Claude 사용량 집계라 소유권 스코핑이 불가능 — super_admin 전용 경영 정보로
    // 취급해 일반 사용자에게는 아예 조회하지 않고 숨긴다(2026-07-14, 대표 확인).
    superAdmin ? claude.findModelUsage() : Promise.resolve([]),
    superAdmin ? claude.getRecentActivity(7) : Promise.resolve(null),
    claude.getProjectSessionAggregates({ limit: 5, user }), // 프로젝트별 AI 투입 Top
    superAdmin ? claude.getMonthlyTokenStats() : Promise.resolve([]),
    context.issues(null, { status: 'open', limit: 5, user }), // 열린 이슈 Top
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

  // 프로젝트 활동 상태 판정 헬퍼 (projects.js 의 함수들과 동일)
  function isProjectAutonomyOn(p) {
    if (!p) return false
    const flag = p.autonomy_enabled
    const on = flag === '1' || flag === 'true' || flag === 'on' || flag === 1 || flag === true
    if (!on) return false
    if (p.cadence && String(p.cadence).toLowerCase() === 'off') return false
    if (!p.lead_agent_name) return false
    return true
  }

  // 대시보드 active_projects: 자율 활성 우선 → 최근 업데이트 순서 정렬
  const sortedProjects = allProjects
    .map(p => ({
      id: p.id,
      name: p.name,
      updated_at: p.updated_at,
      autonomy_active: isProjectAutonomyOn(p),
    }))
    .sort((a, b) => {
      // 자율 활성 먼저
      if (a.autonomy_active !== b.autonomy_active) {
        return a.autonomy_active ? -1 : 1
      }
      // 그 다음 최근 업데이트 순
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    })

  return c.json({
    total_projects: total,
    by_status: byStatus,
    active_projects: sortedProjects,
    recent_activities: recentActivities,
    agents: allAgents,
    inbox, // { pending, pending_high, pending_medium, pending_low, scheduled_pending, failed, total_cost_usd }
    // --- 경영 계기판 강화(2026-06-24) ---
    // 실비용은 Claude Code 월 정액 구독($100 고정). total_usd/month_usd는 "API 종량 환산 시"
    // 가상 금액으로, 정액 구독 대비 '절감효과'를 산정하는 데만 쓴다(실지출 아님).
    // ⚠️ 기계 전체 집계라 프로젝트 소유권으로 스코핑 불가 — super_admin 전용, 그 외 role엔 null
    // (2026-07-14, 대표 확인).
    ai_cost: superAdmin ? {
      plan_usd: PLAN_MONTHLY_USD,              // 실제 월 정액 구독료(고정 실지출)
      api_equiv_total: cumulative.total_usd,   // API 종량 환산 시 누적(가상)
      api_equiv_month: monthUsd,               // API 종량 환산 시 이번 달(가상)
      saved_month: Math.max(0, monthUsd - PLAN_MONTHLY_USD), // 이번 달 절감효과(환산−정액)
      total_tokens: cumulative.total_tokens,
      models: cumulative.models,               // 모델별 환산/토큰
      by_family: byFamily,                     // { opus, sonnet, haiku } 환산($)
      pct,                                     // 분해 바 퍼센트
      estimated: true,                         // 추정치 표기용
    } : null,
    ai_activity: superAdmin ? recentActivity : null, // { days, messages, sessions, tools, projects }
    open_issues_top: openIssues,               // 소유+협업 프로젝트 열린 이슈 severity 우선
    project_ai_top: projectAgg,                // 프로젝트별 세션 집계 Top5(소유+협업 스코프)
  })
})

export default router
