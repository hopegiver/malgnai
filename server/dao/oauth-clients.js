// oauth_clients 테이블 DAO — DCR(RFC 7591)로 등록된 클라이언트. 사전등록 트러스트 클라이언트는
// 이 테이블에 없다(server/lib/oauth-trusted-clients.js 참고) — 여기 있는 client_id는 전부
// "미검증(self-registered)" 취급한다.
import { generateOpaqueToken } from '../lib/tokens.js'

export async function insert(db, { clientId, clientName, redirectUris }) {
  const id = clientId || generateOpaqueToken()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, status, created_at)
     VALUES (?, ?, ?, 'none', 'active', ?)`
  ).bind(id, clientName || null, JSON.stringify(redirectUris), now).run()
  return { client_id: id, client_name: clientName || null, redirect_uris: redirectUris, created_at: now }
}

export async function findById(db, clientId) {
  return db.prepare("SELECT * FROM oauth_clients WHERE client_id = ? AND status = 'active'").bind(clientId).first()
}
