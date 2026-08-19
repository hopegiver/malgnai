// repositoryKey 정규화 — Windows 파일시스템 관례(대소문자 무시)에 맞춰 소문자화하고
// 끝 슬래시를 제거한다. 저장(project_bootstrap)과 조회(admin listByRepositoryKey) 양쪽에서
// 반드시 같은 규칙을 써야 "MyApp"과 "myapp/"이 서로 다른 값으로 어긋나지 않는다.
export function normalizeRepositoryKey(repositoryKey) {
  if (typeof repositoryKey !== 'string') return ''
  return repositoryKey.trim().toLowerCase().replace(/\/+$/, '')
}
