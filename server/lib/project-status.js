// project-status.js — 프로젝트 "라이프사이클 상태"(projects.status)의 단일 계약(순수 모듈).
//
// 라이프사이클(대기/진행/완료/보류)은 "사람 또는 AI 가 명시적으로 선언하는 단계 의도"이고,
//   가동상태(activity_status, 파생)와 직교한다. 이 값을 바꾸는 경로는 둘 뿐이며 **둘 다 이 계약을 공유**한다:
//     1) 웹  PUT /api/projects/:id/status  (사람, JWT) — server/api/projects.js
//     2) MCP project_status_set             (AI 에이전트) — mcp/tools/project.js
//   DB 접근 API 가 서로 달라(웹=async D1 어댑터, MCP=sync better-sqlite3) 쓰기 구현은 각자 하되,
//   허용값·검증·감사로그 포맷은 여기 하나로 통일해 전이 규약이 갈라지지 않게 한다.
//
// 순수(부수효과·DB 의존 없음) — 웹/서버와 MCP 양쪽에서 안전하게 import 한다.

// schema.sql 의 CHECK(status IN (...)) 와 반드시 일치. 변경 시 schema.sql 도 함께 고칠 것.
// 'deleted' = 소프트delete(사람이 삭제 누르거나 sync가 workspace 폴더 소실을 감지했을 때). 하드delete
//   대신 상태 전이로 처리해 decisions/issues/memories 등 project_id 참조를 끊지 않는다(이슈 884f02bf 회피).
export const PROJECT_STATUS_VALUES = ['pending', 'active', 'completed', 'on_hold', 'deleted']

// 표시 라벨(감사로그·안내 메시지용). 프론트는 자체 라벨을 쓰지만 서버/MCP 로그 일관성을 위해 공유.
export const PROJECT_STATUS_LABELS = {
  pending: '대기',
  active: '진행',
  completed: '완료',
  on_hold: '보류',
  deleted: '삭제됨',
}

export function isValidProjectStatus(s) {
  return typeof s === 'string' && PROJECT_STATUS_VALUES.includes(s.trim())
}

// 넘어온 값을 정규화(trim). 유효하지 않으면 null.
export function normalizeProjectStatus(s) {
  if (typeof s !== 'string') return null
  const v = s.trim()
  return PROJECT_STATUS_VALUES.includes(v) ? v : null
}

// 감사로그(activity_logs) 표준 표현 — 웹/MCP 전이가 동일 action·detail 로 남게 한다.
//   action='project_status_change', detail='라이프사이클 <from> → <to>[ (사유)]'.
export const PROJECT_STATUS_CHANGE_ACTION = 'project_status_change'

export function projectStatusChangeDetail(fromStatus, toStatus, reason) {
  const base = `라이프사이클 ${fromStatus} → ${toStatus}`
  const r = typeof reason === 'string' ? reason.trim() : ''
  return r ? `${base} (${r})` : base
}
