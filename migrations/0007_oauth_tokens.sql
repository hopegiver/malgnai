-- Migration number: 0007 	 2026-08-11T00:00:00.000Z
--
-- OAuth 2.1(PKCE) MCP 인증 도입 — 기존 device_token 수동발급(pair-init/pair-approve) 방식은
-- 그대로 병행 유지하고, OAuth 경유 발급 경로를 추가한다(mcp/device-auth.js는 변경 없음 — OAuth로
-- 발급된 access_token도 결국 opaque token이고 device_tokens.token_hash에 SHA-256 해시로 저장되는
-- 기존 구조를 그대로 재사용하므로 /mcp 인증 검증 코드는 손댈 필요가 없다).
--
-- 사전등록(트러스트) client_id 경로 + DCR(RFC 7591, Dynamic Client Registration) 폴백을 함께
-- 구현한다(대표 결정 — malgn-agent 플러그인의 마켓플레이스 배포경로에서 oauth.clientId가 보존되는지
-- 불확실한 오픈 버그 anthropics/claude-ai-mcp#359 때문에 DCR 폴백을 처음부터 함께 둠).
--
-- SQLite(D1)는 CREATE TABLE에 IF NOT EXISTS를 관용적으로 붙이지 않아도, 마이그레이션 러너가
-- 체크섬으로 1회만 실행함을 보장하므로 재실행 시 별도 조치는 불필요하다(migrations/README.md,
-- 0004/0005 파일과 동일 관례).

-- 인가 코드(authorization_code grant). code 자체는 평문 PK로 저장한다 — code 단독으로는 토큰
-- 교환이 불가능하고(PKCE code_verifier가 반드시 함께 필요) 60초 TTL의 1회용 값이라 해시 불필요.
CREATE TABLE oauth_authorization_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256' CHECK(code_challenge_method = 'S256'),
  scope TEXT,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);

-- OAuth refresh token — device_tokens(access token)와 1:1로 연결되는 회전형 opaque 토큰.
-- server/dao/refresh-tokens.js(웹 로그인용)와 동일 알고리즘(회전+10초 grace window+재사용탐지)을
-- server/lib/rotating-token.js 공용 함수로 이 테이블에도 적용한다.
CREATE TABLE oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  device_token_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotated','revoked')),
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR revoke_reason IN ('rotated','device_revoked','reuse_detected')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_oauth_refresh_device ON oauth_refresh_tokens(device_token_id, status);

-- DCR(RFC 7591)로 등록된 클라이언트. 사전등록 트러스트 클라이언트(env var
-- TRUSTED_MALGN_AGENT_CLIENT_ID, server/lib/oauth-trusted-clients.js)는 이 테이블에 없다 —
-- 이 테이블에 있는 client_id는 전부 "미검증(self-registered)" 취급(동의 화면 경고 배지 용도).
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none' CHECK(token_endpoint_auth_method = 'none'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_oauth_clients_created ON oauth_clients(created_at DESC);
