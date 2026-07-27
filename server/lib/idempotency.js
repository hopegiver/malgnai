// idempotency_key 파싱 공통 유틸 — record_work/record_decision/record_issue/wbs_add가 공유.
// 형식(mcp-tools.md): `{deviceId}:{claudeSessionId}:{unixTs}:{kind}`.
// claudeSessionId를 정규화해 decisions/issues/works/wbs_items.session_id 컬럼에 저장한다
// (architecture.md §0 결정18 — 세션↔작업이력 상관관계를 위한 선제 컬럼).
export function parseIdempotencyKey(key) {
  if (!key || typeof key !== 'string') return { deviceId: null, sessionId: null }
  const parts = key.split(':')
  if (parts.length < 2) return { deviceId: null, sessionId: null }
  return { deviceId: parts[0] || null, sessionId: parts[1] || null }
}
