export default class AgentsDao {
  constructor(db) { this.db = db }

  async findAll({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
      return (await this.db.prepare('SELECT name, role, description, status, skill_level, skill_level_locked, learning_status, skills, team, job_title, model, forbidden_tasks, approval_required_tasks, total_tasks_completed, total_projects_participated, last_active_at, created_at, updated_at FROM agents WHERE status = ? ORDER BY name LIMIT ? OFFSET ?').bind(status, limit, offset).all()).results
    }
    return (await this.db.prepare('SELECT name, role, description, status, skill_level, skill_level_locked, learning_status, skills, team, job_title, model, forbidden_tasks, approval_required_tasks, total_tasks_completed, total_projects_participated, last_active_at, created_at, updated_at FROM agents ORDER BY name LIMIT ? OFFSET ?').bind(limit, offset).all()).results
  }

  async findByName(name) {
    return await this.db.prepare('SELECT * FROM agents WHERE name = ?').bind(name).first()
  }

  // 이슈 6a01f9ab: bin/sync-agents.js 의 일괄 /sync 는 매번 skills/skill_level 을 키워드매칭으로
  // 재계산해 보낸다. 이 값이 트레이너의 실질평가 수동 승급을 조용히 덮어쓰지 않도록, 기존 row 가
  // skill_level_locked=1 인데 이번 호출이 잠금 필드를 명시적으로 건드리지 않았다면(=일반 sync 경로)
  // skills/skill_level 은 기존 값을 그대로 보존한다. 잠금 해제/재설정은 skill_level_locked 를
  // 실어서 호출할 때만(= setSkillOverride) 일어난다.
  async upsert({ name, role, description, status, md_content, md_hash, skills, knowledge, skill_level, team, job_title, model, forbidden_tasks, approval_required_tasks, skill_level_locked }) {
    const now = new Date().toISOString()
    const existing = await this.findByName(name)
    const lockExplicit = skill_level_locked !== undefined && skill_level_locked !== null
    const wasLocked = !!existing && Number(existing.skill_level_locked) === 1
    const preserveSkill = wasLocked && !lockExplicit

    const finalSkills = preserveSkill ? existing.skills : (skills || null)
    const finalSkillLevel = preserveSkill ? existing.skill_level : (skill_level || 'beginner')
    const finalLocked = lockExplicit ? (skill_level_locked ? 1 : 0) : (wasLocked ? 1 : 0)

    await this.db.prepare(
      `INSERT INTO agents (name, role, description, status, md_content, md_hash, skills, knowledge, skill_level, skill_level_locked, team, job_title, model, forbidden_tasks, approval_required_tasks, learning_status, total_tasks_completed, total_projects_participated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET role=excluded.role, description=excluded.description, status=excluded.status, md_content=excluded.md_content, md_hash=excluded.md_hash, skills=excluded.skills, knowledge=excluded.knowledge, skill_level=excluded.skill_level, skill_level_locked=excluded.skill_level_locked, team=excluded.team, job_title=excluded.job_title, model=excluded.model, forbidden_tasks=excluded.forbidden_tasks, approval_required_tasks=excluded.approval_required_tasks, updated_at=excluded.updated_at`
    ).bind(name, role, description || null, status || 'active', md_content || null, md_hash || null, finalSkills, knowledge || null, finalSkillLevel, finalLocked, team || null, job_title || null, model || null, forbidden_tasks || null, approval_required_tasks || null, now, now).run()
    return await this.findByName(name)
  }

  // 트레이너 실질평가 → skill_level 수동 확정 + 자동재계산으로부터 잠금(또는 잠금 해제).
  async setSkillOverride(name, { skill_level, locked } = {}) {
    const existing = await this.findByName(name)
    if (!existing) return null
    const now = new Date().toISOString()
    const finalLevel = (skill_level !== undefined && skill_level !== null) ? skill_level : existing.skill_level
    const finalLocked = (locked === undefined) ? existing.skill_level_locked : (locked ? 1 : 0)
    await this.db.prepare('UPDATE agents SET skill_level=?, skill_level_locked=?, updated_at=? WHERE name=?')
      .bind(finalLevel, finalLocked, now, name).run()
    return await this.findByName(name)
  }

  async updateStats(name, { total_tasks_completed, total_projects_participated }) {
    const now = new Date().toISOString()
    await this.db.prepare(
      'UPDATE agents SET total_tasks_completed=?, total_projects_participated=?, last_active_at=?, updated_at=? WHERE name=?'
    ).bind(total_tasks_completed, total_projects_participated, now, now, name).run()
  }

  // 실행 인프라 재설계(execution-infra-redesign.md §0.1, v3): tasks 는 완전 통합으로 쓰기 동결됐다.
  // agent_name → assignee_agent_name, status='completed' → status='done'(commands 8상태) 그대로 대응.
  async getStats(agentName) {
    const tasks = await this.db.prepare('SELECT COUNT(*) as cnt FROM commands WHERE assignee_agent_name = ? AND status = ?').bind(agentName, 'done').first()
    const projects = await this.db.prepare('SELECT COUNT(DISTINCT project_id) as cnt FROM commands WHERE assignee_agent_name = ?').bind(agentName).first()
    return { total_tasks_completed: tasks?.cnt || 0, total_projects_participated: projects?.cnt || 0 }
  }

  async getActivities(agentName, limit = 20) {
    return (await this.db.prepare('SELECT * FROM activity_logs WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?').bind(agentName, limit).all()).results
  }

  async getLearningLogs(agentName, limit = 50) {
    return (await this.db.prepare('SELECT * FROM agent_learning_logs WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?').bind(agentName, limit).all()).results
  }

  async addLearningLog({ id, agent_name, type, title, content, source }) {
    const now = new Date().toISOString()
    await this.db.prepare(
      'INSERT INTO agent_learning_logs (id, agent_name, type, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, agent_name, type, title, content || null, source || null, now).run()
    return { id, agent_name, type, title, content, source, created_at: now }
  }
}
