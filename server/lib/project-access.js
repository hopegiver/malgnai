/**
 * project-access.js — 프로젝트 소유권/공유 접근 판정 공유 헬퍼.
 *
 * 소유 = projects.owner_user_id(=username), 공유 접근 = project_collaborators(user=username).
 * ⚠️ role(admin/user)과 무관하게 이 기준으로만 판정한다 — admin과 user는 권한상 완전히 동일하다
 *   (라벨만 다름, 둘 다 프로젝트 소유권/공유 기준으로만 스코핑). role 기반 분기를 여기 섞으면
 *   이 스코핑 자체가 무력화된다.
 *
 * ⚠️ 유일한 예외 = super_admin 읽기전용 모니터링 bypass(getMonitorableProject, 2026-07-14 신설).
 *   role='super_admin'이면 소유권/공유 여부와 무관하게 프로젝트를 조회할 수 있다 — 단 GET 계열
 *   (목록/상세/타임라인/파일 등) 전용이다. PUT/DELETE 등 쓰기 라우트는 이 bypass 를 쓰지 않고
 *   여전히 getProjectRole/roleAtLeast(소유자/editor 공유자만)로만 판정한다(쓰기 우회는 스코프 밖 —
 *   super_admin이라고 남의 프로젝트를 마음대로 수정/삭제할 수 있게 만들지 않는다).
 *
 * 정보누출 방지: 접근권 없는 프로젝트는 403이 아니라 "없음"(null → 호출부가 404)으로 응답한다
 *   — 존재 자체를 숨긴다(이 앱의 기존 방침, projects.js 다른 라우트와 통일. super_admin 은 애초에
 *   이 방침의 영향을 받지 않고 항상 조회된다).
 */

const ROLE_RANK = { owner: 3, editor: 2, viewer: 1 }

/**
 * getProjectRole — username의 프로젝트 내 역할.
 *   소유자 → 'owner', project_collaborators 공유 → 'viewer'|'editor', 그 외 → null(접근 불가).
 */
export async function getProjectRole(db, project, username) {
  if (!project || !username) return null
  if (project.owner_user_id === username) return 'owner'
  const row = await db.prepare(
    'SELECT role FROM project_collaborators WHERE project_id = ? AND user = ?'
  ).bind(project.id, username).first()
  return row?.role || null
}

/** role이 minRole 이상 권한인지(owner > editor > viewer). role이 null이면 항상 false. */
export function roleAtLeast(role, minRole) {
  return !!role && (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0)
}

/**
 * getAccessibleProject — projectsDao.findById로 프로젝트를 조회하고, username이 소유자/협업자가
 *   아니면 null을 반환한다(호출부는 이 null을 404로 취급 — notFound(c, ...)).
 */
export async function getAccessibleProject(db, projectsDao, projectId, username) {
  if (!projectId) return null
  const project = await projectsDao.findById(projectId)
  if (!project) return null
  const role = await getProjectRole(db, project, username)
  return role ? project : null
}

/**
 * projectAccessWhere — 목록 쿼리(SQL)에 주입할 소유권/공유 WHERE 조각 + bind 값.
 *   ownerCol/idCol은 별칭 포함 컬럼명을 그대로 넘긴다(예: 'p.owner_user_id','p.id').
 */
export function projectAccessWhere(ownerCol, idCol) {
  return {
    sql: `(${ownerCol} = ? OR ${idCol} IN (SELECT project_id FROM project_collaborators WHERE user = ?))`,
    bind: (username) => [username, username],
  }
}

/**
 * getMonitorableProject — super_admin 전용 읽기 전용 모니터링 우회.
 *
 *   role==='super_admin'이면 소유권/공유 여부와 무관하게 projectsDao.findById 결과를 그대로
 *   반환한다(없으면 null → 호출부 404, 이건 super_admin 이라도 동일). 그 외 role은 기존
 *   getAccessibleProject(소유자/협업자 기준)로 그대로 위임한다 — admin/user 차이는 없다.
 *
 *   ⚠️ GET 라우트에서만 사용한다. PUT/DELETE/status 등 쓰기 라우트는 계속 getProjectRole+
 *   roleAtLeast(role,'editor')를 직접 써서 소유자/editor 공유자만 허용해야 한다(이 함수를
 *   쓰기 라우트에 쓰면 super_admin의 남의 프로젝트 쓰기 우회가 열려버린다 — 스코프 밖).
 */
export async function getMonitorableProject(db, projectsDao, projectId, username, role) {
  if (!projectId) return null
  if (role === 'super_admin') return await projectsDao.findById(projectId)
  return await getAccessibleProject(db, projectsDao, projectId, username)
}
