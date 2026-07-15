import { Hono } from 'hono'
import CommandsDao from '../dao/commands.js'
import ProjectsDao from '../dao/projects.js'
import { badRequest, notFound, conflict } from '../utils/response.js'
import { authMiddleware, apiKeyMiddleware } from '../middleware/auth.js'
import { resolveAllowedTools, resolveSandboxProfile, resolveMaxTurns } from '../lib/tool-profiles.js'
import { reviewCommandTx, claimApprovedForProject } from '../lib/instant-dispatch.js'
import { dispatchApprovedCommand } from '../lib/dispatch-worker.js'
import { buildResumePrompt, maybeRequeueResume } from '../lib/resume-loop.js'
import { maybeRequeuePhase } from '../lib/phase-chain.js'
import { logActivity } from '../lib/activity-log.js'
import { execMonitor } from '../lib/exec-monitor.js'
import { sendApprovalNotification } from '../lib/push-notifier.js'
import { getProjectRole, roleAtLeast } from '../lib/project-access.js'
import { isSuperAdmin } from '../lib/roles.js'

const router = new Hono()

// instruction 최대 길이. LEAD 자기태스킹 루프의 하드닝된 프롬프트(현재 4022자, JSON-only 강제·
// mcp 금지·툴에러시에도 JSON 반환 등 안전 지침 인라인)를 정상 수용하기 위해 4000 → 8000 으로 상향.
// (이 상한을 넘던 4022자 daily-lead-cycle instruction 이 스케줄러 경로에서 400 을 받아 자율 루프가
//  조용히 멈추던 회귀를 해소 — 이슈 28876de3.) DB 컬럼(commands.instruction)은 TEXT 라 제약 없음.
// 8000 은 현재+향후 프롬프트 하드닝 여유를 주면서도 단일 명령이 무한정 커지는 남용은 막는 합리적 상한.
export const MAX_INSTRUCTION_LEN = 8000

const PERMISSION_MODES = ['allowlist', 'acceptEdits', 'bypass']
const STATUSES = ['queued', 'approved', 'claimed', 'running', 'done', 'failed', 'rejected', 'expired']
const RISK_LEVELS = ['low', 'medium', 'high']
const REVIEW_DECISIONS = ['approve', 'reject', 'request_changes']

