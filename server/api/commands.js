import { Hono } from 'hono'
import CommandsDao from '../dao/commands.js'
import ProjectsDao from '../dao/projects.js'
import { badRequest, notFound, conflict } from '../utils/response.js'
import { authMiddleware, apiKeyMiddleware } from '../middleware/auth.js'
import { resolveAllowedTools, resolveSandboxProfile, resolveMaxTurns } from '../lib/tool-profiles.js'
import { reviewCommandTx, claimApprovedForProject } from '../lib/instant-dispatch.js'
import { dispatchApprovedCommand } from '../lib/dispatch-worker.js'
import { buildResumePrompt, maybeRequeueResume } from '../lib/resume-loop.js'
import { logActivity } from '../lib/activity-log.js'

const router = new Hono()

// instruction 최대 길이. LEAD 자기태스킹 루프의 하드닝된 프롬프트(현재 4022자, JSON-only 강제·
// mcp 금지·툴에러시에도 JSON 반환 등 안전 지침 인라인)를 정상 수용하기 위해 4000 → 8000 으로 상향.
// (이 상한을 넘던 4022자 daily-lead-cycle instruction 이 스케줄러 경로에서 400 을 받아 자율 루프가
//  조용히 멈추던 회귀를 해소 — 이슈 28876de3.) DB 컬럼(commands.instruction)은 TEXT 라 제약 없음.
// 8000 은 현재+향후 프롬프트 하드닝 여유를 주면서도 단일 명령이 무한정 커지는 남용은 막는 합리적 상한.
const MAX_INSTRUCTION_LEN = 8000

const PERMISSION_MODES = ['allowlist', 'acceptEdits', 'bypass']
const STATUSES = ['queued', 'approved', 'claimed', 'running', 'done', 'failed', 'rejected', 'expired']
const RISK_LEVELS = ['low', 'medium', 'high']
const REVIEW_DECISIONS = ['approve', 'reject', 'request_changes']

/**
 * POST /api/commands  [JWT]  웹 → 명령 생성
 * body: { project_id, instruction, host?, permission_mode?,
 *         task_type?, business?, customer?, risk_level?, ai_summary?, evidence?, recommended_action? }
 * 승인카드 메타(B-1)는 전부 선택. 기존 필수(project_id·instruction)는 불변.
 */
router.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { project_id, instruction, host } = body
  const permission_mode = body.permission_mode || 'allowlist'

  if (!project_id) return badRequest(c, 'project_id is required')
  if (typeof instruction !== 'string') return badRequest(c, 'instruction is required')
  const trimmed = instruction.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_INSTRUCTION_LEN) {
    return badRequest(c, `instruction must be 1~${MAX_INSTRUCTION_LEN} characters`)
  }
  if (!PERMISSION_MODES.includes(permission_mode)) {
    return badRequest(c, `permission_mode must be one of: ${PERMISSION_MODES.join(', ')}`)
  }
  // risk_level은 지정된 경우에만 검증(미지정 시 DAO에서 DEFAULT 'low').
  if (body.risk_level !== undefined && !RISK_LEVELS.includes(body.risk_level)) {
    return badRequest(c, `risk_level must be one of: ${RISK_LEVELS.join(', ')}`)
  }

  const project = await new ProjectsDao(c.env.DB).findById(project_id)
  if (!project) return notFound(c, 'Project not found')

  const created_by = c.get('user')?.sub || null
  // (설계 §3-1) direct=true → "로컬 직접 명령"(즉시 실행 의도) 자가승인. 미지정/false 는 승인함(queued).
  const direct = body.direct === true
  const dao = new CommandsDao(c.env.DB)
  const command = await dao.create({
    id: crypto.randomUUID(),
    project_id,
    host: host || null,
    instruction: trimmed,
    permission_mode,
    created_by,
    task_type: body.task_type,
    business: body.business,
    customer: body.customer,
    risk_level: body.risk_level,
    ai_summary: body.ai_summary,
    evidence: body.evidence,
    recommended_action: body.recommended_action,
    direct,
  })

  // (설계 §4·§7) direct 명령은 즉시 실행이 주경로다. 프로젝트가 비어 있으면(active command 0개)
  //   이 요청이 타겟claim('approved'→'claimed')을 따내 곧바로 dispatch 한다. 이미 실행 중이면
  //   타겟claim 이 changes()=0 으로 실패 → 'approved' 로 남아 프로젝트가 비는 대로 안전망 poll 이
  //   집어간다(active-1 불변식 준수). reviewCommandTx 의 approve 즉시디스패치와 동형 패턴.
  if (direct) {
    const claimed = c.env.DB.transaction((tx) => claimApprovedForProject(tx, command.id))
    if (claimed) {
      dispatchApprovedCommand(c.env.DB, command.id).catch((e) =>
        logActivity(c.env.DB, {
          project_id, agent_name: 'system',
          action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString(),
        }))
    }
  }
  return c.json({ command }, 201)
})

