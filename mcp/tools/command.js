import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

/**
 * command_add — 사람 승인이 필요한 작업을 승인함(commands, status='queued')에 등록한다.
 *
 * (통합 실행모델 §8/§9) VSCode 세션(에이전트)은 HTTP `/api/commands` 를 스스로 부르지 않으므로,
 *   "이건 사람 승인이 필요하다"를 웹 승인함(`/approvals`)에 올릴 MCP 경로로 이 툴을 쓴다.
 *   순수 업무 이력은 여전히 `activity_log`(신규 툴 0 원칙) — 이 툴은 **승인 필요 건 전용**이다.
 *
 * (§9 원격 승인 재개) 세션을 이어받아야 하면 `session_id`(현재 세션의 id) + `task_type='resume'`로
 *   등록한다. 대표가 웹에서 승인(+답변=review_note)하면 워커가 `claude --resume <session_id> -p "<답변>"`
 *   으로 같은 세션을 headless 로 이어받는다. resume 가 아니면 session_id 를 비운다(신규 세션 실행).
 *
 * status 는 항상 'queued'(held) — §3-3 로 승인 전에는 절대 실행되지 않는다. 대표 approve 시에만
 *   'approved' 로 전이해 실행 경로에 오른다.
 *
 * (2026-07-14) `options`: 선택지가 있는 질문(A/B 중 택1 등)일 때만 채운다. `{label, description?}`
 *   배열(AskUserQuestion 옵션 shape와 동일)을 JSON 직렬화해 `options_json`에 저장 — 웹 승인함이
 *   버튼으로 렌더링할 수 있게 하기 위함. 자유형 질문은 생략(NULL).
 *
 * @returns {{id, project_id, status, task_type, session_id, options}} 생성된 command 요약.
 */
export function commandAdd(params) {
  const db = getDb();
  const now = new Date().toISOString();

  // project_id 존재 확인(FK: commands.project_id → projects.id NOT NULL). 없으면 명확한 에러.
  const proj = db.prepare("SELECT id FROM projects WHERE id = ?").get(params.project_id);
  if (!proj) {
    return { error: "PROJECT_NOT_FOUND", project_id: params.project_id, hint: "STATUS.md 헤더의 project_id 또는 get_current_context 로 확인하세요." };
  }

  const isResume = !!params.session_id;
  const row = {
    id: uuid(),
    project_id: params.project_id,
    instruction: params.instruction,
    status: "queued",
    permission_mode: "allowlist",
    created_by: params.agent_name ?? "mcp",
    // resume 대상 세션(이어받을 세션 id). resume 가 아니면 NULL.
    session_id: params.session_id ?? null,
    // resume 마커. 명시 task_type 우선, session_id 있으면 'resume', 아니면 NULL.
    task_type: params.task_type ?? (isResume ? "resume" : null),
    // 승인 필요 건은 기본 medium(대표가 먼저 보게). 명시값 우선.
    risk_level: params.risk_level ?? "medium",
    title: params.title ?? null,
    // 선택형 질문의 옵션 배열. 미지정이면 NULL(자유텍스트 질문).
    options_json: Array.isArray(params.options) ? JSON.stringify(params.options) : null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO commands (id, project_id, instruction, status, permission_mode, created_by,
                           session_id, task_type, risk_level, title, options_json, created_at, updated_at)
     VALUES (@id, @project_id, @instruction, @status, @permission_mode, @created_by,
             @session_id, @task_type, @risk_level, @title, @options_json, @created_at, @updated_at)`
  ).run(row);

  return { id: row.id, project_id: row.project_id, status: row.status, task_type: row.task_type, session_id: row.session_id, options: params.options ?? null };
}
