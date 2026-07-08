// Context Router 데이터(malgnai-mcp 통합 DB) 읽기 전용 DAO.
// decisions / issues / memories 는 MCP(에이전트)가 기록하고, 웹앱은 조회만 한다.
// DB 통합(2026-06-24) 이후 같은 SQLite 파일을 공유하므로 직접 SELECT 가능.
export default class ContextDao {
  constructor(db) { this.db = db }

  // 전역 인사이트 조회 시 프로젝트명을 함께 보여주기 위해 projects를 LEFT JOIN.
  async decisions(projectId, limit = 50) {
    const sql = projectId
      ? 'SELECT d.*, p.name AS project_name FROM decisions d LEFT JOIN projects p ON p.id = d.project_id WHERE d.project_id = ? ORDER BY d.created_at DESC LIMIT ?'
      : 'SELECT d.*, p.name AS project_name FROM decisions d LEFT JOIN projects p ON p.id = d.project_id ORDER BY d.created_at DESC LIMIT ?'
    const stmt = projectId
      ? this.db.prepare(sql).bind(projectId, limit)
      : this.db.prepare(sql).bind(limit)
    return (await stmt.all()).results
  }

  async issues(projectId, { status, severity, limit = 50 } = {}) {
    const where = []
    const args = []
    if (projectId) { where.push('i.project_id = ?'); args.push(projectId) }
    if (status) { where.push('i.status = ?'); args.push(status) }
    if (severity) { where.push('i.severity = ?'); args.push(severity) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    // 열린 이슈 우선 → severity 높은 순 → 최신순.
    args.push(limit)
    const sql = `SELECT i.*, p.name AS project_name FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id ${clause}
       ORDER BY (i.status='open') DESC,
                CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                i.created_at DESC LIMIT ?`
    return (await this.db.prepare(sql).bind(...args).all()).results
  }

  async memories(projectId, { memory_type, limit = 50 } = {}) {
    const where = []
    const args = []
    if (projectId) { where.push('m.project_id = ?'); args.push(projectId) }
    if (memory_type) { where.push('m.memory_type = ?'); args.push(memory_type) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    args.push(limit)
    const sql = `SELECT m.*, p.name AS project_name FROM memories m
       LEFT JOIN projects p ON p.id = m.project_id ${clause}
       ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`
    return (await this.db.prepare(sql).bind(...args).all()).results
  }
}
