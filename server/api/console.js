/**
 * console.js — Claude Code 웹콘솔(사람이 프로젝트 컨텍스트로 Claude와 멀티턴 채팅) API.
 *
 * commands 테이블을 그대로 재사용한다(task_type='console'). 한 턴 = command 1행. 세션은
 *   session_id 로 묶인다(첫 턴은 session_id 없이 신규 실행 → 워커가 반환한 session_id 를
 *   PATCH /api/commands/:id 가 저장 → 이후 턴은 그 session_id 를 실어 --resume 으로 이어붙인다).
 *
 * 실행 경로는 기존 "로컬 직접 명령"(direct:true)과 100% 동일(server/api/commands.js POST / 참고) —
 *   자가승인('approved')으로 태워 즉시 타겟claim → 성공하면 dispatchApprovedCommand fire-and-forget,
 *   실패(프로젝트 이미 실행 중)하면 'approved' 로 남아 안전망 poll 이 걷어간다.
 *
 * interactive 플래그(worker-exec.js/tool-profiles.js)로 채팅 중엔 STAGED_EXECUTION_PROMPT의
 *   NEXT_PHASE 자동 이어달리기 및 coo 페르소나 강제를 끈다(§3/§4/§5 참고) — 자유 대화 UX 보호.
 */
import { Hono } from 'hono'
import CommandsDao from '../dao/commands.js'
import ProjectsDao from '../dao/projects.js'
import { badRequest, notFound, conflict } from '../utils/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { claimApprovedForProject } from '../lib/instant-dispatch.js'
import { dispatchApprovedCommand } from '../lib/dispatch-worker.js'
import { logActivity } from '../lib/activity-log.js'
import { MAX_INSTRUCTION_LEN } from './commands.js'
import { getMonitorableProject } from '../lib/project-access.js'

const router = new Hono()

const TERMINAL_STATUSES = ['done', 'failed', 'rejected', 'expired']

/**
 * POST /api/console/turns  [JWT]  새 턴(채팅 메시지) 생성 — 신규 세션 또는 기존 세션 이어받기.
 * body: { project_id, message, session_id?, idempotency_key? }
 *
 * (등록 방식) bin/scan.js 가 server/api/console.js 를 스캔해 이 라우터 전체를 /api/console 에
 *   마운트한다(commands.js/monitor.js 와 동일 패턴 — 파일당 1 mount, 그 안에서 하위 경로로 분기).
 *   그래서 여기서는 최상위 '/' 가 아니라 '/turns' 로 등록해 전체 경로가 /api/console/turns 가 되게 한다.
 */
router.post('/turns', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { project_id, message, session_id, idempotency_key } = body

  if (!project_id) return badRequest(c, 'project_id is required')
  if (typeof message !== 'string') return badRequest(c, 'message is required')
  const trimmed = message.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_INSTRUCTION_LEN) {
    return badRequest(c, `message must be 1~${MAX_INSTRUCTION_LEN} characters`)
  }

  const created_by = c.get('user')?.sub || null
  const project = await getMonitorableProject(c.env.DB, new ProjectsDao(c.env.DB), project_id, created_by, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  const id = crypto.randomUUID()

  // 리뷰 2026-07-09 Major-2/3 대응:
  //   Major-3 — "직전 턴 terminal 확인 + INSERT"를 단일 트랜잭션으로 묶어 TOCTOU 를 차단한다
  //     (claimApprovedForProject/reviewCommandTx 와 동형: 동기 tx 콜백 안에서 SELECT→분기→INSERT).
  //   Major-2 — 동일 idempotency_key 재전송은 UNIQUE 충돌을 잡아 기존 row 를 그대로 반환한다
  //     (phase-chain.js/cycle-ingest.js 의 "INSERT try/catch UNIQUE" 관례를 그대로 따름 — 500 방지).
  const outcome = c.env.DB.transaction((tx) => createConsoleTurnTx(tx, {
    id,
    project_id,
    instruction: trimmed,
    session_id: session_id || null,
    idempotency_key: idempotency_key || null,
    created_by,
  }))

  if (outcome.notFound) return notFound(c, 'Session not found')
  if (outcome.conflict) return conflict(c, 'Previous turn in this session is still in progress')
  if (!outcome.command) return conflict(c, 'Could not create turn (concurrent request conflict), please retry')

  // direct:true 와 동형인 즉시-claim(신규 생성 + claim 성공한 경우에만 fire-and-forget 디스패치).
  //   재전송(idempotent replay)이면 이미 첫 호출에서 디스패치됐으므로 다시 트리거하지 않는다.
  if (outcome.created && outcome.claimed) {
    dispatchApprovedCommand(c.env.DB, outcome.command.id).catch((e) =>
      logActivity(c.env.DB, {
        project_id, command_id: outcome.command.id, agent_name: 'system',
        action: 'instant_dispatch_error', detail: e.message, created_at: new Date().toISOString(),
      }))
  }

  return c.json({ command: outcome.command }, outcome.created ? 201 : 200)
})

/**
 * createConsoleTurnTx — POST /turns 의 "직전 턴 확인 + INSERT + claim"을 단일 트랜잭션으로 원자화.
 *   동기 tx 콜백 안에서만 호출한다(instant-dispatch.js 의 claimApprovedForProject/reviewCommandTx 와
 *   동형 패턴 — tx.prepare().bind().run()/.first() 는 D1 호환 동기 파사드).
 *
 * @returns {{command: object|null, created: boolean, claimed: boolean, notFound?: boolean, conflict?: boolean}}
 *   notFound  → session_id 지정됐는데 해당 세션의 턴이 하나도 없음(호출부는 404).
 *   conflict  → 직전 턴이 아직 종결 상태가 아님(호출부는 409).
 *   created=false, command!=null → idempotency_key 재전송(신규 아님, 호출부는 200 으로 기존 row 반환).
 *   created=true → 신규 턴 생성(호출부는 201). claimed 는 이 호출이 실행권을 땄는지.
 */
