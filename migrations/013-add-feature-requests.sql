-- 013-add-feature-requests.sql
-- 2026-07-14: 사용자 "기능 개선 요청" 제출 → 엔진 완전자동 심사(사람 승인 개입 없음) 파이프라인의
-- 신규 테이블. 승인 판정은 engine/feature-review.js가 매 엔진 틱마다 pending 1건을 claim해
-- claude로 수행하고, 승인되면 memories(FEEDBACK)에 적재되어 기존 project_cycle이 다음 자율
-- 사이클에서 그대로 반영한다(새 실행 파이프라인 없음 — 기존 project_cycle → 승인함 게이트 재사용).
-- status: pending(대기) -> reviewing(claim, 엔진 심사 중) -> approved|rejected(종결).
-- 사람이 개입하는 PATCH(수동 승인/반려) 라우트는 의도적으로 없다(완전자동 심사 요구사항).

CREATE TABLE IF NOT EXISTS feature_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewing','approved','rejected')),
  review_reason TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_project ON feature_requests (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests (status, created_at);
