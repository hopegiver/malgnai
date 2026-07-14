// roles.js — 3단계 role(super_admin/admin/user) 공용 판정 헬퍼.
//
// super_admin(최고관리자) > admin(관리자) > user(일반). ⚠️ admin과 user는 권한상 완전히 동일하다 —
//   차이는 라벨뿐, 둘 다 "자기 소유/공유받은 프로젝트만" 접근한다(project_collaborators/owner_user_id
//   기반 스코핑, server/lib/project-access.js). admin/user 구분에 새 권한 분기를 넣지 않는다.
//
// super_admin 전용 권한: (1) 사용자 관리(user CRUD, server/api/users.js) (2) 자율 제어판 설정
//   (마스터 kill-switch·엔진 설정, server/api/lead.js) (3) 시스템 재시작(server/api/system.js)
//   (4) 시스템/앱 설정 (5) 모든 프로젝트 모니터링(읽기 전용 bypass, server/lib/project-access.js
//   getMonitorableProject) — 단 PUT/DELETE 등 쓰기는 이 bypass 대상이 아니다.
//
// 흩어져 있던 `role !== 'admin'`/`role === 'admin'` 이진 판정을 전부 이 모듈로 교체한다.

export const ROLES = ['super_admin', 'admin', 'user']

/** role이 최고관리자(super_admin)인지. */
export function isSuperAdmin(role) {
  return role === 'super_admin'
}

/** 화이트리스트 밖 값(undefined/오염값 등)은 안전하게 'user'로 폴백. 유효값은 축소 없이 그대로 통과. */
export function normalizeRole(v) {
  return ROLES.includes(v) ? v : 'user'
}