/**
 * POST /api/commands  [JWT]  웹 → 명령 생성
 * body: { project_id, instruction, host?, permission_mode?,
 *         task_type?, business?, customer?, risk_level?, ai_summary?, evidence?, recommended_action?,
 *         options? }
 * 승인카드 메타(B-1)는 전부 선택. 기존 필수(project_id·instruction)는 불변.
 * options: 선택형 질문일 때만 [{label, description?}, ...] 배열(주 사용처는 MCP command_add이지만
 *   일관성을 위해 웹 생성 경로도 지원). 생략 시 NULL(자유텍스트 질문).
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
  // options는 지정된 경우에만 검증(배열 + 각 항목 {label:string, description?:string}).
  if (body.options !== undefined && body.options !== null) {
    const valid = Array.isArray(body.options) &&
      body.options.every((o) => o && typeof o === 'object' && typeof o.label === 'string')
    if (!valid) return badRequest(c, 'options must be an array of {label, description?}')
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
    options: body.options,
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
          project_id, command_id: command.id, agent_name: 'system',
          action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString(),
        }))
    }
  }

  // Push notification to project owner
  if (project.owner_user_id) {
    sendApprovalNotification(c.env.DB, project.owner_user_id, command).catch((e) => {
      console.error('[Push] Failed to send approval notification:', e.message)
    })
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
  // status: 단일값 또는 콤마구분 다중값(예: 'claimed,running') — 실행 모니터가 commands 테이블을
  //   "지금 실행 중"/"최근 완료" 목록의 권위 소스로 폴링하면서 IN 조건이 필요해져 확장(2026-07-14).
  //   기존 단일값 호출부(승인함 등)는 그대로 동작.
  const statusParam = c.req.query('status')
  let status = statusParam
  if (statusParam) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean)
    for (const s of statuses) {
      if (!STATUSES.includes(s)) return badRequest(c, `status must be one of: ${STATUSES.join(', ')}`)
    }
    status = statuses.length === 1 ? statuses[0] : statuses
  }
  const risk_level = c.req.query('risk_level')
  if (risk_level && !RISK_LEVELS.includes(risk_level)) {
    return badRequest(c, `risk_level must be one of: ${RISK_LEVELS.join(', ')}`)
  }
  const inbox = c.req.query('inbox') // 'pending' | 'done' | undefined (그 외 값은 무시)
  const limit = Number(c.req.query('limit')) || 50
  const offset = Number(c.req.query('offset')) || 0
  const dao = new CommandsDao(c.env.DB)
  // super_admin은 모니터링 목적으로 소유권 스코프를 건너뛴다(projects.js GET '/' 와 동일 패턴,
  // 2026-07-14 3단계 role 확장 시 이 라우트만 누락됐던 구멍 수정).
  const me = c.get('user')
  const user = isSuperAdmin(me?.role) ? undefined : me?.sub
  const commands = await dao.findAll({
    project_id: c.req.query('project_id'),
    status,
    inbox,
    risk_level,
    user,
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
      //   규약(§11 후속 다중 라운드)을 함께 싣는다. (Claude Code 웹콘솔, 2026-07-09) console 도 세션이
      //   있으면 같은 채팅 세션을 이어받아야 하므로 resume_session_id 대상에 포함한다 — 단 resume_prompt
      //   래핑은 resume 전용으로 유지(console 은 poll 이 command.instruction 원문을 그대로 쓰게 둔다,
      //   bin/lib/poll-commands.js 의 promptText 폴백 참고).
      resume_session_id: (command.task_type === 'resume' || command.task_type === 'console') && command.session_id
        ? command.session_id : null,
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
 * 실행 인프라 재설계(execution-infra-redesign.md §2.4): 내부 구현이 CommandsDao.review()(async,
 *   HTTP 라운드트립 없음) → reviewCommandTx(동기 tx) 로 교체됐다. **응답 계약(200/400/404/409, body)은
 *   불변.** ⚠️ 2026-07-13 대표 결정("자율실행은 메인루프를 통해서만"): approve 시 웹서버가 즉시
 *   claim+dispatchApprovedCommand 하던 부작용을 제거했다 — status='approved'로만 남고, 실행은 항상
 *   engine/safety-poll.js 가 다음 엔진 틱(최대 60초)에 집어가 엔진 프로세스 안에서 수행한다.
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

  // 소유권 체크(2026-07-14) — /approvals 화면의 핵심 mutation(승인/반려/수정요청)에 접근제어가
  //   없으면 GET /commands 에서 목록을 숨겨도 command id 를 다른 경로로 알아낸 사용자가 남의
  //   프로젝트 커맨드를 승인/반려할 수 있었다(조회는 막고 쓰기는 열려있던 구멍). PUT /:id/autonomy
  //   와 동일하게 editor 이상(소유자 또는 editor 공유자)만 허용 — viewer 는 승인 액션 불가.
  //   project_id 는 스키마상 NOT NULL(실측 0건 예외)이지만, 혹시 못 찾으면(project 삭제 등)
  //   role 판정이 자연히 null 이 되어 동일하게 404 로 막힌다(별도 분기 불필요).
  const project = existing.project_id ? await new ProjectsDao(c.env.DB).findById(existing.project_id) : null
  const role = await getProjectRole(c.env.DB, project, reviewed_by)
  if (!roleAtLeast(role, 'editor')) return notFound(c, 'Command not found')

  const result = c.env.DB.transaction((tx) => reviewCommandTx(tx, { id, decision, review_note, reviewed_by }))
  if (!result.command) return conflict(c, 'Command already reviewed or in terminal state')

  // Push notification to project owner about approval decision. project는 위 소유권 체크에서
  // 이미 조회했다(project_id는 review로 바뀌지 않으므로 재조회 불필요).
  if (project?.owner_user_id) {
    sendApprovalNotification(c.env.DB, project.owner_user_id, result.command).catch((e) => {
      console.error('[Push] Failed to send approval notification:', e.message)
    })
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

  // poll 경로(별도 프로세스 bin/loop.js)의 실행을 execMonitor에 반영 — poll은 execMonitor 싱글턴을
  // 공유하지 않으므로, 상태 변경 보고(PATCH /:id) 시점에 서버 측에서 직접 갱신한다.
  // dispatch-worker.js(서버 직접 실행)는 PATCH /:id를 호출하지 않으므로 중복 이벤트 없음.
  if (body.status === 'running' && !execMonitor.active.has(command.id)) {
    const proj = command.project_id ? await new ProjectsDao(c.env.DB).findById(command.project_id) : null
    execMonitor.start(command.id, {
      projectId: command.project_id || null,
      projectName: proj ? (proj.name || proj.path?.split('/').pop() || '?') : '?',
      instruction: (command.instruction || '').slice(0, 200),
      taskType: command.task_type || 'direct',
    })
  } else if (body.status === 'done' || body.status === 'failed') {
    execMonitor.end(command.id, body.status, { costUsd: body.cost_usd ?? null })
  }

  // (§11 후속 다중 라운드) poll 이 resume 워커 결과를 보고할 때, "또 승인 필요"(NEEDS_APPROVAL:) 신호면
  //   같은 session_id 로 새 resume command 를 승인함에 재큐잉한다(exit 0 · 세션당 라운드 상한 내).
  if (command.task_type === 'resume' && Number(body.exit_code) === 0) {
    const rq = maybeRequeueResume(c.env.DB, command, body.result)
    if (rq.requeued) {
      logActivity(c.env.DB, { project_id: command.project_id, command_id: command.id, agent_name: 'system', action: 'resume_requeue', detail: `다음 라운드 승인 필요 → command ${rq.newId} 큐잉`, created_at: new Date().toISOString() })
    }
  }

  // (단계 자동 이어달리기, 안전망 poll 경로) 워커가 "NEXT_PHASE:" 신호로 끝났으면 다음 단계 command 를
  //   자가승인 생성 + 즉시 클레임 시도한다. project_cycle/resume 은 함수 내부에서 자동 no-op.
  if (Number(body.exit_code) === 0) {
    const pc = maybeRequeuePhase(c.env.DB, command, body.result)
    if (pc.requeued) {
      logActivity(c.env.DB, { project_id: command.project_id, command_id: command.id, agent_name: 'system', action: 'phase_chain_create', detail: `다음 단계 command ${pc.newId} 생성${pc.claimed ? ' (즉시 실행)' : ' (프로젝트 실행 중 → 안전망 poll 대기)'}`, created_at: new Date().toISOString() })
      if (pc.claimed) {
        dispatchApprovedCommand(c.env.DB, pc.newId).catch((e) =>
          logActivity(c.env.DB, { project_id: command.project_id, command_id: pc.newId, agent_name: 'system', action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString() }))
      }
    } else if (pc.reason) {
      logActivity(c.env.DB, { project_id: command.project_id, command_id: command.id, agent_name: 'system', action: 'phase_chain_skip', detail: pc.reason, created_at: new Date().toISOString() })
    }
  }
  return c.json({ command })
})

/**
 * PATCH /api/commands/:id/terminate  [JWT]  명령 강제 종료 (running/claimed 상태만 가능)
 * running 상태로 멈춰있는 명령을 강제 실패로 표시해 뒤의 명령들을 unblock.
 */
