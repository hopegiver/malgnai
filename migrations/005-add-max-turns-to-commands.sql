-- 005-add-max-turns-to-commands.sql
-- 2026-07-10: commands 테이블에 max_turns 컬럼 추가
-- spawn-due가 project_cycle 명령 시 max_turns를 설정하도록 수정 (issue dd59cc34)

ALTER TABLE commands ADD COLUMN max_turns INTEGER DEFAULT 0;
