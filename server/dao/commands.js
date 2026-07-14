/**
 * CommandsDao — 웹→로컬 명령 실행 파이프라인의 명령 큐(inbox) DAO.
 *
 * 상태 머신: queued|approved → claimed → running → done|failed (또는 rejected|expired)
 * claim()은 D1 단일 statement 조건부 UPDATE로 원자적 점유(이중 실행 방지)를 보장한다.
 * (§3-3) claim()은 'approved'만 집는다 — 'queued'는 held(승인/게이트 대기)의 유일 의미.
 * (§3-1) create({direct:true})는 사람이 즉시 실행 의도로 낸 "로컬 직접 명령"을 자가승인
 *   ('approved' + review_status='approved')으로 태워, 승인함을 거치지 않고 실행 경로에 올린다.
 *
 * P3(2026-07-03): 실행 규칙 엔진(rules.js/evaluate) 제거 — 최소안전 3종(킬스위치·프로젝트on/off·
 *   일일비용상한, server/lib/autonomy.js)에는 task_type별 forbid/auto 분기가 없다. 그 결과 웹에서
 *   만드는 명령은 기본 status='queued'(승인 대기)로 생성된다(fail-safe). B-3 정기업무 스케줄러
 *   (createScheduled)는 scheduler 자체가 P4 로 제거되어 함께 삭제.
 *   예외(§3-1): create({direct:true}) "로컬 직접 명령"은 자가승인('approved')으로 태운다.
 */
/**
 * withOptions — DB row의 `options_json`(TEXT)을 `options` 필드(배열|null)로 파싱해 붙인다.
 * (2026-07-14) 승인함 "선택형 질문" 계약: options_json은 JSON 배열 문자열 [{label, description?}, ...]
 *   또는 NULL(자유텍스트 질문). 파싱 실패도 안전하게 null로 폴백 — API 응답이 절대 깨지지 않게 한다.
 *   원본 options_json 컬럼은 응답에서 제거(중복 표현 방지, 소비자는 options만 보면 됨).
 */
function withOptions(row) {
  if (!row) return row
  const { options_json, ...rest } = row
  let options = null
  if (options_json) {
    try {
      const parsed = JSON.parse(options_json)
      options = Array.isArray(parsed) ? parsed : null
    } catch {
      options = null
    }
  }
  return { ...rest, options }
}

export default class CommandsDao {
  constructor(db) { this.db = db }

