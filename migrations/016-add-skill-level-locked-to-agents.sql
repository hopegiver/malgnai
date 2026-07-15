-- 016-add-skill-level-locked-to-agents.sql
-- 2026-07-15: 이슈 6a01f9ab 해결. bin/sync-agents.js는 매 실행마다 skill-definitions.js
-- 키워드매칭으로 agents.skill_level/skills를 전면 재계산해 덮어썼다 — 트레이너가 실질평가로
-- 수동 승급시킨 값(예: security advanced→expert)이 다음 sync 때 조용히 되돌아가는 구조였다.
-- 이 플래그가 1이면 sync-agents.js의 일괄 /sync 경로가 skills/skill_level을 건드리지 않고
-- 보존한다(server/dao/agents.js#upsert). 해제/재설정은 PATCH /api/agents/:name/skill-level
-- 로 명시적으로만(잠금 필드를 실어 호출할 때만 잠금 상태 자체가 바뀐다).

ALTER TABLE agents ADD COLUMN skill_level_locked INTEGER NOT NULL DEFAULT 0;
