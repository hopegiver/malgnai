// repositoryKey 정규화 — Windows 파일시스템 관례(대소문자 무시)에 맞춰 소문자화하고
// 끝 슬래시를 제거한다. 저장(project_bootstrap)과 조회(admin listByRepositoryKey) 양쪽에서
// 반드시 같은 규칙을 써야 "MyApp"과 "myapp/"이 서로 다른 값으로 어긋나지 않는다.
//
// 2026-08-19: "/"가 섞인 값(예: git remote 기반 "owner/repo")도 마지막 세그먼트(워크스페이스
// 폴더명)만 남긴다 — CLAUDE.md 템플릿이 안내하는 identity는 항상 폴더명이고, owner/repo prefix는
// 세션마다 달라질 수 있어(로컬 fork alias, org 이름 등) 같은 프로젝트가 다른 repository_key로
// 쪼개지는 원인이었다(예: "malgnsoft/claude-plugins" vs "hopegiver/claude-plugins" vs
// "claude-plugins"가 전부 다른 프로젝트로 생성됨). 개인 소유 projects 모델(§0-9)에서는
// "이 사용자가 이 폴더에 대해 갖는 개인 작업기록"이 곧 identity이므로 owner prefix는 버려도 안전하다.
export function normalizeRepositoryKey(repositoryKey) {
  if (typeof repositoryKey !== 'string') return ''
  const trimmed = repositoryKey.trim().toLowerCase().replace(/\/+$/, '')
  if (!trimmed) return ''
  const lastSlash = trimmed.lastIndexOf('/')
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1)
}