  async create({
    id, project_id, host, instruction, permission_mode, created_by,
    // B-1 승인카드 메타(전부 선택). 미지정 시 NULL(risk_level은 DB DEFAULT 'low').
    task_type, business, customer, risk_level,
    ai_summary, evidence, recommended_action,
    // 실행 인프라 재설계(§1.2, v3 최종) — tasks/commands 완전 통합 신규 컬럼(전부 선택, nullable).
    // title: "작업 카드" 폼 제출 전용(그 외 출처는 NULL 허용, 읽을 때 instruction 앞 120자로 폴백).
    // assignee_agent_name: "담당자" 표시 전용(실행 바인딩 아님). parent/root_command_id·level: 계보.
    title, assignee_agent_name, parent_command_id, root_command_id, level,
    // (설계 §3-1) direct=true: "로컬 직접 명령"(사람이 즉시 실행 의도로 지시) → 자가승인으로 태운다.
    //   status='approved' + review_status='approved' + reviewed_by(=created_by). 승인함(queued)을
    //   건너뛰고 곧바로 안전망 poll(claim은 'approved'만 집음, §3-3)/즉시디스패치가 실행한다.
    //   미지정/false 이면 기존대로 'queued'(승인 대기, fail-safe).
    direct,
    // Claude Code 웹콘솔(2026-07-09): session_id — 이어받을 세션(없으면 새 세션=NULL, 콘솔 라우터가
    //   기존 대화를 이어갈 때 지정). idempotency_key — 이미 있는 컬럼(UNIQUE WHERE NOT NULL, schema.sql
    //   idx_commands_idem)을 이 범용 create()에도 노출해 중복 재전송을 DB 레벨에서 안전하게 막는다.
    session_id, idempotency_key,
    // (2026-07-14) 선택형 질문 옵션. [{label, description?}, ...] 배열이면 그대로 JSON 직렬화해 저장,
    //   미지정/빈 배열이면 NULL(자유텍스트 질문).
    options,
  }) {
    const now = new Date().toISOString()
    const status = direct ? 'approved' : 'queued'
    const review_status = direct ? 'approved' : null
    const reviewed_by = direct ? (created_by || 'web') : null
    const reviewed_at = direct ? now : null
    const options_json = Array.isArray(options) && options.length ? JSON.stringify(options) : null
    await this.db.prepare(
      `INSERT INTO commands (id, project_id, host, instruction, status, permission_mode, created_by, created_at, updated_at,
                             task_type, business, customer, risk_level, ai_summary, evidence, recommended_action,
                             title, assignee_agent_name, parent_command_id, root_command_id, level,
                             review_status, reviewed_by, reviewed_at, session_id, idempotency_key, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      project_id,
      host || null,
      instruction,
      status,
      permission_mode || 'allowlist',
      created_by || null,
      now,
      now,
      task_type || null,
      business || null,
      customer || null,
      risk_level || 'low',
      ai_summary || null,
      evidence || null,
      recommended_action || null,
      title || null,
      assignee_agent_name || null,
      parent_command_id || null,
      root_command_id || null,
      level ?? 0,
      review_status,
      reviewed_by,
      reviewed_at,
      session_id || null,
      idempotency_key || null,
      options_json,
    ).run()
    return await this.findById(id)
  }

  /**
   * findAll — 목록 조회. 기존 project_id/status 필터와 공존하는 B-1 승인함 필터 추가.
   *  - inbox='pending' → status='queued' AND review_status IS NULL (검토 대기 중만)
   *  - inbox='done'    → review_status IS NOT NULL (검토 완료)
   *  - risk_level      → 정확 일치(API 레이어에서 low/medium/high 검증)
   */
  async findAll({ project_id, status, inbox, risk_level, limit = 50, offset = 0 } = {}) {
    // commands 를 c 로, projects 를 p 로 별칭 — projects 에도 status/created_at 이 있어
    // JOIN 시 컬럼이 모호해지므로 모든 조건/정렬 컬럼을 c. 로 한정한다.
    // project_name: 승인 카드가 "어느 프로젝트"인지 보여줄 수 있도록 함께 반환(옛 business/customer 대체).
    const conds = []
    const vals = []
    if (project_id) { conds.push('c.project_id = ?'); vals.push(project_id) }
    // status: 배열이면 IN 조건(실행 모니터의 active='claimed,running'/recent='done,failed' 폴링용,
    //   2026-07-14). 문자열이면 기존과 동일한 단일 일치.
    if (Array.isArray(status) && status.length) {
      conds.push(`c.status IN (${status.map(() => '?').join(',')})`)
      vals.push(...status)
    } else if (status) {
      conds.push('c.status = ?'); vals.push(status)
    }
    // 리뷰 2026-07-09 Minor(구조적): 콘솔 채팅 턴(task_type='console')은 direct:true 로 자동
    //   자가승인('approved')되어 매 메시지가 승인함 "검토완료" 목록에 그대로 쌓인다 — 승인함은
    //   "대표가 실제 검토/승인한 위험·비가역 작업 이력"이 목적이라 일상 채팅으로 도배되면 감사로그
    //   목적과 어긋난다. inbox 조회(승인함 UI 전용)에서만 콘솔 턴을 제외한다(기록 자체는 유지 —
    //   /console 페이지의 세션 목록에서는 그대로 조회 가능).
    if (inbox === 'pending') {
      conds.push("c.status = 'queued' AND c.review_status IS NULL AND (c.task_type IS NULL OR c.task_type != 'console')")
    } else if (inbox === 'done') {
      conds.push("c.review_status IS NOT NULL AND (c.task_type IS NULL OR c.task_type != 'console')")
    }
    if (risk_level) { conds.push('c.risk_level = ?'); vals.push(risk_level) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    // 승인 대기함(inbox=pending)은 위험도 높음→낮음 우선, 동일 위험도 내 최신순.
    // 대표가 먼저 봐야 할 고위험 건이 항상 상단에 오도록 한다. 그 외 목록은 기존대로 최신순.
    const order = inbox === 'pending'
      ? `ORDER BY CASE c.risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, c.created_at DESC`
      : `ORDER BY c.created_at DESC`
    vals.push(limit, offset)
    const rows = (await this.db.prepare(
      `SELECT c.*, p.name AS project_name
         FROM commands c LEFT JOIN projects p ON p.id = c.project_id
       ${where} ${order} LIMIT ? OFFSET ?`
    ).bind(...vals).all()).results
    return rows.map(withOptions)
  }

  async findById(id) {
    const row = await this.db.prepare('SELECT * FROM commands WHERE id = ?').bind(id).first()
    return withOptions(row)
  }

  /**
   * inboxSummary — B-4 경영 통제센터 집계.
   * 단일 패스로 승인 대기(pending)·위험도 분포·실패·자동생성·총비용을 모아 반환.
   * 인덱스(idx_commands_claim: status 선두)를 타도록 status 기준 집계.
   * @returns { pending, pending_high, pending_medium, pending_low, failed, scheduled_pending, total_cost_usd }
   */
  async inboxSummary() {
    // 검토 대기 = status='queued' AND review_status IS NULL (승인함과 동일 정의).
    const pending = await this.db.prepare(
      `SELECT
         COUNT(*) AS pending,
         SUM(CASE WHEN risk_level='high'   THEN 1 ELSE 0 END) AS pending_high,
         SUM(CASE WHEN risk_level='medium' THEN 1 ELSE 0 END) AS pending_medium,
         SUM(CASE WHEN risk_level='low' OR risk_level IS NULL THEN 1 ELSE 0 END) AS pending_low,
         SUM(CASE WHEN created_by='scheduler' THEN 1 ELSE 0 END) AS scheduled_pending
       FROM commands
       WHERE status='queued' AND review_status IS NULL`
    ).first()
    const failed = await this.db.prepare(
      `SELECT COUNT(*) AS failed FROM commands WHERE status='failed'`
    ).first()
    const cost = await this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd FROM commands`
    ).first()
    return {
      pending: pending?.pending || 0,
      pending_high: pending?.pending_high || 0,
      pending_medium: pending?.pending_medium || 0,
      pending_low: pending?.pending_low || 0,
      scheduled_pending: pending?.scheduled_pending || 0,
      failed: failed?.failed || 0,
      total_cost_usd: cost?.total_cost_usd || 0,
    }
  }

