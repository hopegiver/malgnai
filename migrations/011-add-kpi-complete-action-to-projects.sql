-- 011-add-kpi-complete-action-to-projects.sql
-- 2026-07-14: 모든 KPI 달성 시 자율운영을 끌지(off) 계속 진행할지(continue) 프로젝트별로 선택.
-- 기본값 'continue' — KPI 달성이 "완료"가 아니라 "다음 KPI로 계속 개선"을 의미하는 프로젝트가
-- 기본이라(malgnai 자신 포함), 자가평가성 KPI 하나로 루프가 조용히 꺼지는 사고를 막는다.
-- 값: 'continue'(기본, autonomy_enabled 유지) | 'off'(기존 동작, autonomy_enabled='0' 자동 설정).

ALTER TABLE projects ADD COLUMN kpi_complete_action TEXT DEFAULT 'continue';
