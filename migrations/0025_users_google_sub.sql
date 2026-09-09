-- Migration number: 0025 	 2026-09-09T00:01:00.000Z
--
-- Google 계정 연결 식별자. 설계 정본: docs/design/google-oauth-login.md 결정 1·3
-- NULL = 아직 Google을 연결하지 않은 계정(자체인증만 사용).
-- ⚠️ users 테이블은 재작성하지 않는다(인증 뿌리 테이블 + 배포된 코드와의 하위호환) —
--    migrations/0020(employee_id)과 완전히 같은 형태. 따라서 CHECK 제약은 두지 않고
--    형식 검증은 API 계층(google-oidc.js)이 담당한다.
-- ⚠️ password_hash는 NOT NULL 그대로 둔다 — 자동 프로비저닝을 하지 않으므로(결정 2)
--    모든 Google 사용자는 관리자가 발급한 계정을 이미 갖고 있어 nullable 전환이 아무 문제도 풀지 않는다.
--    (architecture.md §6.4의 "SSO 도입 시 password_hash nullable" 예고는 이 결정으로 대체된다)
ALTER TABLE users ADD COLUMN google_sub TEXT;

-- 부분 UNIQUE 인덱스: 하나의 Google 계정이 두 hub 계정에 연결되는 상태를 DB 수준에서 봉쇄한다.
-- NULL은 색인하지 않으므로 미연결 사용자가 몇 명이든 공존한다(idx_users_employee_id와 동일 패턴).
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- 백필 없음 — 기존 사용자는 첫 Google 로그인 성공 시 TOFU로 채워진다(결정 1 C5).

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(재실행 시 "duplicate
-- column"류 에러가 나도 별도 조치 불필요 — 러너가 애초에 재실행하지 않는다, migrations/0020 선례).
