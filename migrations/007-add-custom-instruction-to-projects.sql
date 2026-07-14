-- 007-add-custom-instruction-to-projects.sql
-- 2026-07-13: project_cycle 프롬프트 3계층 분리(고정/DB전역진화/프로젝트별추가) 중 프로젝트별
-- 추가 지시를 담을 컬럼. NULL이면 전역 자유 지시(app_settings.project_cycle_prompt)만 사용.

ALTER TABLE projects ADD COLUMN custom_instruction TEXT;