  /**
   * 원자적 점유 — D1 단일 statement 조건부 UPDATE. **안전망(safety net) 경로 전용**.
   *
   * (설계 vscode-web-unified-execution.md §3-3) `status='approved'` 인 것만 집는다.
   *   `queued`는 held(승인/게이트 대기)의 유일 의미로 확정 — poll이 사람/게이트 승인 없이
   *   실행하던 갭(issue a26660b1)을 봉쇄한다. 정기 사이클은 'claimed'로 태어나 claim 대상이
   *   아니고, 사람·AI 승인분만 'approved'가 되어 여기서 걷힌다.
   *
   * (설계 §7 프로젝트당 active-1 불변식, 가드 ①) 대상 프로젝트에 이미 claimed/running 인
   *   command 가 있으면 그 프로젝트 건은 집지 않는다(NOT EXISTS). phase 자동전진이 자연히
   *   순차가 되고 동시 실행 충돌 표면이 사라진다. 단일 statement 원자성으로 서브쿼리 선택과
   *   UPDATE 사이 경합을 막고, 바깥 WHERE 의 status='approved' 재확인이 동시 claim 을 막는다.
   *
   * changes()==0 → 가져갈 명령이 없거나(다른 프로젝트가 실행 중이거나) 남이 먼저 점유 → null.
   * changes()==1 → 같은 claimed_by/claimed_at로 다시 SELECT 하여 점유한 row 반환.
   */
  async claim({ host }) {
    const now = new Date().toISOString()
    const claimedBy = host || null
    const res = await this.db.prepare(
      `UPDATE commands
          SET status='claimed', claimed_by=?, claimed_at=?, updated_at=?
        WHERE id = (
                SELECT c.id FROM commands c
                 WHERE c.status='approved'
                   AND (c.host = ? OR c.host IS NULL)
                   AND NOT EXISTS (
                         SELECT 1 FROM commands a
                          WHERE a.project_id = c.project_id
                            AND a.status IN ('claimed','running')
                       )
                 ORDER BY c.created_at ASC
                 LIMIT 1
              )
          AND status='approved'`
    ).bind(claimedBy, now, now, host || null).run()

    if (!res.meta || res.meta.changes === 0) return null

    // 방금 이 워커가 점유한 row를 claimed_by + claimed_at 으로 식별해 반환.
    return await this.db.prepare(
      `SELECT * FROM commands
        WHERE status='claimed' AND claimed_at=? AND ((claimed_by IS NULL AND ? IS NULL) OR claimed_by=?)
        ORDER BY created_at ASC LIMIT 1`
    ).bind(now, claimedBy, claimedBy).first()
  }

  /**
   * claimForRunning — dispatch-worker.js(§2.3/§2.7) 전용 원자적 실행권 판정.
   *
   * claim()/reviewCommandTx 의 타겟claim과 동형인 조건부 UPDATE(WHERE id=? AND status IN (...)).
   * §2.7(spawn-due 즉시디스패치) 경로는 command 를 'queued' 로 INSERT 한 직후 곧바로 이걸 부르므로,
   * poll 의 claim()이 그 틈에 먼저 이겨 이미 'claimed' 로 전이시켰다면 이 UPDATE 는 changes()=0 으로
   * 실패한다 — 그 경우 호출부는 실행을 스킵해야 한다(이중 실행 차단, reviewer 지적 반영).
   * §2.4(사람 즉시스폰) 경로는 이미 'claimed' 상태로 들어오므로 이 호출은 항상 성공(no-op 재확인).
   *
   * @returns {Promise<boolean>} true = 이 호출이 실행권을 땄다. false = 이미 다른 경로가 선점.
   */
  async claimForRunning(id, fromStatuses) {
    const now = new Date().toISOString()
    const placeholders = fromStatuses.map(() => '?').join(',')
    const res = await this.db.prepare(
      `UPDATE commands SET status='running', updated_at=? WHERE id=? AND status IN (${placeholders})`
    ).bind(now, id, ...fromStatuses).run()
    return !!(res.meta && res.meta.changes === 1)
  }

