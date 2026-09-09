-- Migration number: 0024 	 2026-09-09T00:00:00.000Z
--
-- Google 로그인(우리가 Google의 **클라이언트**인 축) 1회용 플로우 상태.
-- 설계 정본: docs/design/google-oauth-login.md 결정 3·6
-- ⚠️ server/api/oauth.js(우리가 **제공자**인 축)의 oauth_authorization_codes와 혼동 금지 —
--    그쪽 code_challenge는 우리가 "검증"하는 값이고, 여기 code_verifier는 우리가 "생성"하는 값이다.
--
-- 한 번의 로그인 시도 = 이 테이블 1행. 두 단계 모두 조건부 UPDATE로 1회성을 강제한다
-- (oauth_authorization_codes.consume() 선례).
CREATE TABLE google_login_flows (
  state TEXT PRIMARY KEY,              -- 256비트 opaque(base64url 43자). Google에 그대로 전달
  binding_hash TEXT NOT NULL,          -- sha256(브라우저 쿠키 시크릿) — 로그인 CSRF 차단(결정 6)
  nonce TEXT NOT NULL,                 -- id_token.nonce 대조값
  code_verifier TEXT NOT NULL,         -- PKCE(S256). 토큰 교환에 1회 사용
  redirect_path TEXT,                  -- 로그인 후 이동 경로. '/'로 시작하는 같은 오리진 경로만
  -- 무음 재로그인 여부(결정 10). 콜백이 신뢰할 수 있는 왕복값은 state뿐이라, 무음 여부를
  -- 쿼리스트링으로 되받으면 위조된다 — 반드시 state가 가리키는 이 행에서 읽는다.
  -- 이 값에 따라 에러 표시(조용/표시)와 감사기록 여부가 갈린다(§3.2, 결정 3).
  mode TEXT NOT NULL DEFAULT 'interactive'
    CHECK(mode IN ('interactive','silent')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','authorized','consumed','failed')),
  user_id TEXT,                        -- 콜백 성공 시 확정된 사용자(FK 미사용 — architecture.md §0-15)
  handoff_code_hash TEXT UNIQUE,       -- sha256(핸드오프 코드). 원문은 브라우저 fragment에만 존재
  handoff_expires_at TEXT,             -- 콜백 시각 + 60초
  expires_at TEXT NOT NULL,            -- created_at + 10분(인가 단계 TTL)
  created_at TEXT NOT NULL,
  completed_at TEXT
);
-- 만료행 정리(크론 스윕) 전용. handoff_code_hash 조회는 UNIQUE 제약이 만든 인덱스가 그대로 커버하므로
-- 별도 인덱스를 만들지 않는다(idx_oauth_codes_expires와 동일한 판단).
CREATE INDEX idx_google_login_flows_expires ON google_login_flows(expires_at);

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(재실행 시 "duplicate
-- column"류 에러가 나도 별도 조치 불필요 — 러너가 애초에 재실행하지 않는다, migrations/0020 선례).
