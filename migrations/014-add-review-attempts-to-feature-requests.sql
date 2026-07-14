-- 014-add-review-attempts-to-feature-requests.sql
-- 2026-07-14: reviewer 지적(Major) — engine/feature-review.js가 심사 실패를 무조건 'pending'으로
-- 되돌리는데, claimNextPending()이 항상 "가장 오래된 pending"을 집기 때문에 영구 실패 요청 1건이
-- 재시도 상한 없이 큐 전체를 무기한 정지시킬 수 있었다. 실패 횟수를 세어 상한(engine/feature-review.js
-- 의 MAX_REVIEW_ATTEMPTS) 초과 시 'rejected'로 종결시키기 위한 카운터 컬럼.

ALTER TABLE feature_requests ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0;
