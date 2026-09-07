-- Migration number: 0021 	 2026-09-07T09:05:00.000Z
--
-- audit_logs.action CHECK 제약에 'user.employee_id_changed'를 추가한다.
-- 사용량 연동 아이디(users.employee_id) 변경은 "A의 사용량을 B에게 붙이는" 조작이라
-- 되돌리기와 사후 추적이 가능해야 한다(설계 docs/design/usage-employee-identity-linking.md §5.5).
-- SQLite(D1)는 CHECK 제약을 ALTER로 바꿀 수 없으므로 migrations/0009·0018과 동일한 패턴
-- ("새 테이블 생성 → INSERT SELECT 복사 → DROP → RENAME")을 쓴다.
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
    'user.employee_id_changed'
  )),
  target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
);
INSERT INTO audit_logs_new SELECT * FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
