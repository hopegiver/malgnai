-- Migration number: 0026 	 2026-09-09T00:02:00.000Z
--
-- audit_logs.action CHECK에 'auth.google' 1개를 추가한다.
-- 설계 정본: docs/design/google-oauth-login.md 결정 3·8
--
-- ⚠️ 액션 값을 여러 개('…linked'/'…denied'/…)가 아니라 **1개**로 통합하고 구분은
--    metadata.op(linked|denied) + metadata.reason으로 한다 — action은 CHECK 화이트리스트라
--    값을 늘릴 때마다 테이블 전체 재작성이 필요하다(0009·0018·0021·0023이 명시한 규율).
--
-- SQLite(D1)는 CHECK를 ALTER로 바꿀 수 없어 0009·0018·0021·0023과 동일 패턴
-- ("새 테이블 생성 → INSERT SELECT 복사 → DROP → RENAME → 인덱스 재생성")을 쓴다.
CREATE TABLE audit_logs_new (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'user.role_changed',
    'device_token.issued','device_token.revoked',
    'admin.cross_user_view',
    'oauth_client.registered',
    'oauth_refresh_token.reuse_detected',
    'admin.usage_sync',
    'user.employee_id_changed',
    'shared_workstation.changed',
    'auth.google'
  )),
  target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
);
INSERT INTO audit_logs_new SELECT * FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
-- target_type='user', target_id=<user_id>라 idx_audit_target이 "이 사용자의 Google 연결/거부 이력"
-- 조회를 그대로 커버한다 — 신규 인덱스 불필요.

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(재실행 시 에러가 나도
-- 별도 조치 불필요 — 러너가 애초에 재실행하지 않는다, migrations/0020 선례).
