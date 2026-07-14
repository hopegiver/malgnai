-- 010-add-options-json-to-commands.sql
-- 2026-07-14: 무인 워커가 승인함(command_add)에 "선택지가 있는 질문"을 올릴 때(AskUserQuestion을
-- 못 쓰는 헤드리스 상황의 대체 경로) 옵션을 구조화해서 저장하기 위한 컬럼.
-- 값 형식: JSON 문자열 배열 [{"label": string, "description"?: string}, ...] (AskUserQuestion과 동일 shape).
-- NULL이면 선택지 없는 일반 자유텍스트 질문.

ALTER TABLE commands ADD COLUMN options_json TEXT;