/**
 * GET /api/commands?project_id=&status=&inbox=&risk_level=&limit=&offset=  [JWT]
 * 웹 → 이력/결과 조회 + B-1 승인 대기함 목록.
 *  - inbox=pending → status='queued' AND review_status IS NULL (검토 대기)
 *  - inbox=done    → review_status IS NOT NULL (검토 완료)
 *  - risk_level    → low|medium|high (그 외 400)
 */
router.get('/', authMiddleware, async (c) => {
  const status = c.req.query('status')
  if (status && !STATUSES.includes(status)) {
    return badRequest(c, `status must be one of: ${STATUSES.join(', ')}`)
  }
  const risk_level = c.req.query('risk_level')
  if (risk_level && !RISK_LEVELS.includes(risk_level)) {
    return badRequest(c, `risk_level must be one of: ${RISK_LEVELS.join(', ')}`)
  }
  const inbox = c.req.query('inbox') // 'pending' | 'done' | undefined (그 외 값은 무시)
  const limit = Number(c.req.query('limit')) || 50
  const offset = Number(c.req.query('offset')) || 0
  const dao = new CommandsDao(c.env.DB)
  const commands = await dao.findAll({
    project_id: c.req.query('project_id'),
    status,
    inbox,
    risk_level,
    limit,
    offset,
  })
  return c.json({ commands, limit, offset })
})

/**
 * POST /api/commands/claim  [X-API-Key]  로컬 → 다음 명령 원자적 점유
 * body: { host }
 * 200 { command: {id, project_id, instruction, permission_mode} } 또는 204(없음).
 */
router.post('/claim', apiKeyMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const host = body.host || null
  const dao = new CommandsDao(c.env.DB)
  const command = await dao.claim({ host })
  if (!command) return c.body(null, 204)

  // [H-001] claim 응답에 project_path 를 실어 보내 poll 워커의 무인증 projects 조회 의존을 제거한다.
  const project = await new ProjectsDao(c.env.DB).findById(command.project_id)
  // max_turns 집행 — resolveMaxTurns 가 command.task_type 을 보고 결정한다: 사람이 개입한 명령
  //   (project_cycle 아님)은 UNLIMITED_TURNS(0, 무제한), 자율 사이클만 lead agent budget 상한(폴백 8).
  //   poll 워커가 spawn 인자(--max-turns)로 그대로 전달(0이면 --max-turns 생략).
  const maxTurns = await resolveMaxTurns(c.env.DB, command)
  return c.json({
    command: {
      id: command.id,
      project_id: command.project_id,
      project_path: project?.path || null,
      instruction: command.instruction,
      permission_mode: command.permission_mode,
      // poll 이 결과 파서를 분기하는 근거.
      //  - task_type === 'project_cycle' → /api/lead/cycle-result
      //  - 그 외(일반 커맨드)             → 추가 ingest 없음(표준 PATCH 만으로 완결, §1.4 v3 최종
      //    으로 worker-result 경로 폐지).
      task_type: command.task_type || null,
      // M-2: 워커 1태스크당 최대 턴 상한(토큰/비용 런어웨이 차단).
      max_turns: maxTurns,
      // v3(2026-07-03): 도구 화이트리스트 폐지 — 항상 null(poll 이 bypassPermissions 로 전권 실행).
      allowed_tools: resolveAllowedTools(command.task_type),
      // 이 워커에 커널 sandbox(worker.sb)를 씌울지. 항상 'sandbox'(유일한 경계). poll 이 SANDBOX_ENABLED 와 AND.
      sandbox_profile: resolveSandboxProfile(command.task_type),
      // (§9 원격 승인 재개) resume command 면 poll 이 claude --resume <sid> -p "<답변>" 로 실행하도록
      //   재개 세션 id 와 -p 페이로드를 실어 보낸다. buildResumePrompt 가 대표 답변 + 다음 라운드 신호
      //   규약(§11 후속 다중 라운드)을 함께 싣는다. resume 가 아니면 둘 다 null(신규 실행).
      resume_session_id: command.task_type === 'resume' ? (command.session_id || null) : null,
      resume_prompt: command.task_type === 'resume' ? buildResumePrompt(command.review_note) : null,
    },
  })
})