router.patch('/:id/terminate', authMiddleware, async (c) => {
  const id = c.req.param('id')
  if (!id) return badRequest(c, 'id is required')

  const command = await new CommandsDao(c.env.DB).findById(id)
  if (!command) return notFound(c, 'Command not found')

  // 프로젝트 소유자 또는 editor 공유자만 강제 종료 가능. role(admin/user)과 무관하게
  // owner_user_id/project_collaborators 소유권 기준으로만 판정한다(전역 관리자 전체보기 없음 —
  // 기존 `project.owner_id !== user?.sub && user?.role !== 'admin'` 검사는 스키마에 없는
  // owner_id 컬럼을 참조해 사실상 항상 첫 조건이 true였고 role='admin' 이면 소유권 무관하게
  // 통과하던 버그였다. 두 계정 모두 role=admin이라 사실상 무력화되어 있었다).
  const user = c.get('user')
  const project = await new ProjectsDao(c.env.DB).findById(command.project_id)
  const role = await getProjectRole(c.env.DB, project, user?.sub)
  if (!roleAtLeast(role, 'editor')) {
    return c.json({ error: 'Unauthorized' }, 403)
  }

  // running/claimed 상태만 종료 가능
  if (!['running', 'claimed', 'approved'].includes(command.status)) {
    return conflict(c, `Cannot terminate command in ${command.status} status`)
  }

  const now = new Date().toISOString()
  const updated = c.env.DB.transaction((tx) => {
    tx.prepare(`
      UPDATE commands
      SET status='failed', error='Forcefully terminated by user', updated_at=?
      WHERE id=?
    `).bind(now, id).run()
    return tx.prepare('SELECT * FROM commands WHERE id=?').bind(id).first()
  })

  if (updated) {
    execMonitor.end(updated.id, 'failed', { costUsd: null })
  }

  logActivity(c.env.DB, {
    project_id: command.project_id,
    command_id: id,
    agent_name: user?.sub || 'unknown',
    action: 'command_terminate',
    detail: `명령 ${id} 강제 종료 (이전 상태: ${command.status})`,
    created_at: now,
  })

  return c.json({ command: updated })
})

