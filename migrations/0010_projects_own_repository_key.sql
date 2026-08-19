-- Migration number: 0010 	 2026-08-11T02:00:00.000Z
--
-- repositories 테이블 폐기 + projects가 repository_key/repository_name을 직접 소유.
--
-- 배경: repositoryKey는 원래 "GitHub 계정/레포"를 의미할 예정이었지만, 프로젝트를 처음 만드는
-- 시점에는 그 값을 알 수 없다(GitHub 연동 전) — 그래서 지금은 워크스페이스 폴더명처럼 사용자가
-- 임의로 붙이는 단순 정보값일 뿐이고, 전역 유니크일 이유가 없다. 기존 설계(repositories.repository_key
-- 전역 UNIQUE)에서는 서로 다른 두 사용자가 우연히 같은 폴더명(예: "api")을 쓰면 무관한 두 프로젝트가
-- 같은 repositories 행으로 합쳐지는 충돌이 구조적으로 있었다. repository_key를 사용자 스코프로
-- 내리면(UNIQUE(user_id, repository_key)) 이 충돌이 원천적으로 사라진다. 향후 GitHub 연동 시
-- repository_key 값을 실제 owner/repo로 갱신하는 것은 이 projects 행의 단순 업데이트로 충분하다.
--
-- repositories가 제공하던 두 기능은 그대로 유지:
--  (1) 프로젝트 상세 화면의 "repository 이름 표시" → projects.repository_name으로 대체.
--  (2) 관리자 전용 "같은 repository_key의 여러 사용자 작업 열람"(GET /api/repositories/:key/projects)
--      → projects.repository_key로 직접 GROUP/필터(idx_projects_repository_key). classification은
--      이미 projects에도 독립 컬럼으로 있어 별도 이관이 필요 없다.
--
-- SQLite는 UNIQUE(user_id, repository_id) 제약에 걸린 컬럼을 ALTER TABLE DROP COLUMN으로 뺄 수
-- 없어(제약 대상 컬럼 DROP 제한) 표준 12-step 테이블 재생성 절차를 쓴다. repository_key는 이관 전
-- repositories.repository_key가 전역 UNIQUE였으므로 (user_id, repository_id)→(user_id,
-- repository_key) 매핑은 손실 없이 그대로 유지된다(참조 무결성이 깨진 고아 행이 있을 가능성만
-- COALESCE로 방어 — house style상 FK 미사용이라 이론상으로만 존재 가능).

CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  repository_name TEXT,
  project_key TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  classification TEXT NOT NULL DEFAULT 'internal' CHECK(classification IN ('internal','confidential')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, repository_key)
);

INSERT INTO projects_new (id, user_id, repository_key, repository_name, project_key, name, status, classification, created_at, updated_at)
SELECT p.id, p.user_id, COALESCE(r.repository_key, p.id), r.name, p.project_key, p.name, p.status, p.classification, p.created_at, p.updated_at
FROM projects p
LEFT JOIN repositories r ON r.id = p.repository_id;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX idx_projects_user_status ON projects(user_id, status);
CREATE INDEX idx_projects_repository_key ON projects(repository_key);

DROP TABLE repositories;
