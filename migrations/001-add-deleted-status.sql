-- 001-add-deleted-status.sql
-- projects.status CHECK 제약에 'deleted'(소프트delete) 추가.
-- SQLite는 CHECK 제약을 ALTER로 바꿀 수 없어 테이블을 재생성해 옮긴다.
-- ⚠️ 이미 적용됨(2026-07-08). 이 파일은 재실행되지 않는다.
-- ⚠️ 교훈: better-sqlite3(macOS)는 PRAGMA foreign_keys = ON으로 컴파일됨.
--    DROP TABLE projects 가 ON DELETE CASCADE/SET NULL 을 트리거해
--    commands 29건 삭제 + activity_logs/decisions/issues/memories project_id NULL화 발생.
--    bin/db-migrate.js가 마이그레이션 전후로 FK 를 비활성화하도록 수정됨(2026-07-08).
--    데이터는 pre-db-migrate-2026-07-08T09-54-00-451Z.db 백업에서 복구됨.

CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','completed','on_hold','deleted')),
  path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT DEFAULT 'dev',
  lead_agent_name TEXT,
  goal TEXT,
  kpi_json TEXT,
  autonomy_level TEXT DEFAULT 'L1',
  cadence TEXT,
  autonomy_enabled TEXT DEFAULT '0',
  owner_user_id TEXT,
  next_run_at TEXT,
  last_run_at TEXT
);

INSERT INTO projects_new (id, name, description, status, path, created_at, updated_at, kind, lead_agent_name, goal, kpi_json, autonomy_level, cadence, autonomy_enabled, owner_user_id, next_run_at, last_run_at)
SELECT id, name, description, status, path, created_at, updated_at, kind, lead_agent_name, goal, kpi_json, autonomy_level, cadence, autonomy_enabled, owner_user_id, next_run_at, last_run_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_user_id);
