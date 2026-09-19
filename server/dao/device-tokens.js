// device_tokens 테이블 DAO — MCP 인증 축(architecture.md §6.1). "허용 프로젝트" 컬럼 없음(§0 결정6).
import { newId } from '../lib/ulid.js'

// oauthClientId/expiresAt은 OAuth 발급 경로(server/api/oauth.js)에서만 넘긴다 — 기존 pair-approve
// 호출부(server/api/devices.js)는 이 인자들을 넘기지 않으므로 undefined로 들어와 그대로 NULL
// 바인딩된다(레거시 하위호환, 기존 호출 코드 수정 불필요).
export async function insert(db, { userId, deviceId, deviceName, tokenHash, oauthClientId, expiresAt }) {
  const id = newId()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO device_tokens (id, user_id, device_id, device_name, token_hash, status, oauth_client_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(id, userId, deviceId, deviceName || null, tokenHash, oauthClientId || null, expiresAt || null, now).run()
  return {
    id, user_id: userId, device_id: deviceId, device_name: deviceName || null, status: 'active',
    oauth_client_id: oauthClientId || null, expires_at: expiresAt || null, created_at: now
  }
}

/** OAuth refresh 성공 시 같은 device_tokens 행의 token_hash/expires_at을 갱신한다(새 행을
 *  만들지 않는다 — "하나의 그랜트 = 하나의 device_tokens 행"을 유지). */
export async function rotateToken(db, id, { tokenHash, expiresAt }) {
  await db.prepare(
    "UPDATE device_tokens SET token_hash = ?, expires_at = ? WHERE id = ? AND status = 'active'"
  ).bind(tokenHash, expiresAt || null, id).run()
}

// 계정 상태 게이트(docs/security/device-token-revocation-investigation-2026-09-19.md §5 후보A) —
// device_tokens.status='active'만으로는 users.status='disabled'로 전환된 계정의 잔존 토큰을
// 걸러내지 못한다(비활성화가 캐스케이드 폐기를 항상 동반한다고 가정하지 않는다 — 이 JOIN이 유일한
// 구조적 방어선이다). dt.*만 SELECT해 반환 shape을 기존과 동일하게 유지한다(호출부 mcp/device-auth.js가
// token.user_id/device_id/expires_at/id/scopes를 그대로 읽는다). user_id가 users에 없는 고아
// device_token은 INNER JOIN이라 자동으로 제외된다(§완료판정 5 "고아 user_id 토큰 → 거부").
export async function findActiveByHash(db, tokenHash) {
  return db.prepare(
    `SELECT dt.* FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
      WHERE dt.token_hash = ? AND dt.status = 'active' AND u.status = 'active'`
  ).bind(tokenHash).first()
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM device_tokens WHERE id = ?').bind(id).first()
}

export async function touchLastUsed(db, id) {
  await db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run()
}

export async function listForUser(db, userId) {
  const { results } = await db.prepare(
    'SELECT id, device_name, status, last_used_at, created_at FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return results
}

/** 즉시 폐기(status='revoked'). 이미 폐기된 토큰은 changes=0. */
export async function revoke(db, id) {
  const now = new Date().toISOString()
  const res = await db.prepare("UPDATE device_tokens SET status='revoked', revoked_at=? WHERE id = ? AND status='active'")
    .bind(now, id).run()
  return res.meta.changes > 0
}

/** 계정 비활성화 캐스케이드 폐기(§완료판정 B, 후보B) — 실행하지 않는 UPDATE builder. 호출부
 *  (server/api/admin-users.js)가 users 상태 UPDATE·연쇄 refresh token 폐기·감사 INSERT와 함께
 *  db.batch()로 한 트랜잭션에 묶어 원자 커밋한다 — "users.status는 이미 disabled로 커밋됐는데
 *  device_token 폐기만 실패해 잔존 토큰이 남는" 반쪽 상태(보고서 §5 후보B 트레이드오프④)를
 *  batch 자체의 all-or-nothing 트랜잭션 보장으로 원천 차단한다(admin-users.js:34 이하 참고,
 *  이 저장소는 이미 employee-id 원자 커밋에 같은 패턴을 쓰고 있다). */
export function buildRevokeAllForUserStatement(db, userId) {
  const now = new Date().toISOString()
  return db.prepare(
    "UPDATE device_tokens SET status='revoked', revoked_at=? WHERE user_id = ? AND status='active'"
  ).bind(now, userId)
}

/** 캐스케이드 감사로그 메타데이터용 사전 카운트(best-effort). 이 값은 batch 실행 직전에 읽은
 *  참고 수치일 뿐 권한 판단에 쓰이지 않는다 — 실제 폐기 여부/개수는 위 buildRevokeAllForUserStatement의
 *  WHERE 조건이 batch 실행 시점에 원자적으로 결정한다(이 카운트와 실제 폐기 개수가 동시 요청 경합으로
 *  어긋나도 안전성에는 영향이 없다, admin-users.js buildUpdateEmployeeIdStatement 주석의 같은 논리). */
export async function countActiveForUser(db, userId) {
  const row = await db.prepare("SELECT COUNT(*) AS cnt FROM device_tokens WHERE user_id = ? AND status = 'active'").bind(userId).first()
  return row ? row.cnt : 0
}
