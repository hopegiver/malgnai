-- Migration number: 0023 	 2026-09-08T02:01:00.000Z
--
-- audit_logs.action CHECK 제약에 공용 워크스테이션 등록/해제 액션을 추가한다.
-- 설계 정본: docs/design/usage-shared-workstation-axes.md §5.4
--
-- ⚠️ 액션 값을 2개('…registered'/'…unregistered')가 아니라 **1개**('shared_workstation.changed')로
--    통합하고 등록/해제 구분은 metadata.op(registered|unregistered)로 한다 — audit_logs.action은
--    CHECK 화이트리스트라 값을 늘릴 때마다 테이블 전체 재작성이 필요하기 때문이다(0009·0018·0021
--    선례). 앞으로 이 도메인에 액션이 더 생겨도 metadata로 흡수한다.
--
-- SQLite(D1)는 CHECK를 ALTER로 바꿀 수 없어 migrations/0009·0018·0021과 동일한 패턴
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
    'shared_workstation.changed'
  )),
  target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
);
INSERT INTO audit_logs_new SELECT * FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
-- idx_audit_target(target_type, target_id, created_at DESC)이 "이 축의 등록/해제 이력"
-- (target_type='shared_workstation', target_id='<employee_id>') 조회를 그대로 커버한다 — 신규 인덱스
-- 불필요.
