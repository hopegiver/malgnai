import { logActivity } from '../lib/activity-log.js'

export default class ActivitiesDao {
  constructor(db) { this.db = db }

  // level: 문자열(단일) 또는 배열(IN) 또는 undefined(필터 없음).
  //   기본 limit=50/offset=0 유지 → 파라미터 無 = 기존 동작(최신 50). limit 클램프는 라우트에서.
  async findAll({ project_id, command_id, agent_name, level, category, since, until, limit = 50, offset = 0 } = {}) {
    const conds = []
    const vals = []
    if (project_id) { conds.push('project_id = ?'); vals.push(project_id) }
    if (command_id) { conds.push('command_id = ?'); vals.push(command_id) }
    if (agent_name) { conds.push('agent_name = ?'); vals.push(agent_name) }
    if (Array.isArray(level) && level.length) {
      conds.push(`level IN (${level.map(() => '?').join(',')})`); vals.push(...level)
    } else if (typeof level === 'string' && level) {
      conds.push('level = ?'); vals.push(level)
    }
    if (category) { conds.push('category = ?'); vals.push(category) }
    if (since) { conds.push('created_at >= ?'); vals.push(since) }
    if (until) { conds.push('created_at <= ?'); vals.push(until) }
    const where = conds.length ? 'WHERE ' + conds.map(c => 'a.' + c).join(' AND ') : ''
    vals.push(limit, offset)
    return (await this.db.prepare(
      `SELECT a.*, p.name AS project_name
       FROM activity_logs a
       LEFT JOIN projects p ON p.id = a.project_id
       ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
    ).bind(...vals).all()).results
  }

  // 쓰기는 단일 관문(logActivity)에 위임 — 정규화(level/category 등) + 멱등 upsert(id 기준,
  //   아웃박스 재전송 안전, created_at 보존). 엔진 직접 INSERT 도 같은 관문을 쓴다(reviewer §6).
  //   ⚠️ 이 create 를 통과하는 모든 감사로그(예: commands.js 의 system rule_queue/rule_auto)도
  //     자동으로 level=telemetry 로 정규화된다.
  async create(input) {
    return logActivity(this.db, input, { upsert: true })
  }
}
