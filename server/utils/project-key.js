// project-key.js — projects.path ↔ claude_project_sessions.project_key 도출(§4.2).
//
// 실측 규칙(결정론적): project_key = path.replace(/\//g, '-').
//   예) /Users/hopegiver/workspace/malgnai → -Users-hopegiver-workspace-malgnai
//
// 역방향은 손실적('-'가 경로구분/하이픈 모두)이라 **정방향(project→key)만** 쓴다.
// 신규 컬럼/테이블 없이 순수 함수로 매핑 → sync 워커와 조회가 동일 로직 단일 소스.
export function derivedProjectKey(path) {
  if (!path) return null
  return String(path).replace(/\//g, '-')
}
