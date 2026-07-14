// server/lib/project-child-tables.js — project_id 를 갖는 자식 테이블 목록의 단일 소스.
//
// 배경(2026-07-14 사고, decision 원인 참고): FK가 전부 제거된 뒤(migrations/003-drop-foreign-keys.sql)
// DB 엔진 레벨 CASCADE 가 없어, 프로젝트를 지울 때 이 목록을 순회하며 명시적으로 자식 행을 먼저
// 지워야 한다. 원래 이 배열이 server/dao/projects.js·bin/cleanup-test-data.js·test/helpers.js
// 세 곳에 각각 하드코딩돼 있었는데, 스키마에 project_id 컬럼을 가진 테이블이 새로 추가될 때
// 셋 중 하나만 갱신되면 그 경로에서만 다시 고아 행이 쌓이는 재발 위험이 있어 단일 모듈로 통합한다.
//
// ⚠️ 새 테이블에 project_id 컬럼을 추가하면 반드시 이 배열도 함께 갱신할 것(schema.sql 대조).
// feature_requests 는 의도적으로 제외한다 — 사용자 프로젝트가 아니라 malgnai 플랫폼 자신에게
// 고정 귀속되는 공유 백로그라 프로젝트 삭제와 무관하다(test/helpers.js cleanupTestFeatureRequests
// 와 동일 근거, title 접두사로 별도 정리).
export const PROJECT_CHILD_TABLES = ['commands', 'activity_logs', 'decisions', 'issues', 'memories', 'project_collaborators']
