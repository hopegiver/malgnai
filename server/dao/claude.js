export default class ClaudeDao {
  constructor(db) { this.db = db }

  // --- History ---
  async syncHistory(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_history (id, display, project, timestamp, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const h of items) {
      await stmt.bind(h.id, h.display, h.project, h.timestamp, h.created_at).run()
    }
    return items.length
  }

  async findHistory({ project, limit = 50, offset = 0 } = {}) {
    if (project) {
      return (await this.db.prepare(
        'SELECT * FROM claude_history WHERE project = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      ).bind(project, limit, offset).all()).results
    }
    return (await this.db.prepare(
      'SELECT * FROM claude_history ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all()).results
  }

  // --- Stats ---
  // 일별 통계는 매일 갱신되는 트랜스크립트(projects/*/*.jsonl)를 sync 단계에서 날짜별로 집계한 값이다.
  async syncStats(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_stats (id, date, message_count, session_count, tool_call_count, project_count) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const s of items) {
      await stmt.bind(s.id, s.date, s.message_count, s.session_count, s.tool_call_count, s.project_count).run()
    }
    return items.length
  }

  async findStats({ since, until, limit = 365, offset = 0 } = {}) {
    const conds = []
    const vals = []
    if (since) { conds.push('date >= ?'); vals.push(since) }
    if (until) { conds.push('date <= ?'); vals.push(until) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    vals.push(limit, offset)
    return (await this.db.prepare(
      `SELECT * FROM claude_stats ${where} ORDER BY date DESC LIMIT ? OFFSET ?`
    ).bind(...vals).all()).results
  }

  // --- Token Stats ---
  async syncTokenStats(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_token_stats (id, date, model, tokens) VALUES (?, ?, ?, ?)'
    )
    for (const t of items) {
      await stmt.bind(t.id, t.date, t.model, t.tokens).run()
    }
    return items.length
  }

  async findTokenStats({ since, until } = {}) {
    const conds = []
    const vals = []
    if (since) { conds.push('date >= ?'); vals.push(since) }
    if (until) { conds.push('date <= ?'); vals.push(until) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    // 날짜별 총 토큰 + 모델 분해를 함께 반환
    const rows = (await this.db.prepare(
      `SELECT date, model, tokens FROM claude_token_stats ${where} ORDER BY date DESC`
    ).bind(...vals).all()).results
    // 날짜별로 묶기
    const byDate = new Map()
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, total: 0, by_model: {} })
      const d = byDate.get(r.date)
      d.total += r.tokens || 0
      d.by_model[r.model] = (d.by_model[r.model] || 0) + (r.tokens || 0)
    }
    return [...byDate.values()]
  }

  async syncModelUsage(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_model_usage (model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const m of items) {
      await stmt.bind(m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens, m.updated_at).run()
    }
    return items.length
  }

  async findModelUsage() {
    return (await this.db.prepare(
      'SELECT * FROM claude_model_usage ORDER BY (input_tokens + output_tokens) DESC'
    ).all()).results
  }

  // --- Memories ---
  async syncMemories(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_memories (id, project_key, file_name, name, description, type, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const m of items) {
      await stmt.bind(m.id, m.project_key, m.file_name, m.name, m.description, m.type, m.content, m.updated_at).run()
    }
    return items.length
  }

  async findMemories({ project_key, type } = {}) {
    const conds = []
    const vals = []
    if (project_key) { conds.push('project_key = ?'); vals.push(project_key) }
    if (type) { conds.push('type = ?'); vals.push(type) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    return (await this.db.prepare(
      `SELECT * FROM claude_memories ${where} ORDER BY project_key, file_name`
    ).bind(...vals).all()).results
  }

  async getMemoryProjects() {
    return (await this.db.prepare(
      'SELECT project_key, COUNT(*) as memory_count FROM claude_memories GROUP BY project_key ORDER BY project_key'
    ).all()).results
  }

  // --- Sessions ---
  async syncSessions(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_sessions (id, session_id, pid, cwd, kind, entrypoint, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const s of items) {
      await stmt.bind(s.id, s.session_id, s.pid, s.cwd, s.kind, s.entrypoint, s.started_at).run()
    }
    return items.length
  }

  async findSessions({ limit = 50, offset = 0 } = {}) {
    return (await this.db.prepare(
      'SELECT * FROM claude_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all()).results
  }

  // 트랜스크립트에서 title 을 못 뽑은 세션(주로 headless 워커 실행 — 사람이 직접 타이핑한
  // user 턴이 없어 first_prompt 도 비는 경우)은 그 세션을 만든 commands 행에서 대신 가져온다.
  // 같은 session_id 를 여러 command 가 공유할 수 있어(--resume 후속 명령들) 가장 오래된
  // (=원본) 행을 대표로 쓴다 — 후속 resume 행은 title 이 비어있고 instruction 도 세션 전체를
  // 대표하지 못하는 답변 텍스트인 경우가 많다.
  async _titleFromCommand(sessionId) {
    const cmd = await this.db.prepare(
      'SELECT title, instruction FROM commands WHERE session_id = ? ORDER BY created_at ASC LIMIT 1'
    ).bind(sessionId).first()
    if (!cmd) return null
    if (cmd.title) return cmd.title
    if (cmd.instruction) return cmd.instruction.slice(0, 80)
    return null
  }

  // --- Project Sessions (트랜스크립트 기반 작업 이력) ---
  async syncProjectSessions(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO claude_project_sessions (id, project_key, cwd, git_branch, title, first_prompt, last_prompt, message_count, tool_count, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const s of items) {
      const title = s.title || (await this._titleFromCommand(s.id)) || '(제목 없음)'
      await stmt.bind(
        s.id, s.project_key, s.cwd, s.git_branch, title,
        s.first_prompt, s.last_prompt, s.message_count, s.tool_count,
        s.started_at, s.ended_at
      ).run()
    }
    return items.length
  }

  async findProjectSessionsByKey(projectKey, { limit = 100, offset = 0 } = {}) {
    return (await this.db.prepare(
      'SELECT * FROM claude_project_sessions WHERE project_key = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).bind(projectKey, limit, offset).all()).results
  }

  // 프로젝트 폴더명(basename)으로 세션 매칭. 같은 프로젝트라도 머신/OS가 바뀌면
  // project_key 가 달라지므로(Windows: g--workspace-malgnai, Mac: -Users-...-malgnai)
  // 절대경로 키 대신 마지막 경로 세그먼트(=폴더명)로 비교해 이력이 끊기지 않게 한다.
  // 대소문자 무시. 예) 'malgnai' → 'g--workspace-malgnai', '-Users-...-malgnai' 모두 매칭.
  async findProjectSessionsByName(name, { limit = 100, offset = 0 } = {}) {
    if (!name) return []
    const lower = String(name).toLowerCase()
    const likeEsc = lower.replace(/[\\%_]/g, '\\$&') // LIKE 와일드카드 이스케이프
    return (await this.db.prepare(
      `SELECT * FROM claude_project_sessions
       WHERE LOWER(project_key) = ? OR LOWER(project_key) LIKE ? ESCAPE '\\'
       ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).bind(lower, '%-' + likeEsc, limit, offset).all()).results
  }

  // 전역 프로젝트 세션 목록(최신순).
  async findProjectSessionsAll({ limit = 100, offset = 0 } = {}) {
    return (await this.db.prepare(
      'SELECT * FROM claude_project_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all()).results
  }

  // 프로젝트별 AI 투입 집계(세션/메시지/도구 합계). 대시보드 "AI 투입 Top"에 사용.
  // 절대경로 키(g--workspace-malgnai) 대신 **폴더명(basename)** 으로 projects 에 매핑한다.
  // OS/머신이 바뀌어도(Windows g:\ → Mac /Users) 같은 프로젝트로 묶이도록.
  // projects.path 의 마지막 경로 세그먼트를 SQL 에서 추출(RTRIM 트릭)해 소문자 비교.
  // 같은 프로젝트의 서로 다른 키(예: g--workspace-malgnai + -Users-...-malgnai)는
  // COALESCE(p.id, project_key) 로 묶어 한 행으로 합산. 매칭 안 되면 project_name=null.
  async getProjectSessionAggregates({ limit = 10 } = {}) {
    return (await this.db.prepare(
      `SELECT MAX(s.project_key) AS project_key,
              p.id   AS project_id,
              p.name AS project_name,
              COUNT(*) AS session_count,
              SUM(s.message_count) AS message_count,
              SUM(s.tool_count) AS tool_count,
              MAX(s.started_at) AS last_started_at
       FROM claude_project_sessions s
       LEFT JOIN (
         SELECT id, name,
                LOWER(REPLACE(np, RTRIM(np, REPLACE(np, '/', '')), '')) AS folder
         FROM (SELECT id, name, REPLACE(path, '\\', '/') AS np FROM projects)
       ) p
         ON p.folder <> ''
        AND (LOWER(s.project_key) = p.folder
             OR LOWER(s.project_key) LIKE '%-' || p.folder)
       GROUP BY COALESCE(p.id, s.project_key)
       ORDER BY session_count DESC
       LIMIT ?`
    ).bind(limit).all()).results
  }

  // 최근 N일 가동 현황(claude_stats 집계). 대시보드 "AI 가동현황".
  async getRecentActivity(days = 7) {
    const row = await this.db.prepare(
      `SELECT SUM(message_count) AS messages,
              SUM(session_count) AS sessions,
              SUM(tool_call_count) AS tools,
              MAX(project_count) AS projects
       FROM claude_stats
       WHERE date >= date('now', 'localtime', '-' || ? || ' days')`
    ).bind(days - 1).first()
    return {
      days,
      messages: row?.messages || 0,
      sessions: row?.sessions || 0,
      tools: row?.tools || 0,
      projects: row?.projects || 0,
    }
  }

  // 이번 달 일별 토큰(모델별). 비용 환산 입력.
  async getMonthlyTokenStats() {
    return (await this.db.prepare(
      `SELECT date, model, tokens FROM claude_token_stats
       WHERE date >= date('now', 'localtime', 'start of month')
       ORDER BY date`
    ).all()).results
  }

  // --- Session Usage (세션별 토큰/비용, main/sub 분리) ---
  async syncSessionUsage(items) {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO claude_session_usage
       (session_id, project_key, cwd, git_branch, title, model,
        main_turns, main_input, main_output, main_cache_read, main_cache_write_1h, main_cache_write_5m,
        sub_turns, sub_input, sub_output, sub_cache_read, sub_cache_write_1h, sub_cache_write_5m,
        sub_agent_count, total_tokens, cost_usd, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of items) {
      const title = s.title || (await this._titleFromCommand(s.session_id)) || '(제목 없음)'
      await stmt.bind(
        s.session_id, s.project_key, s.cwd, s.git_branch, title, s.model,
        s.main_turns, s.main_input, s.main_output, s.main_cache_read, s.main_cache_write_1h, s.main_cache_write_5m,
        s.sub_turns, s.sub_input, s.sub_output, s.sub_cache_read, s.sub_cache_write_1h, s.sub_cache_write_5m,
        s.sub_agent_count, s.total_tokens, s.cost_usd, s.started_at, s.ended_at
      ).run()
    }
    return items.length
  }

  async syncAgentUsage(items) {
    // 세션 단위 전체 교체: agent_type 재분류(예: unknown→backend-dev) 시 잔존행 방지.
    // 같은 세션의 기존 행을 지우고 이번 배치로 다시 채운다.
    const sessionIds = [...new Set(items.map(a => a.session_id))]
    const del = this.db.prepare('DELETE FROM claude_agent_usage WHERE session_id = ?')
    for (const sid of sessionIds) await del.bind(sid).run()

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO claude_agent_usage
       (id, session_id, project_key, agent_type, invocations, turns, max_turns, tokens, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const a of items) {
      await stmt.bind(
        a.id, a.session_id, a.project_key, a.agent_type,
        a.invocations, a.turns, a.max_turns, a.tokens, a.cost_usd, a.updated_at
      ).run()
    }
    return items.length
  }

  // 세션 top-N (비용순). since=ISO 이면 그 시각 이후 시작 세션만.
  async findSessionUsage({ limit = 20, offset = 0, since = null, projectKey = null } = {}) {
    const conds = [], binds = []
    if (since) { conds.push('started_at >= ?'); binds.push(since) }
    if (projectKey) { conds.push('project_key = ?'); binds.push(projectKey) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    binds.push(limit, offset)
    return (await this.db.prepare(
      `SELECT * FROM claude_session_usage ${where} ORDER BY cost_usd DESC LIMIT ? OFFSET ?`
    ).bind(...binds).all()).results
  }

  // 프로젝트별 토큰/비용 집계
  async getProjectUsage({ since = null, limit = 50 } = {}) {
    const conds = [], binds = []
    if (since) { conds.push('started_at >= ?'); binds.push(since) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    binds.push(limit)
    return (await this.db.prepare(
      `SELECT project_key,
              COUNT(*) AS sessions,
              SUM(total_tokens) AS tokens,
              SUM(cost_usd) AS cost_usd,
              SUM(sub_turns) AS sub_turns,
              SUM(main_turns) AS main_turns,
              MAX(ended_at) AS last_at
       FROM claude_session_usage ${where}
       GROUP BY project_key ORDER BY cost_usd DESC LIMIT ?`
    ).bind(...binds).all()).results
  }

  // 에이전트 type별 집계 (범인 색출: 어느 에이전트가 턴/토큰/비용을 먹나)
  async getAgentUsage({ since = null, limit = 50 } = {}) {
    // since 는 세션 시작시각 기준 조인 필터
    const join = since
      ? `JOIN claude_session_usage s ON s.session_id = a.session_id AND s.started_at >= ?`
      : ''
    const binds = since ? [since, limit] : [limit]
    return (await this.db.prepare(
      `SELECT a.agent_type,
              SUM(a.invocations) AS invocations,
              SUM(a.turns) AS turns,
              MAX(a.max_turns) AS max_turns,
              SUM(a.tokens) AS tokens,
              SUM(a.cost_usd) AS cost_usd
       FROM claude_agent_usage a ${join}
       GROUP BY a.agent_type ORDER BY cost_usd DESC LIMIT ?`
    ).bind(...binds).all()).results
  }

  // 전체 usage 요약 (main vs sub 비중, 캐시쓰기 1h 비중)
  async getUsageSummary({ since = null } = {}) {
    const conds = [], binds = []
    if (since) { conds.push('started_at >= ?'); binds.push(since) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return await this.db.prepare(
      `SELECT COUNT(*) AS sessions,
              SUM(total_tokens) AS tokens,
              SUM(cost_usd) AS cost_usd,
              SUM(main_input+main_output+main_cache_read+main_cache_write_1h+main_cache_write_5m) AS main_tokens,
              SUM(sub_input+sub_output+sub_cache_read+sub_cache_write_1h+sub_cache_write_5m) AS sub_tokens,
              SUM(main_cache_write_1h+sub_cache_write_1h) AS cache_write_1h,
              SUM(main_cache_read+sub_cache_read) AS cache_read
       FROM claude_session_usage ${where}`
    ).bind(...binds).first()
  }

  // --- Summary ---
  async getSummary() {
    const [historyCount, statsDays, memoryCount, sessionCount, recent7, totalTokens] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as cnt FROM claude_history').first(),
      this.db.prepare('SELECT COUNT(*) as cnt FROM claude_stats').first(),
      this.db.prepare('SELECT COUNT(*) as cnt FROM claude_memories').first(),
      this.db.prepare('SELECT COUNT(*) as cnt FROM claude_sessions').first(),
      this.db.prepare(
        `SELECT SUM(message_count) as cnt FROM claude_stats WHERE date >= date('now', 'localtime', '-6 days')`
      ).first(),
      this.db.prepare(
        'SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) as cnt FROM claude_model_usage'
      ).first(),
    ])

    return {
      history_count: historyCount?.cnt || 0,
      stats_days: statsDays?.cnt || 0,
      memory_count: memoryCount?.cnt || 0,
      session_count: sessionCount?.cnt || 0,
      recent_7days: { messages: recent7?.cnt || 0 },
      total_tokens: totalTokens?.cnt || 0,
    }
  }
}