  /**
   * 실행 결과/상태 업데이트 — 멱등.
   * 종료 상태(done/failed/rejected/expired)에서 되돌리려는 PATCH는 무시(상태 역행 방지).
   * 제공된 필드만 갱신하고 updated_at은 항상 갱신.
   */
  async updateStatus(id, { status, exit_code, result, cost_usd, session_id, error } = {}) {
    const existing = await this.findById(id)
    if (!existing) return null

    const TERMINAL = ['done', 'failed', 'rejected', 'expired']
    // 이미 종료 상태인데 다른 상태로 바꾸려 하면 무시(멱등하게 현재 row 반환).
    if (TERMINAL.includes(existing.status) && status && status !== existing.status) {
      return existing
    }

    const next = {
      status: status ?? existing.status,
      exit_code: exit_code !== undefined ? exit_code : existing.exit_code,
      result: result !== undefined ? result : existing.result,
      cost_usd: cost_usd !== undefined ? cost_usd : existing.cost_usd,
      session_id: session_id !== undefined ? session_id : existing.session_id,
      error: error !== undefined ? error : existing.error,
    }
    const now = new Date().toISOString()
    await this.db.prepare(
      `UPDATE commands
          SET status=?, exit_code=?, result=?, cost_usd=?, session_id=?, error=?, updated_at=?
        WHERE id=?`
    ).bind(
      next.status,
      next.exit_code ?? null,
      next.result ?? null,
      next.cost_usd ?? null,
      next.session_id ?? null,
      next.error ?? null,
      now,
      id,
    ).run()
    return await this.findById(id)
  }

  /**
   * findConsoleSessions — Claude Code 웹콘솔(project_id 스코프)의 세션 목록(최신순 페이지네이션).
   *   세션당 1행: 턴 수·최근 시각·누적 비용·제목(첫 턴 instruction 원문, 프론트가 truncate)·
   *   마지막 턴 상태. task_type='console' AND session_id IS NOT NULL 인 것만 대상(첫 턴은
   *   session_id 가 아직 없어 목록에 안 잡히는 게 정상 — 워커 응답으로 세션이 생긴 뒤부터 노출).
   *
   * 세션이 쌓일수록 목록 조회가 무거워지는 걸 막기 위해 limit+1개를 가져와 실제 limit개를
   *   초과하면 has_more=true 로 알린다(별도 COUNT(*) 쿼리 없이 한 방에 다음 페이지 존재 여부 판단).
   */
  async findConsoleSessions(project_id, { limit = 10, offset = 0 } = {}) {
    const rows = (await this.db.prepare(
      `SELECT session_id,
              COUNT(*) AS turn_count,
              MAX(created_at) AS last_at,
              COALESCE(SUM(cost_usd),0) AS total_cost_usd,
              (SELECT instruction FROM commands c2 WHERE c2.session_id=c.session_id
                 AND c2.task_type='console' ORDER BY c2.created_at ASC LIMIT 1) AS title,
              (SELECT status FROM commands c3 WHERE c3.session_id=c.session_id
                 AND c3.task_type='console' ORDER BY c3.created_at DESC LIMIT 1) AS last_status
         FROM commands c
        WHERE c.project_id = ? AND c.task_type = 'console' AND c.session_id IS NOT NULL
        GROUP BY c.session_id
        ORDER BY last_at DESC
        LIMIT ? OFFSET ?`
    ).bind(project_id, limit + 1, offset).all()).results
    const has_more = rows.length > limit
    return { sessions: has_more ? rows.slice(0, limit) : rows, has_more }
  }

  /** findConsoleTurns — 특정 콘솔 세션의 전체 턴(시간순). */
  async findConsoleTurns(project_id, session_id) {
    return (await this.db.prepare(
      `SELECT id, instruction, result, status, exit_code, cost_usd, session_id, error, created_at, updated_at
         FROM commands
        WHERE project_id = ? AND task_type = 'console' AND session_id = ?
        ORDER BY created_at ASC`
    ).bind(project_id, session_id).all()).results
  }

}
