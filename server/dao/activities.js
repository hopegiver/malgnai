import { logActivity } from '../lib/activity-log.js'
import { projectAccessWhere } from '../lib/project-access.js'

export default class ActivitiesDao {
  constructor(db) { this.db = db }

  // level: 문자열(단일) 또는 배열(IN) 또는 undefined(필터 없음).
  //   기본 limit=50/offset=0 유지 → 파라미터 無 = 기존 동작(최신 50). limit 클램프는 라우트에서.
  // user(선택, 2026-07-14) — 지정하면 소유자/협업자 프로젝트로 스코핑(commands.js findAll과 동일
  //   projectAccessWhere 재사용). project_id 없는 전역 로그는 이 스코프에 걸리지 않아 제외된다
  //   (다른 사용자 프로젝트/전사 로그 노출 방지, 홈 대시보드 사용자 필터 누락 버그 수정).
  async findAll({ project_id, command_id, agent_name, level, category, since, until, limit = 50, offset = 0, user } = {}) {
    const conds = []
    const vals = []
    if (project_id) { conds.push('a.project_id = ?'); vals.push(project_id) }
    if (command_id) { conds.push('a.command_id = ?'); vals.push(command_id) }
    if (agent_name) { conds.push('a.agent_name = ?'); vals.push(agent_name) }
    if (Array.isArray(level) && level.length) {
      conds.push(`a.level IN (${level.map(() => '?').join(',')})`); vals.push(...level)
    } else if (typeof level === 'string' && level) {
      conds.push('a.level = ?'); vals.push(level)
    }
    if (category) { conds.push('a.category = ?'); vals.push(category) }
    if (since) { conds.push('a.created_at >= ?'); vals.push(since) }
    if (until) { conds.push('a.created_at <= ?'); vals.push(until) }
    if (user) {
      const scope = projectAccessWhere('p.owner_user_id', 'a.project_id')
      conds.push(scope.sql)
      vals.push(...scope.bind(user))
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
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