/**
 * PATCH /api/commands/:id/review  [JWT]  대표 → 승인/반려/수정요청 단일 액션. B-1.
 * body: { decision: 'approve'|'reject'|'request_changes', review_note? }
 *  - 200 { command }            검토 성공(전이 적용)
 *  - 400 잘못된 decision
 *  - 404 대상 command 없음
 *  - 409 이미 검토됨/대기상태 아님(동시성·멱등 — 조건부 UPDATE가 changes()==0)
 *
 * 실행 인프라 재설계(execution-infra-redesign.md §2.4, v3 최종): 내부 구현이
 *   CommandsDao.review()(async, HTTP 라운드트립 없음) → reviewCommandTx(동기 tx, review+타겟claim
 *   원자화) 로 교체됐다. **응답 계약(200/400/404/409, body)은 불변** — approve 시 이 요청이 타겟
 *   claim 을 따내면(claimedForSpawn) 백그라운드 실행(dispatchApprovedCommand)만 부작용으로 추가된다.
 */
router.patch('/:id/review', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const decision = body.decision
  if (!REVIEW_DECISIONS.includes(decision)) {
    return badRequest(c, `decision must be one of: ${REVIEW_DECISIONS.join(', ')}`)
  }
  const review_note = typeof body.review_note === 'string' ? body.review_note : null
  const reviewed_by = c.get('user')?.sub || null

  const dao = new CommandsDao(c.env.DB)
  const id = c.req.param('id')

  // 대상 존재 확인(없으면 404). 동시성은 reviewCommandTx의 조건부 UPDATE가 책임진다.
  const existing = await dao.findById(id)
  if (!existing) return notFound(c, 'Command not found')

  const result = c.env.DB.transaction((tx) => reviewCommandTx(tx, { id, decision, review_note, reviewed_by }))
  if (!result.command) return conflict(c, 'Command already reviewed or in terminal state')

  if (result.claimedForSpawn) {
    // fire-and-forget — HTTP 응답은 즉시 반환(§2.4: 상시 기동 Node 프로세스라 응답 후에도
    //   백그라운드 Promise 가 이벤트루프에서 계속 실행된다).
    dispatchApprovedCommand(c.env.DB, id).catch((e) =>
      logActivity(c.env.DB, {
        project_id: result.command.project_id, agent_name: 'system',
        action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString(),
      }))
  }

  return c.json({ command: result.command })
})

/**
 * PATCH /api/commands/:id  [X-API-Key]  로컬 → 실행 결과 보고 (멱등)
 * body: { status, exit_code?, result?, cost_usd?, session_id?, error? }
 */
router.patch('/:id', apiKeyMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    return badRequest(c, `status must be one of: ${STATUSES.join(', ')}`)
  }
  const dao = new CommandsDao(c.env.DB)
  const command = await dao.updateStatus(c.req.param('id'), {
    status: body.status,
    exit_code: body.exit_code,
    result: body.result,
    cost_usd: body.cost_usd,
    session_id: body.session_id,
    error: body.error,
  })
  if (!command) return notFound(c, 'Command not found')

  // (§11 후속 다중 라운드) poll 이 resume 워커 결과를 보고할 때, "또 승인 필요"(NEEDS_APPROVAL:) 신호면
  //   같은 session_id 로 새 resume command 를 승인함에 재큐잉한다(exit 0 · 세션당 라운드 상한 내).
  if (command.task_type === 'resume' && Number(body.exit_code) === 0) {
    const rq = maybeRequeueResume(c.env.DB, command, body.result)
    if (rq.requeued) {
      logActivity(c.env.DB, { project_id: command.project_id, agent_name: 'system', action: 'resume_requeue', detail: `다음 라운드 승인 필요 → command ${rq.newId} 큐잉`, created_at: new Date().toISOString() })
    }
  }
  return c.json({ command })
})

export default router
