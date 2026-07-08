import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";
import {
  normalizeProjectStatus,
  PROJECT_STATUS_VALUES,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_CHANGE_ACTION,
  projectStatusChangeDetail,
} from "../../server/lib/project-status.js";

/**
 * project_status_set — 프로젝트 라이프사이클 상태(대기/진행/완료/보류)를 AI 가 직접 선언한다.
 *
 * (상태 이원화 후속 B) 라이프사이클 = "사람 또는 AI 의 명시적 단계 의도"이고 가동상태(파생)와 직교한다.
 *   웹 `PUT /api/projects/:id/status`(사람)와 **동일 계약**(허용값·검증·감사포맷 = lib/project-status.js)을
 *   공유하되, MCP 는 sync better-sqlite3 라 DB 쓰기만 자체 구현한다(웹 logActivity 는 D1 어댑터 전용).
 *
 * 언제 쓰나: 자율 사이클/직접 명령/VSCode 세션 어디서든, 에이전트가 프로젝트가 완료됐다/보류됐다/
 *   다시 진행이다 라고 판단했을 때. 순수 이력은 activity_log 로 충분하고, 이 툴은 **라이프사이클 전이 전용**.
 *
 * 저위험(가역): 상태는 웹 상세의 드롭다운으로 사람이 즉시 되돌릴 수 있어 승인함을 거치지 않고 직접 전이한다.
 *   모든 전이는 activity_logs(action='project_status_change')에 감사로 남는다.
 *
 * @returns {{id, name, status, previous_status}} 갱신된 프로젝트 요약. 실패 시 {error, ...}.
 */
export function projectStatusSet(params) {
  const db = getDb();

  const status = normalizeProjectStatus(params.status);
  if (!status) {
    return { error: "INVALID_STATUS", allowed: PROJECT_STATUS_VALUES, got: params.status };
  }

  // project_id 존재 확인(명확한 에러). STATUS.md 헤더 project_id 또는 get_current_context 로 확인.
  const proj = db.prepare("SELECT id, name, status FROM projects WHERE id = ?").get(params.project_id);
  if (!proj) {
    return { error: "PROJECT_NOT_FOUND", project_id: params.project_id, hint: "STATUS.md 헤더의 project_id 또는 get_current_context 로 확인하세요." };
  }

  const previous = proj.status;
  if (previous === status) {
    // 무변경 no-op — 감사로그 오염 방지.
    return { id: proj.id, name: proj.name, status, previous_status: previous, noop: true };
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, now, proj.id);

  // 감사로그 — activity_logs 직접 INSERT(웹 logActivity 와 동일 action·detail 포맷 공유).
  //   MCP 는 D1 어댑터가 없어 raw INSERT(정규화 컬럼은 기본값). action 만 맞추면 웹/타임라인에서 함께 조회된다.
  try {
    db.prepare(
      `INSERT INTO activity_logs (id, project_id, command_id, agent_name, action, detail, created_at)
       VALUES (@id, @project_id, @command_id, @agent_name, @action, @detail, @created_at)`
    ).run({
      id: uuid(),
      project_id: proj.id,
      command_id: null,
      agent_name: params.agent_name ?? "mcp",
      action: PROJECT_STATUS_CHANGE_ACTION,
      detail: projectStatusChangeDetail(previous, status, params.reason),
      created_at: now,
    });
  } catch { /* 감사 실패는 전이 자체를 막지 않음 */ }

  return {
    id: proj.id,
    name: proj.name,
    status,
    status_label: PROJECT_STATUS_LABELS[status],
    previous_status: previous,
  };
}
