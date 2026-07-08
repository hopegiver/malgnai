export default class AgentsDao {
  constructor(db) { this.db = db }

  async findAll({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
      return (await this.db.prepare('SELECT name, role, description, status, skill_level, learning_status, skills, team, job_title, model, forbidden_tasks, approval_required_tasks, total_tasks_completed, total_projects_participated, last_active_at, created_at, updated_at FROM agents WHERE status = ? ORDER BY name LIMIT ? OFFSET ?').bind(status, limit, offset).all()).results
    }
    return (await this.db.prepare('SELECT name, role, description, status, skill_level, learning_status, skills, team, job_title, model, forbidden_tasks, approval_required_tasks, total_tasks_completed, total_projects_participated, last_active_at, created_at, updated_at FROM agents ORDER BY name LIMIT ? OFFSET ?').bind(limit, offset).all()).results
  }

  async findByName(name) {
    return await this.db.prepare('SELECT * FROM agents WHERE name = ?').bind(name).first()
  }

  async upsert({ name, role, description, status, md_content, md_hash, skills, knowledge, skill_level, team, job_title, model, forbidden_tasks, approval_required_tasks }) {
    const now = new Date().toISOString()
    await this.db.prepare(
      `INSERT INTO agents (name, role, description, status, md_content, md_hash, skills, knowledge, skill_level, team, job_title, model, forbidden_tasks, approval_required_tasks, learning_status, total_tasks_completed, total_projects_participated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET role=excluded.role, description=excluded.description, status=excluded.status, md_content=excluded.md_content, md_hash=excluded.md_hash, skills=excluded.skills, knowledge=excluded.knowledge, skill_level=COALESCE(excluded.skill_level, agents.skill_level), team=excluded.team, job_title=excluded.job_title, model=excluded.model, forbidden_tasks=excluded.forbidden_tasks, approval_required_tasks=excluded.approval_required_tasks, updated_at=excluded.updated_at`
    ).bind(name, role, description || null, status || 'active', md_content || null, md_hash || null, skills || null, knowledge || null, skill_level || 'beginner', team || null, job_title || null, model || null, forbidden_tasks || null, approval_required_tasks || null, now, now).run()
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
