// oauth_authorization_codes 테이블 DAO — OAuth 2.1(PKCE) authorization_code grant.
// code는 해시하지 않고 평문 PK로 저장한다: code 단독으로는 토큰 교환이 불가능하고(PKCE
// code_verifier가 반드시 함께 필요) 60초 TTL의 1회용 값이라 해시할 이유가 없다.
import { generateOpaqueToken } from '../lib/tokens.js'

const CODE_TTL_SECONDS = 60

export async function insert(db, { clientId, userId, redirectUri, codeChallenge, codeChallengeMethod, scope, deviceName, expiresAt }) {
  const code = generateOpaqueToken()
  const now = new Date().toISOString()
  const expires = expiresAt || new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString()
  await db.prepare(
    `INSERT INTO oauth_authorization_codes
       (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, device_name, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(code, clientId, userId, redirectUri, codeChallenge, codeChallengeMethod || 'S256', scope || null, deviceName || null, expires, now).run()
  return { code, client_id: clientId, user_id: userId, redirect_uri: redirectUri, expires_at: expires, created_at: now }
}

export async function findByCode(db, code) {
  return db.prepare('SELECT * FROM oauth_authorization_codes WHERE code = ?').bind(code).first()
}

/** status='pending' AND 미만료 조건으로 단일 소비(status='consumed'). res.meta.changes>0이면 성공(레이스 방지). */
export async function consume(db, code) {
  const now = new Date().toISOString()
  const res = await db.prepare(
    "UPDATE oauth_authorization_codes SET status='consumed' WHERE code = ? AND status='pending' AND expires_at > ?"
  ).bind(code, now).run()
  return res.meta.changes > 0
}
