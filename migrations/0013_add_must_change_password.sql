-- Migration number: 0013 	 2026-08-25T00:00:00.000Z
--
-- users.must_change_password 컬럼 추가. 관리자가 생성한 계정(임시 비밀번호 또는 초기 통일
-- 비밀번호)이 그 비밀번호로 로그인했을 때 프론트엔드가 비밀번호 변경 화면으로 강제 이동시키기
-- 위한 플래그 — POST /api/auth/login 응답에 포함되고, POST /api/auth/change-password 성공 시
-- 0으로 해제된다(server/api/auth.js).
--
-- 순수 ADD COLUMN(NOT NULL DEFAULT 0)이라 기존 행에 영향 없음.

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
