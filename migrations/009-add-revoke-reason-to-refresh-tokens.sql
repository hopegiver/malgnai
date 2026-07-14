-- 009-add-revoke-reason-to-refresh-tokens.sql
-- 2026-07-13: refresh token 재사용 grace window(REUSE_GRACE_MS, server/lib/refresh-token.js)
-- 도입 중 발견된 버그 수정. revoked_at 만으로는 "정상 회전으로 revoke됨"과 "logout/탈취탐지로
-- revoke됨"을 구분할 수 없어, logout되거나 탈취로 전체 revoke된 토큰도 grace window 이내
-- 재사용되면 그냥 다시 살아나버렸다(reviewer 리뷰 후속 회귀). revoke_reason으로 원인을
-- 구분해 'rotated'(정상 회전)만 grace window 대상으로 삼고, 'logout'/'reuse_detected'는
-- 재사용 시 항상 즉시 거부한다.

ALTER TABLE refresh_tokens ADD COLUMN revoke_reason TEXT;
