-- Migration number: 0018 	 2026-09-03T00:00:03.000Z
--
-- m-8 수정(리뷰 2026-09-03, docs/reviewer/review-usage-prometheus-hybrid-2026-09-03.md) —
-- POST /api/admin/usage/sync는 전사 사용량 D1 롤업 캐시에 직접 쓰는 유일한 관리자 라우트인데
-- 감사기록이 없었다. audit_logs.action CHECK 제약에 'admin.usage_sync'를 추가한다.
--
-- SQLite(D1)는 CHECK 제약을 ALTER로 바꿀 수 없으므로 migrations/0009와 동일한 패턴("새 테이블
-- 생성 → INSERT SELECT 복사 → DROP → RENAME")을 쓴다.
--
-- ⚠️ /summary·/users(전사 목록 GET)는 이번에 감사기록을 추가하지 않는다 — 리뷰 자체가 "조회
-- 빈도가 높아 샘플링·일 1회 등 정책 결정이 먼저 필요하다"고 명시했다(m-8). 그 샘플링 정책은
-- backend-dev가 단독으로 정할 사안이 아니라 별도 PM/보안 판단이 필요해 이번 범위에서 뺀다.
CREATE TABLE audit_logs_new (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'user.role_changed',
    'device_token.issued','device_token.revoked',
    'admin.cross_user_view',
    'oauth_client.registered',
    'oauth_refresh_token.reuse_detected',
    'admin.usage_sync'
  )),
  target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
);
INSERT INTO audit_logs_new SELECT * FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
