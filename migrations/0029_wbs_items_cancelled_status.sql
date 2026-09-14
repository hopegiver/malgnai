-- Migration number: 0029 	 2026-09-15T00:00:00.000Z
--
-- wbs_items.status CHECK 제약에 'cancelled'를 추가한다(설계: docs/design/wbs-cancelled-status.md).
-- 계획 자체가 무효가 된 항목(예: 아키텍처 전환으로 폐기된 작업)을 done(거짓 주장)도 planned
-- (진행률 영구 왜곡)도 아닌 값으로 표현하기 위함. 'delayed'는 여전히 저장값이 아니라 조회
-- 시점 계산 bucket이므로 이 enum에 넣지 않는다(docs/schema.sql §3.14).
--
-- SQLite(D1)는 CHECK 제약을 ALTER로 바꿀 수 없으므로 migrations/0009·0018·0021과 동일한 패턴
-- ("새 테이블 생성 → INSERT SELECT 복사 → DROP → RENAME")을 쓴다. wbs_items에는 트리거·뷰·FK가
-- 하나도 없고(FTS5 트리거는 decisions/issues/works 전용, 0001:330~349) 컬럼 구성도 그대로라
-- 재생성으로 유실되는 객체는 인덱스 3개뿐 — 아래에서 동일 정의로 재생성한다.
--
-- 마이그레이션 러너는 체크섬이 아니라 파일명(d1_migrations.name UNIQUE) 기준으로 1회만
-- 기록·실행됨을 보장하므로 재실행 시 별도 조치 불필요. 단, 이미 적용된 이 파일을 내용만
-- 고쳐도 파일명이 그대로면 로컬 DB에는 재적용되지 않고 조용히 갈린다 — 이 파일을 수정할
-- 경우 로컬 D1의 해당 DB를 지우고 전체 재적용하거나 d1_migrations에서 이 행을 지운 뒤
-- 재적용할 것(migrations/README.md 참고).
CREATE TABLE wbs_items_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT CHECK(description IS NULL OR length(description) <= 2000),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','done','cancelled')),
  responsible_team TEXT,
  assignee_agent_name TEXT,
  start_date TEXT,
  end_date TEXT,
  completed_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO wbs_items_new SELECT * FROM wbs_items;
DROP TABLE wbs_items;
ALTER TABLE wbs_items_new RENAME TO wbs_items;
CREATE INDEX idx_wbs_items_project ON wbs_items(project_id, parent_id, seq);
CREATE INDEX idx_wbs_items_project_status ON wbs_items(project_id, status);
CREATE INDEX idx_wbs_items_session ON wbs_items(session_id);
