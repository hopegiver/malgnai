-- Migration number: 0002 	 2026-07-27T12:00:50.113Z
--
-- refresh_tokens 재사용 탐지 grace window 지원 컬럼 추가.
--
-- [배경] 회전(rotation) 직후 아주 짧은 시간 내(예: 10초 이내)에 같은 stale 토큰이 다시 들어오는
-- 것은 탈취가 아니라 흔한 레이스(두 탭 동시 갱신, 네트워크 재시도로 같은 요청 중복 도달 등)다.
-- 지금까지는 status!='active'면 무조건 탈취로 간주해 유저 전체 세션을 revoke했는데, 이러면 이
-- 흔한 레이스만으로도 정상 사용자가 강제 로그아웃당한다 — 사내 private 프로젝트
-- (~/workspace/malgnai, 2026-07-13 reviewer 리뷰로 재현·수정된 회귀)에서 이미 검증된 패턴을
-- 이 저장소 하우스 스타일(status 컬럼 + revoke_reason/revoked_at)로 이식한다.
--
-- revoke_reason: 'rotated'(정상 회전 — grace window 대상) | 'logout'(명시적 로그아웃, v1엔 아직
-- 로그아웃 라우트가 없어 미사용이지만 스키마는 미리 열어둠) | 'reuse_detected'(탈취 탐지로 일괄
-- 폐기) — 이 값에 따라 grace window 적용 여부가 갈린다(server/api/auth.js /refresh 참고).
ALTER TABLE refresh_tokens ADD COLUMN revoke_reason TEXT
  CHECK(revoke_reason IS NULL OR revoke_reason IN ('rotated', 'logout', 'reuse_detected'));