function createConsoleTurnTx(tx, { id, project_id, instruction, session_id, idempotency_key, created_by }) {
  // idempotency 선조회: 이미 이 키로 생성된 턴이 있으면 그대로 반환(신규 생성 시도조차 하지 않음).
  if (idempotency_key) {
    const existing = tx.prepare('SELECT * FROM commands WHERE idempotency_key = ?').bind(idempotency_key).first()
    if (existing) return { command: existing, created: false, claimed: false }
  }

  // 기존 세션에 이어붙이는 경우: 그 세션의 최신 턴이 아직 진행 중이면 새 턴을 받지 않는다
  //   (동시에 두 메시지가 같은 세션을 --resume 하면 세션 상태가 꼬인다). SELECT 와 INSERT 가
  //   같은 트랜잭션 안에 있으므로(better-sqlite3 tx 는 단일 커넥션 직렬 실행) 이 확인과 아래
  //   INSERT 사이에 다른 요청이 끼어들 수 없다(Major-3).
  if (session_id) {
    const last = tx.prepare(
      `SELECT status FROM commands WHERE project_id = ? AND task_type = 'console' AND session_id = ?
        ORDER BY created_at DESC LIMIT 1`
    ).bind(project_id, session_id).first()
    if (!last) return { command: null, created: false, notFound: true }
    if (!TERMINAL_STATUSES.includes(last.status)) return { command: null, created: false, conflict: true }
  }

  const now = new Date().toISOString()
  try {
    // direct:true(CommandsDao.create 와 동형) — 자가승인('approved') + task_type='console'.
    tx.prepare(
      `INSERT INTO commands (id, project_id, instruction, status, permission_mode, created_by, created_at, updated_at,
                             task_type, risk_level, review_status, reviewed_by, reviewed_at, session_id, idempotency_key)
       VALUES (?, ?, ?, 'approved', 'allowlist', ?, ?, ?, 'console', 'low', 'approved', ?, ?, ?, ?)`
    ).bind(
      id, project_id, instruction, created_by || null, now, now,
      created_by || 'web', now, session_id || null, idempotency_key || null,
    ).run()
  } catch (e) {
    if (!/UNIQUE/i.test(e?.message || '') || !idempotency_key) throw e
    // 경합: 동시에 들어온 같은 idempotency_key 요청이 방금 먼저 커밋했다 — 그 결과를 그대로 반환.
    const existing = tx.prepare('SELECT * FROM commands WHERE idempotency_key = ?').bind(idempotency_key).first()
    if (!existing) throw e
    return { command: existing, created: false, claimed: false }
  }

  const claimed = claimApprovedForProject(tx, id, 'server-immediate')
  const command = tx.prepare('SELECT * FROM commands WHERE id = ?').bind(id).first()
  return { command, created: true, claimed }
}

/**
 * GET /api/console/sessions?project_id=&limit=&offset=  [JWT]  프로젝트의 콘솔 세션 목록(최신순, 기본 10개).
 *   프론트가 "더보기"로 offset 을 늘려가며 다음 페이지를 요청한다(무한 누적 방지).
 */
router.get('/sessions', authMiddleware, async (c) => {
  const project_id = c.req.query('project_id')
  if (!project_id) return badRequest(c, 'project_id is required')
  const project = await getMonitorableProject(c.env.DB, new ProjectsDao(c.env.DB), project_id, c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')
  const limit = Math.min(Math.max(parseInt(c.req.query('limit'), 10) || 10, 1), 100)
  const offset = Math.max(parseInt(c.req.query('offset'), 10) || 0, 0)
  const dao = new CommandsDao(c.env.DB)
  const { sessions, has_more } = await dao.findConsoleSessions(project_id, { limit, offset })
  return c.json({ sessions, has_more })
})

/**
 * GET /api/console/sessions/:session_id/turns?project_id=  [JWT]  세션의 전체 턴(시간순).
 */
router.get('/sessions/:session_id/turns', authMiddleware, async (c) => {
  const project_id = c.req.query('project_id')
  if (!project_id) return badRequest(c, 'project_id is required')
  const project = await getMonitorableProject(c.env.DB, new ProjectsDao(c.env.DB), project_id, c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')
  const session_id = c.req.param('session_id')
  const dao = new CommandsDao(c.env.DB)
  const turns = await dao.findConsoleTurns(project_id, session_id)
  if (!turns.length) return notFound(c, 'Session not found')
  return c.json({ turns })
})

/**
 * GET /api/console/turns/:id?project_id=  [JWT]  단일 턴 조회(폴링용 — 상태/결과 확인).
 *
 * 리뷰 2026-07-09 Major-1: 이 파일의 다른 3개 엔드포인트와 동일하게 project_id 스코핑을 강제한다
 *   (project_id 없으면 400, 조회된 turn 의 project_id 가 불일치하면 404 — 다른 프로젝트의 턴을
 *   추측 가능한 id 만으로 조회할 수 있던 갭을 막는다).
 */
router.get('/turns/:id', authMiddleware, async (c) => {
  const project_id = c.req.query('project_id')
  if (!project_id) return badRequest(c, 'project_id is required')
  const project = await getMonitorableProject(c.env.DB, new ProjectsDao(c.env.DB), project_id, c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')
  const dao = new CommandsDao(c.env.DB)
  const command = await dao.findById(c.req.param('id'))
  if (!command || command.task_type !== 'console' || command.project_id !== project_id) {
    return notFound(c, 'Turn not found')
  }
  return c.json({ turn: command })
})

export default router
