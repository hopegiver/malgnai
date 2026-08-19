-- Migration number: 0006 	 2026-08-05T11:39:23.941Z
--
-- catalog_items / catalog_item_versions / catalog_promotions / catalog_scores —
-- 회사 Claude Code 플러그인(`malgn-dev`, GitHub `hopegiver/claude-plugins`) 카탈로그
-- (agents/skills/knowledge) 웹 조회용. server/lib/catalog-sync.js가 GitHub에서 동기화하고,
-- server/api/catalog.js가 읽기 전용으로 노출한다. 기존 agent_learnings/agent_scores(migrations
-- 0005, user_id+agent_name 스코프 — 개인이 에이전트를 쓰며 쌓는 경험/점수)와는 별개 축이다:
-- 여기는 "회사가 배포하는 자산 카탈로그 자체"를 다룬다.
--
-- v1 범위는 scope='company'(malgn-dev 카탈로그)만 실사용한다. scope='private'(직원 개인 로컬
-- 자산 동기화)는 이번 스코프가 아니지만, 나중에 재작업 없이 얹을 수 있도록 owner_user_id 컬럼과
-- 부분 유니크 인덱스를 지금 함께 만들어둔다.
--
-- SQLite(D1)는 CREATE TABLE에 IF NOT EXISTS를 관용적으로 붙이지만, 마이그레이션 러너가
-- 체크섬으로 1회만 실행함을 보장하므로 재실행 시 별도 조치는 불필요하다(migrations/README.md,
-- 0004/0005 파일과 동일 관례).

CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('company','private')) DEFAULT 'company',
  owner_user_id TEXT,        -- scope='company'면 NULL. scope='private'용으로 열어둔 컬럼(v1엔 항상 NULL,
                              -- 실제 private 동기화 구현은 v1.5).
  plugin_name TEXT NOT NULL, -- v1엔 'malgn-dev' 고정(GitHub hopegiver/claude-plugins 저장소 내 플러그인 디렉터리명)
  item_type TEXT NOT NULL CHECK(item_type IN ('agent','skill','knowledge')),
  slug TEXT NOT NULL,        -- agent/skill = 파일명(확장자 제외)/폴더명, knowledge = '카테고리/파일명'
  display_name TEXT,         -- frontmatter name(agent/skill) 또는 첫 H1(knowledge). 파싱 실패 시 NULL
                              -- (조용히 항목을 빼지 않고 NULL로 포함 — 비정상 케이스도 눈에 보이게)
  description TEXT,          -- frontmatter description(agent/skill만, knowledge는 항상 NULL)
  source_path TEXT NOT NULL, -- repo 내 상대경로(예: malgn-dev/agents/backend-dev.md)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- scope별로 다른 유니크 제약: company는 (plugin_name,item_type,slug), private는 (owner_user_id,item_type,slug).
-- 한 컬럼 조합으로 둘 다 감당할 수 없어(company는 owner_user_id가 항상 NULL이라 유니크가 안 먹음)
-- 부분 인덱스 2개로 분리한다.
CREATE UNIQUE INDEX idx_catalog_items_company ON catalog_items(plugin_name, item_type, slug) WHERE scope = 'company';
CREATE UNIQUE INDEX idx_catalog_items_private ON catalog_items(owner_user_id, item_type, slug) WHERE scope = 'private';

CREATE TABLE catalog_item_versions (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id),
  content_sha TEXT NOT NULL,  -- v1: GitHub git blob sha(tree API가 주는 값 그대로, 변경감지용).
                               -- private 스코프 도입 시(로컬 파일 동기화) 다른 해시 방식(예: content
                               -- sha256)을 쓸 수 있다는 점을 이 컬럼 의미에 포함해둔다 — "GitHub blob sha"로
                               -- 컬럼명을 좁히지 않고 범용 content_sha로 이름 지은 이유.
  content_md TEXT NOT NULL,   -- 원본 마크다운 전문
  synced_at TEXT NOT NULL
);
-- content_sha가 이전 최신 버전과 같으면 새 행을 만들지 않는다(catalog-sync.js) — 매 동기화마다
-- 버전이 무한정 쌓이지 않도록.
CREATE INDEX idx_civ_item_synced ON catalog_item_versions(catalog_item_id, synced_at DESC);

CREATE TABLE catalog_promotions (
  id TEXT PRIMARY KEY,
  catalog_item_version_id TEXT NOT NULL REFERENCES catalog_item_versions(id),
  status TEXT NOT NULL CHECK(status IN ('draft','review','promoted','deprecated')),
  reviewer TEXT,
  note TEXT,
  origin_item_version_id TEXT,  -- private→company 승격 시 fork 원본 catalog_item_versions.id pin용
                                 -- (v1엔 항상 NULL — private 스코프 자체가 아직 없어 승격 이벤트도 없음)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_catalog_promotions_version ON catalog_promotions(catalog_item_version_id, created_at DESC);

CREATE TABLE catalog_scores (
  id TEXT PRIMARY KEY,
  catalog_item_version_id TEXT NOT NULL REFERENCES catalog_item_versions(id),
  overall_score REAL,
  dimension_scores TEXT,    -- JSON, nullable(agent_scores.dimension_scores와 동일 패턴, migrations 0005)
  rater_type TEXT NOT NULL CHECK(rater_type IN ('evaluator','personal_aggregate','self_service')),
  rater_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,  -- boolean(0/1) — evaluator 채점만 1(공식 점수), 나머지는 항상 0
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_catalog_scores_version ON catalog_scores(catalog_item_version_id, created_at DESC);
