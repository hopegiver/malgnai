import { Hono } from 'hono'
import { readdirSync, statSync, existsSync, createReadStream, readFileSync, rmSync } from 'node:fs'
import { join, normalize, basename, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import ProjectsDao from '../dao/projects.js'
import CollaboratorsDao from '../dao/collaborators.js'
import ClaudeDao from '../dao/claude.js'
import { AUTONOMOUS_KINDS } from '../dao/init.js'
import { notFound, badRequest, conflict } from '../utils/response.js'
import { apiKeyMiddleware, authMiddleware } from '../middleware/auth.js'
import { derivedProjectKey } from '../utils/project-key.js'
import { taskTypeToCategory, commandStatusToResult } from '../lib/activity-normalize.js'
import { logActivity } from '../lib/activity-log.js'
import { cadenceInterval, nextRunAtIso, CADENCE_VALUES } from '../lib/cadence.js'
import { RISK_APPROVAL_THRESHOLD_VALUES, KPI_COMPLETE_ACTION_VALUES } from '../lib/autonomy.js'
import { PROJECT_STATUS_VALUES, normalizeProjectStatus, PROJECT_STATUS_CHANGE_ACTION, projectStatusChangeDetail } from '../lib/project-status.js'
import { scaffoldProject, validateProjectName } from '../lib/scaffold-project.js'
import { getMonitorableProject, getProjectRole, roleAtLeast } from '../lib/project-access.js'
import { isSuperAdmin } from '../lib/roles.js'

const router = new Hono()

// bin/sync-projects.js 와 동일한 워크스페이스 루트 규약(맥/리눅스=~/workspace, WORKSPACE_DIR로 override 가능).
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || join(homedir(), 'workspace')

// 파일 목록에서 제외할 폴더(scan-projects와 동일 기준 + 일반 빌드/캐시 폴더).
const FILE_EXCLUDES = new Set(['node_modules', '.git', '.cache', '.tmp', 'dist', '.next', '.nuxt'])

// 다운로드 허용 확장자(요청 사양: zip/pptx/pdf). 그 외 확장자는 다운로드 거부.
// 다운로드 허용 확장자 — 산출물(문서/슬라이드/스프레드시트/압축/이미지 등) 전반.
// 소스코드/텍스트는 모달 미리보기(VIEWABLE)로, 바이너리 산출물은 다운로드로 분리.
const DOWNLOAD_MIME = {
  // 압축
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.apk': 'application/vnd.android.package-archive',
  // 문서
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.hwp': 'application/x-hwp',
  '.hwpx': 'application/haansofthwpx',
  // 이미지
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}
const DOWNLOADABLE = new Set(Object.keys(DOWNLOAD_MIME))

// 모달로 미리보기(텍스트 읽기) 허용 확장자. md 외 일반 텍스트/코드도 함께 허용.
const VIEWABLE = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.vue', '.css',
  '.html', '.yml', '.yaml', '.toml', '.sh', '.env', '.log', '.csv', '.xml',
])
// 텍스트 읽기 상한(바이너리/거대 파일 보호). 1MB.
const MAX_VIEW_BYTES = 1024 * 1024

// 프로젝트 루트(절대경로 정규화). path가 없거나 존재하지 않으면 null.
function projectRoot(project) {
  if (!project || !project.path) return null
  const root = normalize(project.path)
  return existsSync(root) ? root : null
}

// 요청된 상대경로를 프로젝트 루트 안으로 가두어 절대경로로 환원. 탈출 시 null.
function resolveInside(root, relPath) {
  const target = normalize(join(root, relPath || ''))
  // 루트 자신 또는 루트 하위만 허용(디렉터리 탈출 방지).
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

// 프로젝트별 자율 "effective ON" 판정 — autonomy.js isProjectAutonomyEnabled 와 동일 기준.
//   autonomy_enabled='1' && cadence!='off' && lead_agent_name 존재. (표시/응답 일관성용.)
function isProjectAutonomyOn(p) {
  if (!p) return false
  const flag = p.autonomy_enabled
  const on = flag === '1' || flag === 'true' || flag === 'on' || flag === 1 || flag === true
  if (!on) return false
  if (p.cadence && String(p.cadence).toLowerCase() === 'off') return false
  if (!p.lead_agent_name) return false
  return true
}

// 프로젝트 "가동 상태"(activity_status) — 실시간 파생 신호, DB에 저장하지 않는다.
//   기존 projects.status(라이프사이클: pending/active/completed/on_hold)는 "사람의 의도/단계"이고,
//   이 값은 "지금 AI가 실제로 돌고 있는가"를 뜻한다(둘은 직교). 목록/상세의 라이브 배지가 이걸 쓴다.
//   - 'off'     정지    : 자율 스위치가 effective OFF (isProjectAutonomyOn=false)
//   - 'running' 가동중  : 자율 ON + 최근 한 주기(=cadence 간격×2, 1회 누락 허용) 안에 실행됨
//   - 'stalled' 점검필요: 자율 ON + next_run_at 이 한 주기 넘게 지났는데 안 돎(루프 미전진 → 이상)
//   - 'idle'    대기    : 자율 ON + 아직 첫 실행 전이거나 다음 주기 대기(정상)
function projectActivityStatus(p) {
  if (!isProjectAutonomyOn(p)) return 'off'
  const now = Date.now()
  const interval = cadenceInterval(p.cadence)
  const last = p.last_run_at ? Date.parse(p.last_run_at) : NaN
  if (Number.isFinite(last) && (now - last) <= interval * 2) return 'running'
  const next = p.next_run_at ? Date.parse(p.next_run_at) : NaN
  if (Number.isFinite(next) && (now - next) > interval) return 'stalled'
  return 'idle'
}

// 프로젝트 응답에 파생 필드(autonomy_active, activity_status)를 함께 실어 목록/상세 표현을 일원화.
function withDerived(p) {
  return { ...p, autonomy_active: isProjectAutonomyOn(p), activity_status: projectActivityStatus(p) }
}

// 경로의 마지막 세그먼트(폴더명)를 추출. `/`·`\` 양쪽 구분자와 끝 슬래시 처리.
// 예) "/Users/hopegiver/workspace/malgnai" → "malgnai", "g:\\workspace\\malgnai" → "malgnai"
function pathBasename(p) {
  if (!p) return null
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || null
}

// ── 통합 타임라인(§4) 정규화 헬퍼 ──
// task_type→category / status→result 매핑은 activity-normalize.js 단일 소스에서 import(m-4 복제 제거).
// links_json(문자열) → 배열. 파싱 불가면 빈 배열.
function parseLinks(json) {
  if (!json) return []
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : [] } catch { return [] }
}