/**
 * POST /api/commands/:id/retry  [JWT]  실패 명령 재실행 — 새 command row 생성(원본은 mutate하지 않음).
 *
 * 설계 결정(2026-07-14 대표 지시로 변경 — direct:true 자가승인):
 *  - editor 이상 권한자가 "재실행" 버튼을 누른 행위 자체가 승인이다 — 승인함(queued)에 다시 올려
 *    이중 승인을 요구하지 않는다. §3-1 "로컬 직접 명령"과 동일하게 dao.create({direct:true})로
 *    자가승인('approved')하고, §7 active-1이 비어 있으면 즉시 클레임+디스패치까지 시도한다
 *    (프로젝트 상세 "작업 카드 만들기" direct:true 전환과 동일 정책, decision `ea7a0ad1`).
 *  - session_id 있으면 §9 resume 인프라 재사용(task_type='resume', 원본 session_id 그대로).
 *  - session_id 없으면 처음부터 재실행(instruction/host/permission_mode/business/customer/risk_level
 *    클론, task_type도 클론하되 원본이 'resume'이면 null 폴백).
 *  - §7 active-1 불변식: 같은 project_id에 claimed/running 이 있으면 409(재실행 row 자체를 만들지 않음).
 *  - 재실행 계보는 retry_of_id(신규 컬럼)로만 추적 — parent_command_id/root_command_id는 phase-chain의
 *    MAX_PHASE_ROUNDS 카운트를 오염시키므로 재사용하지 않는다.
 */
router.post('/:id/retry', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const dao = new CommandsDao(c.env.DB)
  const command = await dao.findById(id)
  if (!command) return notFound(c, 'Command not found')

  const user = c.get('user')
  const project = command.project_id ? await new ProjectsDao(c.env.DB).findById(command.project_id) : null
  const role = await getProjectRole(c.env.DB, project, user?.sub)
  if (!roleAtLeast(role, 'editor')) {
    return c.json({ error: 'Unauthorized' }, 403)
  }

  if (command.status !== 'failed') {
    return conflict(c, `Cannot retry command in ${command.status} status`)
  }

  // §7 active-1 불변식: 같은 프로젝트에 이미 진행 중인 명령이 있으면 재실행 row 자체를 만들지 않는다.
  const active = await c.env.DB.prepare(
    `SELECT id FROM commands WHERE project_id=? AND status IN ('claimed','running') LIMIT 1`
  ).bind(command.project_id).first()
  if (active) {
    return conflict(c, '프로젝트에 이미 진행 중인 명령이 있어 재실행할 수 없습니다')
  }

  const created_by = user?.sub || null
  const baseTitle = (command.title || command.instruction || '').slice(0, 80)
  const hasSession = !!command.session_id

  const fields = hasSession
    ? {
        // §9 resume 인프라 재사용. instruction은 승인함 카드 표시용 설명 텍스트만 — 실제 재개 프롬프트는
        // buildResumePrompt(review_note)가 담당(resume-loop.js).
        instruction: '[재실행] 이전 세션이 실패했습니다. 이어서 진행해주세요.',
        host: null,
        permission_mode: 'allowlist',
        business: null,
        customer: null,
        task_type: 'resume',
        session_id: command.session_id,
      }
    : {
        // 세션 시작 전 실패 → 처음부터 재실행. 원본 필드 클론.
        instruction: command.instruction,
        host: command.host,
        permission_mode: command.permission_mode,
        business: command.business,
        customer: command.customer,
        task_type: command.task_type === 'resume' ? null : command.task_type,
        session_id: null,
      }

  const newCommand = await dao.create({
    id: crypto.randomUUID(),
    project_id: command.project_id,
    created_by,
    risk_level: command.risk_level || 'low',
    title: `[재실행] ${baseTitle}`,
    retry_of_id: command.id,
    direct: true,
    ...fields,
  })

  // (§3-1과 동일 패턴) 자가승인된 명령은 즉시 실행이 주경로다. 프로젝트가 비어 있으면 타겟클레임을
  // 따내 곧바로 dispatch. 이미 뭔가 실행 중이면(위 §7 체크 이후 경합 발생 등) 'approved'로 남아
  // 안전망 poll/엔진이 프로젝트가 비는 대로 집어간다.
  const claimed = c.env.DB.transaction((tx) => claimApprovedForProject(tx, newCommand.id))
  if (claimed) {
    dispatchApprovedCommand(c.env.DB, newCommand.id).catch((e) =>
      logActivity(c.env.DB, {
        project_id: command.project_id, command_id: newCommand.id, agent_name: 'system',
        action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString(),
      }))
  }

  logActivity(c.env.DB, {
    project_id: command.project_id,
    command_id: newCommand.id,
    agent_name: created_by || 'unknown',
    action: 'command_retry',
    detail: `원본 명령 ${command.id} → 재실행 명령 ${newCommand.id} 자가승인 생성 (session_id ${hasSession ? '있음, resume' : '없음, 처음부터'})`,
    created_at: new Date().toISOString(),
  })

  if (project?.owner_user_id) {
    sendApprovalNotification(c.env.DB, project.owner_user_id, newCommand).catch((e) => {
      console.error('[Push] Failed to send approval notification:', e.message)
    })
  }

  return c.json({ command: newCommand }, 201)
})

export default router
