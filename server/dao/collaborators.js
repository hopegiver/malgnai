// P0(재설계): project_collaborators DAO — 프로젝트 공유(협업자) 접근 관리.
//
// 소유는 projects.owner_user_id(=username), 공유 접근만 이 테이블에서 다룬다.
// ⚠️ 조인 키는 username 으로 통일(블로커 B1 교정) — user 컬럼에 username 을 저장한다.
//   role: 'viewer'(읽기) | 'editor'(승인함·수정 가능). UNIQUE(project_id,user) 로 이중 공유 차단.
//
// P0 범위에서는 테이블·DAO 만 제공하고, 실제 스코핑(승인함 WHERE 주입)은 P1 에서 배선한다.
export default class CollaboratorsDao {
  constructor(db) { this.db = db }

  // 한 프로젝트의 협업자 목록.
  async listByProject(projectId) {
    return (await this.db.prepare(
      'SELECT id, project_id, user, role, created_at FROM project_collaborators WHERE project_id = ? ORDER BY created_at ASC'
    ).bind(projectId).all()).results
  }

  // 한 사용자가 공유받은 프로젝트 목록(대시보드 "공유받음").
  async listByUser(user) {
    return (await this.db.prepare(
      'SELECT id, project_id, user, role, created_at FROM project_collaborators WHERE user = ? ORDER BY created_at DESC'
    ).bind(user).all()).results
  }

  // 특정 (project,user) 의 role 조회(권한 판정용). 없으면 null.
  async getRole(projectId, user) {
    const row = await this.db.prepare(
      'SELECT role FROM project_collaborators WHERE project_id = ? AND user = ?'
    ).bind(projectId, user).first()
    return row?.role ?? null
  }

  // 멱등 공유 추가(INSERT OR IGNORE — UNIQUE(project_id,user) 이중 공유 차단).
  //   이미 있으면 role 갱신(권한 승격/강등). role 기본 'viewer'.
  async share(projectId, user, role = 'viewer') {
    const now = new Date().toISOString()
    const safeRole = role === 'editor' ? 'editor' : 'viewer'
    await this.db.prepare(
      `INSERT INTO project_collaborators (id, project_id, user, role, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user) DO UPDATE SET role=excluded.role`
    ).bind(crypto.randomUUID(), projectId, user, safeRole, now).run()
    return await this.getRole(projectId, user)
  }

  // 공유 해제.
  async unshare(projectId, user) {
    const res = await this.db.prepare(
      'DELETE FROM project_collaborators WHERE project_id = ? AND user = ?'
    ).bind(projectId, user).run()
    return (res?.meta?.changes || 0) > 0
  }
}