// [H-001] (갱신 2026-07-14) 이 주석은 stale이었다 — 로그인 흐름이 이제 있으므로 authMiddleware를
//   붙인다. 사용자별 프로젝트 격리(owner_user_id/project_collaborators)가 API 레벨 요구사항이 되어
//   무인증 전체조회는 더 이상 허용되지 않는다. role(admin/user) 무관하게 소유권 기준으로만 필터한다.
//   ⚠️ (2026-07-14 3단계 role 확장) 유일한 예외 — role='super_admin'은 모니터링 목적으로 소유권
//   무관하게 전체 프로젝트를 본다(findAll에 user를 넘기지 않으면 필터를 건너뜀, 읽기 전용).
router.get('/', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const status = c.req.query('status')
  const kind = c.req.query('kind') // 'dev' | '업무' | undefined(전체). Phase 3 업무 대시보드 구분용.
  const me = c.get('user')
  const user = isSuperAdmin(me?.role) ? undefined : me?.sub
  const projects = await dao.findAll(status, 50, 0, kind, user)
  // 목록에서도 자율운행 여부/가동상태를 바로 보여주기 위해 파생 판정을 함께 실어 보낸다(단일소스 withDerived).
  return c.json({ projects: projects.map(withDerived) })
})

// 업무 대시보드(Phase 3) — 자율 유형 프로젝트 + 태스크 집계 + 열린 이슈 수를 한 번에.
// 업무별 카드에 goal/kpi_json/lead_agent_name/autonomy 상태와 진행 지표를 함께 그린다.
// distributed 정합: 업무 대시보드 = "자율 운영 중인 프로젝트" 관제 화면. 스폰 엔진(spawn-due)의
//   due 후보 집합과 동일 기준으로 나열한다 — kind ∈ AUTONOMOUS_KINDS 이고 프로젝트 자율 스위치가 켜진 것.
//   (특정 kind 하나만 보던 옛 'internal_ops' 고정 필터는 제거. dev 등 다수 kind 도 자율 ON 이면 잡힌다.)
//   자율 OFF 프로젝트는 여기 안 뜨고, 자율 설정은 프로젝트 상세에서 켠다. next_run/cadence 세부는 카드가 표기.
router.get('/workspaces', authMiddleware, async (c) => {
  const db = c.env.DB
  const me = c.get('user')
  const user = me?.sub
  const superAdmin = isSuperAdmin(me?.role)
  const kindPlaceholders = AUTONOMOUS_KINDS.map(() => '?').join(',')
  // owner/collaborator 스코핑 — 현재 사용자의 소유 또는 공유받은 프로젝트만. 협업자 조회를
  // 프로젝트별로(N+1) 하지 않고 이 WHERE 서브쿼리 하나로 SQL 레벨에서 처리한다.
  // ⚠️ super_admin은 모니터링 목적으로 이 조건을 건너뛰고 전체를 본다(읽기 전용).
  const ownerClause = superAdmin
    ? ''
    : ' AND (owner_user_id = ? OR id IN (SELECT project_id FROM project_collaborators WHERE user = ?))'
  const bindArgs = superAdmin ? [...AUTONOMOUS_KINDS] : [...AUTONOMOUS_KINDS, user, user]
  const projects = (await db.prepare(
    `SELECT * FROM projects
       WHERE kind IN (${kindPlaceholders})
         AND (autonomy_enabled='1' OR autonomy_enabled='true' OR autonomy_enabled='on')${ownerClause}
       ORDER BY updated_at DESC LIMIT 100`
  ).bind(...bindArgs).all()).results

  // 자율 마스터 스위치(업무 카드의 "자율상태" 배지에 반영).
  const autoRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'autonomy_enabled'").first()
  const autonomyEnabled = autoRow
    ? (autoRow.value === '1' || autoRow.value === 'true' || autoRow.value === 'on')
    : false

  // 각 업무의 태스크 집계 + 열린 이슈 수. 프로젝트 수가 적어(업무=소수) N+1 이 문제되지 않음.
  const enriched = await Promise.all(projects.map(async (p) => {
    // 실행 인프라 재설계(§1.6, v3 최종): tasks/commands 완전 통합 — 집계 소스를 commands 로 교체.
    //   kind 필터 없음(§0.3-2) — "그 프로젝트의 체크리스트 완료율"에서 "전체 커맨드 완료율"로 의미
    //   변화(완전 통합의 자연스러운 결과, §0.3-3). 4상태 매핑은 §1.3 표 그대로 SQL CASE 로 이식.
    const t = (await db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('queued','approved') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status IN ('failed','rejected','expired') THEN 1 ELSE 0 END) AS failed
         FROM commands WHERE project_id = ?`
    ).bind(p.id).first()) || {}
    const iss = (await db.prepare(
      `SELECT SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM issues WHERE project_id = ?`
    ).bind(p.id).first()) || {}
    return {
      ...withDerived(p),
      tasks: {
        total: t.total || 0,
        pending: t.pending || 0,
        in_progress: t.in_progress || 0,
        done: t.done || 0,
        failed: t.failed || 0,
      },
      open_issues: iss.open || 0,
    }
  }))

  return c.json({ workspaces: enriched, autonomy_enabled: autonomyEnabled })
})

router.get('/:id', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const project = await getMonitorableProject(c.env.DB, dao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')
  return c.json({ project: withDerived(project) })
})

// 프로젝트의 Claude Code 작업 이력(세션) 목록
router.get('/:id/sessions', authMiddleware, async (c) => {
  const projectsDao = new ProjectsDao(c.env.DB)
  const project = await getMonitorableProject(c.env.DB, projectsDao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  // 폴더명(basename)으로 매칭 — OS/머신 이주로 절대경로 키가 바뀌어도 이력 유지.
  const folder = pathBasename(project.path)
  if (!folder) return c.json({ sessions: [] })

  const claudeDao = new ClaudeDao(c.env.DB)
  const sessions = await claudeDao.findProjectSessionsByName(folder, {
    limit: Number(c.req.query('limit')) || 100,
    offset: Number(c.req.query('offset')) || 0,
  })
  return c.json({ sessions })
})

// 프로젝트 개요 통계 — 작업/이슈/명령/맥락 카운트를 한 번에 집계해 '개요' 탭에 표시.
// 여러 테이블을 작은 COUNT 쿼리로 모아 단일 응답으로 반환(상세페이지 첫 진입 시 1회 호출).
router.get('/:id/summary', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const id = c.req.param('id')
  const project = await getMonitorableProject(c.env.DB, dao, id, c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  const db = c.env.DB
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || {}

  const [taskRow, issueRow, cmdRow, decRow, memRow, lastAct] = await Promise.all([
    // 실행 인프라 재설계(§1.6, v3 최종): tasks/commands 완전 통합 — commands 기반 집계로 교체(§1.3 매핑).
    one(`SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN status IN ('queued','approved') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status IN ('failed','rejected','expired') THEN 1 ELSE 0 END) AS failed
         FROM commands WHERE project_id = ?`, id),
    one(`SELECT
           SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
           COUNT(*) AS total
         FROM issues WHERE project_id = ?`, id),
    one(`SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('queued','approved','claimed','running') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(COALESCE(cost_usd,0)) AS cost_usd
         FROM commands WHERE project_id = ?`, id),
    one(`SELECT COUNT(*) AS total FROM decisions WHERE project_id = ?`, id),
    one(`SELECT COUNT(*) AS total FROM memories WHERE project_id = ?`, id),
    one(`SELECT created_at FROM activity_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`, id),
  ])

  const tasksTotal = taskRow.total || 0
  const progress = tasksTotal ? Math.round(((taskRow.completed || 0) / tasksTotal) * 100) : 0

  return c.json({
    summary: {
      tasks: {
        total: tasksTotal,
        completed: taskRow.completed || 0,
        in_progress: taskRow.in_progress || 0,
        pending: taskRow.pending || 0,
        failed: taskRow.failed || 0,
        progress,
      },
      issues: { open: issueRow.open || 0, total: issueRow.total || 0 },
      commands: {
        total: cmdRow.total || 0,
        active: cmdRow.active || 0,
        failed: cmdRow.failed || 0,
        cost_usd: cmdRow.cost_usd || 0,
      },
      decisions: decRow.total || 0,
      memories: memRow.total || 0,
      last_activity_at: lastAct.created_at || null,
    },
  })
})

// 프로젝트 통합 타임라인(§4) — activity_logs + claude_project_sessions + commands 를
// **읽기 시점 UNION**(ETL 복제 없음)으로 한 시간축에 조립한다. 3원천 Promise.allSettled 병렬,
// 부분실패 허용(실패 원천은 sources_failed 로 표기).
//   GET /api/projects/:id/timeline?limit=&before=&include_telemetry=&sources=
//   - before: ts 커서(모든 원천 ts < before). limit: 병합 후 상한(기본 50, 200 클램프).
//   - include_telemetry=1 이면 activity 의 telemetry 도 포함(기본 제외).
//   - sources: 콤마 구분으로 원천 제한(예: sources=activity,command). 기본 전체.
//   §10 M1: command 원천은 무조건 요약 title(instruction 앞 120자)·status·result 만 노출(전문 금지).
router.get('/:id/timeline', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const id = c.req.param('id')
  const project = await getMonitorableProject(c.env.DB, dao, id, c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')
  const db = c.env.DB

  let limit = parseInt(c.req.query('limit'), 10)
  if (Number.isNaN(limit) || limit <= 0) limit = 50
  limit = Math.min(limit, 200)
  const before = c.req.query('before') || null
  const includeTelemetry = ['1', 'true', 'on', 'yes'].includes((c.req.query('include_telemetry') || '').toLowerCase())
  const PER_SOURCE = 100 // 각 원천에서 넉넉히 뽑아 병합 후 상한 컷.

  // 실행 인프라 재설계(§1.6, v3 최종): tasks/commands 완전 통합 — 'task' 소스 제거(4→3원천).
  //   commands 는 이제 사람이 만든 작업 카드/로컬 명령과 AI proposal/사이클 스폰을 전부 포함하므로
  //   'command' 소스 하나로 이미 그 프로젝트의 전체 실행 이력을 대표한다(중복 소스가 무의미해짐).
  const ALL_SOURCES = ['activity', 'session', 'command']
  const sourcesParam = c.req.query('sources')
  const wanted = sourcesParam
    ? sourcesParam.split(',').map((s) => s.trim()).filter((s) => ALL_SOURCES.includes(s))
    : ALL_SOURCES
  const active = wanted.length ? wanted : ALL_SOURCES

  const folder = pathBasename(project.path)
  const projectKey = derivedProjectKey(project.path)

  const q = {
    // activity_logs — 새 구조 컬럼 그대로. WHERE project_id=?.
    activity: async () => {
      const conds = ['project_id = ?']
      const vals = [id]
      if (!includeTelemetry) conds.push(`level IN ('work','audit')`)
      if (before) { conds.push('created_at < ?'); vals.push(before) }
      vals.push(PER_SOURCE)
      const rows = (await db.prepare(
        `SELECT * FROM activity_logs WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
      ).bind(...vals).all()).results
      return rows.map((r) => ({
        source: 'activity', id: r.id, ts: r.created_at,
        level: r.level || 'work', category: r.category || null,
        title: r.title || (r.detail ? String(r.detail).slice(0, 120) : r.action),
        target_ref: r.target_ref || null, result: r.result || null,
        agent_name: r.agent_name,
        links: parseLinks(r.links_json),
        meta: { action: r.action, correlation_id: r.correlation_id || null, command_id: r.command_id || null },
      }))
    },
    // claude_project_sessions — 정확일치(project_key=derived) 우선. **결과 0건일 때만** basename
    //   접미사 fallback(§4.2). ⚠️ M-1: 무조건 OR 결합 금지 — 정확일치가 성공했는데도 basename 이
    //   함께 돌면 경로가 다른 동일 폴더명(예: 다른 위치의 web/api) 프로젝트의 세션·first_prompt 가
    //   섞여 정확성/정보노출 버그가 된다. (scratchpad 등은 접두사가 달라 접미사 매칭에서 자연 배제.)
    session: async () => {
      const runQuery = async (whereKey, keyVals) => {
        const conds = [whereKey]
        const vals = [...keyVals]
        if (before) { conds.push('started_at < ?'); vals.push(before) }
        vals.push(PER_SOURCE)
        return (await db.prepare(
          `SELECT * FROM claude_project_sessions WHERE ${conds.join(' AND ')} ORDER BY started_at DESC LIMIT ?`
        ).bind(...vals).all()).results
      }
      let rows = []
      if (projectKey) rows = await runQuery('project_key = ?', [projectKey]) // 1) 정확일치 우선
      if (rows.length === 0 && folder) {
        // 2) 정확일치 0건일 때만 basename 접미사 fallback(경로 이주/OS 차이 대비).
        rows = await runQuery(`LOWER(project_key) LIKE ? ESCAPE '\\'`,
          ['%-' + String(folder).toLowerCase().replace(/[\\%_]/g, '\\$&')])
      }
      return rows.map((r) => ({
        source: 'session', id: r.id, ts: r.started_at,
        level: 'work', category: 'build',
        title: r.title || r.first_prompt || '(대화 세션)',
        target_ref: null, result: null, agent_name: 'claude-code',
        links: [],
        meta: {
          message_count: r.message_count, tool_count: r.tool_count,
          git_branch: r.git_branch, ended_at: r.ended_at, project_key: r.project_key,
        },
      }))
    },
    // commands — WHERE project_id=?. M1: instruction 요약 title·status·result 만(전문 금지).
    //   실행 인프라 재설계(§1.6, v3 최종): title 컬럼 추가 SELECT — 있으면 title, 없으면 instruction
    //   앞 120자로 폴백(사람이 만든 커맨드(작업 카드/로컬 명령)와 AI가 만든 커맨드를 구분 없이 표시,
    //   kind 컬럼 없음 §0.3-4). 'task' 소스는 완전 통합으로 제거됨(4→3원천, §1.6).
    command: async () => {
      const conds = ['project_id = ?']
      const vals = [id]
      if (before) { conds.push('created_at < ?'); vals.push(before) }
      vals.push(PER_SOURCE)
      const rows = (await db.prepare(
        `SELECT id, task_type, status, cost_usd, exit_code, instruction, title, created_at
           FROM commands WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
      ).bind(...vals).all()).results
      return rows.map((r) => ({
        source: 'command', id: r.id, ts: r.created_at,
        level: 'work', category: taskTypeToCategory(r.task_type),
        title: r.title || (r.instruction ? String(r.instruction).slice(0, 120) : (r.task_type || '(명령)')),
        target_ref: r.task_type ? 'task_type:' + r.task_type : null,
        result: commandStatusToResult(r.status),
        agent_name: null, links: [],
        meta: { status: r.status, cost_usd: r.cost_usd ?? null, exit_code: r.exit_code ?? null },
      }))
    },
  }

  const settled = await Promise.allSettled(active.map((s) => q[s]()))
  const events = []
  const counts = {}
  const sources_failed = []
  active.forEach((s, i) => {
    const r = settled[i]
    if (r.status === 'fulfilled') { events.push(...r.value); counts[s] = r.value.length }
    else { sources_failed.push(s); counts[s] = 0 }
  })
  // ts DESC merge-sort 후 상한 컷.
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  const timeline = events.slice(0, limit)

  return c.json({ timeline, sources_failed, counts })
})

// 프로젝트 폴더 안의 파일/하위폴더 목록(1단계). ?path= 로 하위 폴더 탐색.
// 로컬 Node 서버라 파일시스템 직접 접근. 경로는 항상 프로젝트 루트 안으로 가둔다.
router.get('/:id/files', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const project = await getMonitorableProject(c.env.DB, dao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  const root = projectRoot(project)
  if (!root) return c.json({ path: '', entries: [], available: false })

  const rel = c.req.query('path') || ''
  const dir = resolveInside(root, rel)
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    return badRequest(c, 'Invalid path')
  }

  let names
  try {
    names = readdirSync(dir)
  } catch {
    return c.json({ path: rel, entries: [], available: true })
  }

  const entries = []
  for (const name of names) {
    if (name.startsWith('.') || FILE_EXCLUDES.has(name)) continue
    let st
    try { st = statSync(join(dir, name)) } catch { continue }
    const isDir = st.isDirectory()
    const ext = isDir ? '' : extname(name).toLowerCase()
    entries.push({
      name,
      // 루트 기준 상대경로(다음 탐색/다운로드에 그대로 사용). 슬래시로 통일.
      path: (rel ? rel.replace(/\\/g, '/') + '/' : '') + name,
      is_dir: isDir,
      size: isDir ? null : st.size,
      updated_at: st.mtime.toISOString(),
      downloadable: !isDir && DOWNLOADABLE.has(ext),
      viewable: !isDir && VIEWABLE.has(ext) && st.size <= MAX_VIEW_BYTES,
    })
  }
  // 폴더 먼저, 그다음 이름순.
  entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))

  return c.json({ path: rel.replace(/\\/g, '/'), entries, available: true })
})

// 프로젝트 폴더 안의 파일 다운로드. zip/pptx/pdf 만 허용.
router.get('/:id/download', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const project = await getMonitorableProject(c.env.DB, dao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  const root = projectRoot(project)
  if (!root) return notFound(c, 'Project folder not found')

  const rel = c.req.query('file')
  if (!rel) return badRequest(c, 'file is required')

  const target = resolveInside(root, rel)
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    return notFound(c, 'File not found')
  }

  const ext = extname(target).toLowerCase()
  if (!DOWNLOADABLE.has(ext)) return badRequest(c, 'File type not downloadable')

  const name = basename(target)
  const stream = createReadStream(target)
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': DOWNLOAD_MIME[ext] || 'application/octet-stream',
      'Content-Length': String(statSync(target).size),
      // RFC 5987 filename* 로 한글/공백 파일명 안전 전달.
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
})

// 프로젝트 폴더 안의 텍스트 파일 내용 읽기(모달 미리보기용). md/txt/코드 등만 허용.
router.get('/:id/file', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const project = await getMonitorableProject(c.env.DB, dao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!project) return notFound(c, 'Project not found')

  const root = projectRoot(project)
  if (!root) return notFound(c, 'Project folder not found')

  const rel = c.req.query('file')
  if (!rel) return badRequest(c, 'file is required')

  const target = resolveInside(root, rel)
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    return notFound(c, 'File not found')
  }

  const ext = extname(target).toLowerCase()
  if (!VIEWABLE.has(ext)) return badRequest(c, 'File type not viewable')
  const st = statSync(target)
  if (st.size > MAX_VIEW_BYTES) return badRequest(c, 'File too large to preview')

  const content = readFileSync(target, 'utf8')
  return c.json({
    name: basename(target), path: rel.replace(/\\/g, '/'), ext,
    size: st.size, updated_at: st.mtime.toISOString(), content,
  })
})

// 프로젝트명 = 워크스페이스 폴더명(전역 CLAUDE.md 규약). 클라이언트가 경로를 지정하지 않고,
// 서버가 ~/workspace/<name> 에 표준 스캐폴드(STATUS.md/CLAUDE.md/docs/README.md/.claude/doc-drift.json/
// package.json + git init)를 실제로 생성한다. 한글 등 표시용 이름은 description 에 담는다.
// ※ 이 규칙은 웹에서 신규 생성하는 경로에만 적용된다 — bin/sync-projects.js 가 기존 폴더를 스캔해
//   등록하는 `/sync`(upsert) 경로는 이미 존재하는 폴더를 그대로 인식하므로 별도(큐레이션 한글명 보존).
// (2026-07-14 정정) authMiddleware 추가 — 아래 "P0: owner 자동 귀속" 주석은 JWT sub 로 owner 를
//   채우는 걸 전제하는데, 미들웨어 없이는 c.get('user') 가 항상 undefined라 그 로직이 죽은 코드였다
//   (신규 프로젝트가 전부 owner_user_id=NULL 로 생성되어, 소유권 기반 필터가 적용된 GET /:id 등에서
//   생성자 본인에게도 안 보이는 회귀). 실제 호출부(app/pages/projects.vue)는 이미 로그인 흐름을
//   거쳐 항상 Authorization 헤더를 싣고 있어 이 변경으로 깨지는 정상 경로는 없다.
router.post('/', authMiddleware, async (c) => {
  const body = await c.req.json()
  if (!body.name) return badRequest(c, 'name is required')
  const nameError = validateProjectName(body.name)
  if (nameError) return badRequest(c, nameError)
  if (body.kind !== undefined && !AUTONOMOUS_KINDS.includes(body.kind)) {
    return badRequest(c, `kind must be one of: ${AUTONOMOUS_KINDS.join(', ')}`)
  }
  const dao = new ProjectsDao(c.env.DB)
  const id = crypto.randomUUID()
  const root = join(WORKSPACE_DIR, body.name)
  try {
    scaffoldProject(root, body.name, body.description, id, body.kind)
  } catch (e) {
    return badRequest(c, e.message)
  }
  // P0: owner 자동 귀속 — JWT sub(=username, 블로커 B1) 로 소유자 부여. body 가 owner_user_id 를
  //   명시하면(관리자 대리생성 등) 그 값을 우선한다. JWT 없는 경로(X-API-Key sync 등)면 owner 미부여(NULL).
  const ownerFromJwt = c.get('user')?.sub || null
  const owner_user_id = body.owner_user_id ?? ownerFromJwt ?? undefined
  const { path: _clientPath, ...rest } = body
  // autonomy_enabled 는 PROJECT_EXT_COLS 를 거쳐 그대로 바인딩되므로, PUT /:id/autonomy 와 동일하게
  // boolean 을 '1'/'0' 로 변환해야 한다(better-sqlite3 는 boolean 바인딩 불가 → TypeError).
  if (rest.autonomy_enabled !== undefined) rest.autonomy_enabled = rest.autonomy_enabled ? '1' : '0'
  let project
  try {
    project = await dao.create({ id, ...rest, path: root, ...(owner_user_id !== undefined ? { owner_user_id } : {}) })
  } catch (e) {
    // DB 삽입 실패 시 방금 만든 폴더를 롤백해 고아 폴더가 남지 않게 한다.
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 무시 */ }
    throw e  // Hono 글로벌 에러 핸들러로 전파 (500)
  }
  return c.json({ project }, 201)
})

// (2026-07-14 Critical H-1 수정) 이 라우트는 authMiddleware도, 소유권 체크도 없었고
//   ProjectsDao.update()가 body를 PROJECT_EXT_COLS 화이트리스트 그대로 SET하는데 거기 owner_user_id가
//   포함돼 있어 로그인한 아무 사용자나 PUT /:id body에 {owner_user_id:'자기계정'}을 실어 보내면
//   프로젝트 소유권을 통째로 탈취할 수 있었다(이번에 추가한 다른 모든 접근제어의 우회로).
//   authMiddleware + editor 이상 체크(없으면 404, 다른 :id 라우트와 동일 기준)를 추가하고,
//   owner_user_id는 이 범용 수정 라우트로는 아예 변경 불가하게 화이트리스트에서 제거한다
//   (소유권 이전은 이번 스코프에 없는 별도 기능 — 지금은 막아둔다).
router.put('/:id', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const id = c.req.param('id')
  const existing = await dao.findById(id)
  if (!existing) return notFound(c, 'Project not found')
  const role = await getProjectRole(c.env.DB, existing, c.get('user')?.sub)
  if (!roleAtLeast(role, 'editor')) return notFound(c, 'Project not found')

  const body = await c.req.json().catch(() => ({}))
  delete body.owner_user_id // mass-assignment로 소유권 탈취 차단(H-1) — 소유권 이전은 별도 기능으로 후속.
  const project = await dao.update(id, body)
  if (!project) return notFound(c, 'Project not found')
  return c.json({ project })
})

// ── 프로젝트별 자율 설정(결정 a77ecedd) — 목표/KPI/관찰 LEAD/박동주기/자율 on-off ──
//
//  GET  /api/projects/:id/autonomy  [JWT]  현재 프로젝트 자율 설정 조회.
//  PUT  /api/projects/:id/autonomy  [JWT]  설정 저장(부분 갱신).
//
// JWT 필수(운영자 액션). authMiddleware 를 라우트에 직접 붙여 origin(로컬/CF) 무관하게 인증 강제
//   → 무JWT 는 항상 401(task 요구사항). 자율 on/off 표현 = projects.autonomy_enabled('1'|'0').
//   cadence='off' 도 정지로 취급(게이트/스케줄러가 동일하게 skip).
router.get('/:id/autonomy', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const p = await getMonitorableProject(c.env.DB, dao, c.req.param('id'), c.get('user')?.sub, c.get('user')?.role)
  if (!p) return notFound(c, 'Project not found')
  return c.json({
    autonomy: {
      project_id: p.id,
      name: p.name,
      kind: p.kind,
      goal: p.goal ?? null,
      kpi_json: p.kpi_json ?? null,
      custom_instruction: p.custom_instruction ?? null,
      lead_agent_name: p.lead_agent_name ?? null,
      cadence: p.cadence ?? null,
      autonomy_level: p.autonomy_level ?? null,
      // 프로젝트별 자율 on/off — cadence='off' 도 OFF 로 반영(effective).
      autonomy_enabled: isProjectAutonomyOn(p),
      autonomy_enabled_raw: p.autonomy_enabled ?? null,
      risk_approval_threshold: p.risk_approval_threshold ?? null,
      kpi_complete_action: p.kpi_complete_action ?? 'continue',
    },
  })
})

router.put('/:id/autonomy', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const id = c.req.param('id')
  const existing = await dao.findById(id)
  if (!existing) return notFound(c, 'Project not found')
  // 자율 설정 변경은 소유자 또는 editor 공유자만(viewer는 조회만). 접근권 없음/viewer는
  // 존재 자체를 숨긴다(404) — 이 파일 다른 라우트와 동일한 정보누출 방지 방침.
  const role = await getProjectRole(c.env.DB, existing, c.get('user')?.sub)
  if (!roleAtLeast(role, 'editor')) return notFound(c, 'Project not found')

  const body = await c.req.json().catch(() => ({}))
  const fields = {}

  // goal(문자열|null 로 비우기 허용).
  if (body.goal !== undefined) {
    if (body.goal !== null && typeof body.goal !== 'string') return badRequest(c, 'goal must be a string or null')
    fields.goal = body.goal
  }

  // kpi_json — 객체/배열이면 직렬화, 문자열이면 JSON 유효성 검사, null 은 비우기.
  if (body.kpi_json !== undefined) {
    if (body.kpi_json === null) {
      fields.kpi_json = null
    } else if (typeof body.kpi_json === 'string') {
      try { JSON.parse(body.kpi_json) } catch { return badRequest(c, 'kpi_json must be valid JSON') }
      fields.kpi_json = body.kpi_json
    } else if (typeof body.kpi_json === 'object') {
      fields.kpi_json = JSON.stringify(body.kpi_json)
    } else {
      return badRequest(c, 'kpi_json must be a JSON object/string or null')
    }
  }

  // custom_instruction — 프로젝트별 자유 텍스트 추가 지시(문자열|null). 화이트리스트 없음(자유 텍스트).
  //   project-cycle-prompt.js 가 (2) 진화가능 본문 뒤에 보충으로 주입한다.
  if (body.custom_instruction !== undefined) {
    if (body.custom_instruction !== null && typeof body.custom_instruction !== 'string') {
      return badRequest(c, 'custom_instruction must be a string or null')
    }
    fields.custom_instruction = body.custom_instruction
  }

  // lead_agent_name — 반드시 실재 agent(agents.name). null 은 LEAD 해제(→ 자율 자동 OFF 취급).
  if (body.lead_agent_name !== undefined) {
    if (body.lead_agent_name === null || body.lead_agent_name === '') {
      fields.lead_agent_name = null
    } else if (typeof body.lead_agent_name !== 'string') {
      return badRequest(c, 'lead_agent_name must be a string or null')
    } else {
      const agent = await c.env.DB.prepare('SELECT name FROM agents WHERE name = ?').bind(body.lead_agent_name).first()
      if (!agent) return badRequest(c, `lead_agent_name '${body.lead_agent_name}' is not a registered agent`)
      fields.lead_agent_name = body.lead_agent_name
    }
  }

  // cadence — enum(every15m/every30m/hourly/daily/weekly/off). 'off' = 정지.
  if (body.cadence !== undefined) {
    if (body.cadence === null) {
      fields.cadence = null
    } else if (typeof body.cadence !== 'string' || !CADENCE_VALUES.includes(body.cadence)) {
      return badRequest(c, `cadence must be one of: ${CADENCE_VALUES.join(', ')}`)
    } else {
      fields.cadence = body.cadence
    }
    // next_run_at 즉시 재계산(issue 083809e3) — 안 하면 옛 cadence로 계산된 next_run_at이 그대로
    // 남아, 그 예약 시각이 도달할 때까지(최대 옛 주기 하나만큼) 새 cadence가 반영되지 않는다.
    fields.next_run_at = nextRunAtIso(fields.cadence, new Date())
  }

  // autonomy_level(선택, 자유 라벨 — 게이트엔 미영향, 표시/메타용).
  if (body.autonomy_level !== undefined) {
    if (body.autonomy_level !== null && typeof body.autonomy_level !== 'string') {
      return badRequest(c, 'autonomy_level must be a string or null')
    }
    fields.autonomy_level = body.autonomy_level
  }

  // risk_approval_threshold — 'off'(risk-blind)|'low'|'medium'|'high'|'critical'. null = 컬럼 초기화(=off 와 동일 효과).
  if (body.risk_approval_threshold !== undefined) {
    if (body.risk_approval_threshold === null) {
      fields.risk_approval_threshold = null
    } else if (typeof body.risk_approval_threshold !== 'string' || !RISK_APPROVAL_THRESHOLD_VALUES.includes(body.risk_approval_threshold)) {
      return badRequest(c, `risk_approval_threshold must be one of: ${RISK_APPROVAL_THRESHOLD_VALUES.join(', ')}`)
    } else {
      fields.risk_approval_threshold = body.risk_approval_threshold
    }
  }

  // kpi_complete_action — 'continue'(기본, 모든 KPI 달성해도 자율운영 유지)|'off'(기존 동작, 자동 종료).
  //   null = 컬럼 초기화(=continue 와 동일 효과, DEFAULT 'continue').
  if (body.kpi_complete_action !== undefined) {
    if (body.kpi_complete_action === null) {
      fields.kpi_complete_action = null
    } else if (typeof body.kpi_complete_action !== 'string' || !KPI_COMPLETE_ACTION_VALUES.includes(body.kpi_complete_action)) {
      return badRequest(c, `kpi_complete_action must be one of: ${KPI_COMPLETE_ACTION_VALUES.join(', ')}`)
    } else {
      fields.kpi_complete_action = body.kpi_complete_action
    }
  }

  // 자율 on/off — boolean 을 '1'/'0' 으로 저장. (게이트 2단화의 프로젝트 스위치 단일 소스.)
  if (body.autonomy_enabled !== undefined) {
    if (typeof body.autonomy_enabled !== 'boolean') return badRequest(c, 'autonomy_enabled must be a boolean')
    fields.autonomy_enabled = body.autonomy_enabled ? '1' : '0'
  }

  // ⚠️ fail-safe 안전 검사: autonomy_enabled 를 켜려는데 LEAD 가 없으면(기존/신규 모두) 거부.
  //   LEAD 없이 자율 ON 은 무의미(사이클 생성 불가) — 불명확한 활성화를 원천 차단.
  const willBeOn = fields.autonomy_enabled === '1'
    || (fields.autonomy_enabled === undefined && (existing.autonomy_enabled === '1' || existing.autonomy_enabled === 1))
  const effLead = fields.lead_agent_name !== undefined ? fields.lead_agent_name : existing.lead_agent_name
  if (willBeOn && !effLead) {
    return badRequest(c, 'autonomy_enabled requires a lead_agent_name (관찰 LEAD 를 먼저 지정하세요)')
  }

  if (Object.keys(fields).length === 0) return badRequest(c, 'no autonomy fields provided')

  const project = await dao.update(id, fields)
  // 감사로그 — 자율 설정 변경 이력(누가/무엇을). 단일 관문 — project_autonomy_update 는
  //   normalizeLevel 이 level=audit 로 분류(설정변경, 사람이 알아야 함).
  try {
    logActivity(c.env.DB, {
      project_id: id, agent_name: c.get('user')?.sub || 'web',
      action: 'project_autonomy_update', detail: JSON.stringify(fields),
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }

  return c.json({
    autonomy: {
      project_id: project.id,
      name: project.name,
      kind: project.kind,
      goal: project.goal ?? null,
      kpi_json: project.kpi_json ?? null,
      custom_instruction: project.custom_instruction ?? null,
      lead_agent_name: project.lead_agent_name ?? null,
      cadence: project.cadence ?? null,
      autonomy_level: project.autonomy_level ?? null,
      autonomy_enabled: isProjectAutonomyOn(project),
      autonomy_enabled_raw: project.autonomy_enabled ?? null,
      risk_approval_threshold: project.risk_approval_threshold ?? null,
      kpi_complete_action: project.kpi_complete_action ?? 'continue',
    },
  })
})

// ── 라이프사이클 상태 변경(운영자 액션) — 사람이 명시적으로 대기/진행/완료/보류 전환 ──
//   projects.status(라이프사이클)는 이제 이 명시적 액션으로만 바뀐다(sync·자율루프는 안 건드림).
//   가동상태(activity_status)와 직교 — 여긴 "사람의 단계 의도"만 다룬다.
//   JWT 필수(autonomy 와 동일 posture, PUT /:id 무인증 우회 대신 이 검증경로 사용).
//   AI 에이전트 경로(MCP project_status_set)와 허용값·검증·감사포맷을 lib/project-status.js 로 공유한다.
router.put('/:id/status', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const body = await c.req.json().catch(() => ({}))
  const status = normalizeProjectStatus(body.status)
  if (!status) {
    return badRequest(c, `status must be one of: ${PROJECT_STATUS_VALUES.join(', ')}`)
  }
  const existing = await dao.findById(c.req.param('id'))
  if (!existing) return notFound(c, 'Project not found')
  const role = await getProjectRole(c.env.DB, existing, c.get('user')?.sub)
  if (!roleAtLeast(role, 'editor')) return notFound(c, 'Project not found')
  const project = await dao.update(existing.id, { status })
  // 감사로그 — 라이프사이클 전이(누가·무엇에서·무엇으로). 실패해도 본 동작은 막지 않음.
  try {
    logActivity(c.env.DB, {
      project_id: existing.id, agent_name: c.get('user')?.sub || 'web',
      action: PROJECT_STATUS_CHANGE_ACTION,
      detail: projectStatusChangeDetail(existing.status, status),
    })
  } catch { /* 감사 실패 무시 */ }
  return c.json({ project: withDerived(project) })
})

// ── 프로젝트 공유(협업자) 관리 (이슈 bfe2bf02 — DAO/테이블은 이미 있었으나 API 라우트가 없어
//   실제로 공유를 추가/해제할 방법이 없던 갭. 이제 이 3개 라우트로 배선한다) ──
//
//  GET    /api/projects/:id/collaborators        [JWT, owner]  공유 목록 조회
//  POST   /api/projects/:id/collaborators        [JWT, owner]  공유 추가/역할 변경 { user, role }
//  DELETE /api/projects/:id/collaborators/:user  [JWT, owner]  공유 해제
//
// 소유자만 공유를 관리한다(editor가 제3자에게 접근권을 위임하는 체인은 범위 밖 — 필요해지면
//   별도 결정으로 확장). 존재하지 않거나 소유자가 아니면 404(이 파일의 기존 정보누출 방지 방침과 동일).
router.get('/:id/collaborators', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const existing = await dao.findById(c.req.param('id'))
  if (!existing) return notFound(c, 'Project not found')
  if (existing.owner_user_id !== c.get('user')?.sub) return notFound(c, 'Project not found')
  const collaborators = await new CollaboratorsDao(c.env.DB).listByProject(existing.id)
  return c.json({ collaborators })
})

router.post('/:id/collaborators', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const existing = await dao.findById(c.req.param('id'))
  if (!existing) return notFound(c, 'Project not found')
  if (existing.owner_user_id !== c.get('user')?.sub) return notFound(c, 'Project not found')
  const body = await c.req.json().catch(() => ({}))
  const user = typeof body.user === 'string' ? body.user.trim() : ''
  if (!user) return badRequest(c, 'user is required')
  if (user === existing.owner_user_id) return badRequest(c, 'owner already has full access')
  const collabDao = new CollaboratorsDao(c.env.DB)
  const role = await collabDao.share(existing.id, user, body.role) // share() 내부에서 viewer/editor 만 허용
  try {
    logActivity(c.env.DB, {
      project_id: existing.id, agent_name: c.get('user')?.sub || 'web',
      action: 'project_share_add', detail: `owner=${existing.owner_user_id} shared user=${user} role=${role}`,
    })
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  return c.json({ collaborator: { project_id: existing.id, user, role } })
})

router.delete('/:id/collaborators/:user', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const existing = await dao.findById(c.req.param('id'))
  if (!existing) return notFound(c, 'Project not found')
  if (existing.owner_user_id !== c.get('user')?.sub) return notFound(c, 'Project not found')
  const user = c.req.param('user')
  const removed = await new CollaboratorsDao(c.env.DB).unshare(existing.id, user)
  if (removed) {
    try {
      logActivity(c.env.DB, {
        project_id: existing.id, agent_name: c.get('user')?.sub || 'web',
        action: 'project_share_remove', detail: `owner=${existing.owner_user_id} unshared user=${user}`,
      })
    } catch { /* 감사 실패는 본 동작을 막지 않음 */ }
  }
  return c.json({ removed })
})

// 워크스페이스 폴더 일괄 동기화
router.post('/sync', apiKeyMiddleware, async (c) => {
  const { projects, workspace_dir } = await c.req.json()
  if (!Array.isArray(projects)) return badRequest(c, 'projects array is required')
  const dao = new ProjectsDao(c.env.DB)
  const results = []
  for (const p of projects) {
    if (!p.name) continue
    const project = await dao.upsert(p)
    results.push(project)
  }
  // workspace_dir 스캔 결과에서 이번엔 안 보인 프로젝트 = 폴더가 사라졌다고 보고 소프트delete.
  // workspace_dir 하위 경로를 가진 것만 대상으로 좁혀, 그 밖 경로로 등록된 프로젝트는 건드리지 않는다.
  const deletedIds = []
  if (workspace_dir) {
    const prefix = normalize(workspace_dir).replace(/[\\/]+$/, '') + '/'
    const incomingIds = new Set(results.map(p => p.id))
    const candidates = await dao.findByPathPrefix(prefix)
    for (const cand of candidates) {
      if (incomingIds.has(cand.id)) continue
      await dao.update(cand.id, { status: 'deleted' })
      deletedIds.push(cand.id)
    }
  }
  return c.json({ projects: results, synced: results.length, deleted: deletedIds })
})

// (2026-07-14 Critical H-2 수정) authMiddleware도 소유권 체크도 없어 로그인한 아무 사용자나
//   남의 프로젝트를 삭제할 수 있었다. editor 이상만 허용(다른 :id 라우트와 동일 기준).
//   존재하지 않는 id는 기존 계약(200 {deleted:false}, 테스트에 명시된 멱등 삭제 의미론)을 그대로
//   유지 — "존재하는데 권한 없음"만 404로 막는다(있는데 남의 것 vs 아예 없음을 구분하는 정보노출은
//   "삭제 자체가 막힌다"는 훨씬 큰 구멍에 비하면 감수 가능한 트레이드오프).
router.delete('/:id', authMiddleware, async (c) => {
  const dao = new ProjectsDao(c.env.DB)
  const id = c.req.param('id')
  const existing = await dao.findById(id)
  if (!existing) return c.json({ deleted: false })
  const role = await getProjectRole(c.env.DB, existing, c.get('user')?.sub)
  if (!roleAtLeast(role, 'editor')) return notFound(c, 'Project not found')
  try {
    const deleted = await dao.delete(id)
    return c.json({ deleted })
  } catch (e) {
    // dao.delete()의 ACTIVE_COMMAND 가드(2026-07-14) — 진행 중인 워커 실행이 있으면 삭제 거부.
    if (e.code === 'ACTIVE_COMMAND') {
      return conflict(c, '진행 중인 명령이 있어 프로젝트를 삭제할 수 없습니다. 완료 후 다시 시도하세요.')
    }
    throw e
  }
})

export default router
