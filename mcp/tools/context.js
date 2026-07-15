import { getDb } from "../db/connection.js";

/**
 * Context Router의 핵심 도구.
 *
 * "AI가 기억을 많이 갖게 하는 게 아니라, 지금 필요한 기억만 정확히 꺼내 쓰게 만든다."
 * 전체 문서/로그를 통째로 읽는 대신, 현재 작업에 필요한 맥락만 조합해 짧게 반환한다.
 *
 * 반환 구성:
 *   - active_projects   : 진행 중(active) 프로젝트 요약
 *   - in_progress_tasks : 진행 중 작업
 *   - open_issues       : 열린 이슈(심각도 순)
 *   - recent_decisions  : 최근/중요 결정사항
 *   - key_memories      : 중요 메모리(lesson 등)
 *   - recent_activities : 최근 활동 로그(짧게)
 *   - pending_commands  : 대기중(queued)/승인후 미착수(approved) commands(짧게)
 *
 * (참고: "지금 실행 중인 이 명령"의 승인 여부는 instruction에 자동 추가되는 [✅ 승인됨]
 *  메모로 워커가 직접 인지 가능하다 — 그건 이 필드로 다시 보여주지 않는다. pending_commands는
 *  그와 별개로 "내가 전에 command_add로 올려둔 다른 제안/질문이 아직 어떤 상태인지"를
 *  워커가 스스로 확인할 수 있게 하는 용도다(issue f09eb6ea).
 *
 * project_id를 주면 해당 프로젝트로 범위를 좁힌다.
 */
export function getCurrentContext(params = {}) {
  const db = getDb();
  const pid = params.project_id ?? null;
  const projFilter = pid ? "AND project_id = @pid" : "";
  const bind = { pid };

  const active_projects = db
    .prepare(
      `SELECT id, name, status, updated_at FROM projects
       WHERE status = 'active' ${pid ? "AND id = @pid" : ""}
       ORDER BY updated_at DESC LIMIT 10`
    )
    .all(bind);

  // 실행 인프라 재설계(v3): tasks/commands 완전 통합 — tasks 테이블 제거로 commands 기반 조회로 교체.
  //   in_progress ~= claimed/running(8상태). agent_name/title 은 commands 컬럼명에 맞춰 별칭.
  const in_progress_tasks = db
    .prepare(
      `SELECT id, project_id,
              COALESCE(title, substr(instruction, 1, 120)) AS title,
              assignee_agent_name AS agent_name, status
         FROM commands
        WHERE status IN ('claimed','running') ${projFilter}
        ORDER BY updated_at DESC LIMIT 15`
    )
    .all(bind);


  const open_issues = db
    .prepare(
      `SELECT id, title, severity, related_file, project_id FROM issues
       WHERE status = 'open' ${projFilter}
       ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                created_at DESC
       LIMIT 15`
    )
    .all(bind);

  const recent_decisions = db
    .prepare(
      `SELECT id, title, summary, importance, project_id FROM decisions
       WHERE 1=1 ${projFilter}
       ORDER BY importance DESC, created_at DESC LIMIT 10`
    )
    .all(bind);

  const key_memories = db
    .prepare(
      `SELECT id, title, memory_type, importance FROM memories
       WHERE 1=1 ${projFilter}
       ORDER BY importance DESC, created_at DESC LIMIT 10`
    )
    .all(bind);

  const recent_activities = db
    .prepare(
      `SELECT agent_name, action, detail, created_at FROM activity_logs
       WHERE 1=1 ${projFilter}
       ORDER BY created_at DESC LIMIT 10`
    )
    .all(bind);

  // issue f09eb6ea: 워커가 이전에 올려둔 제안/질문(command_add)이 아직 승인 대기중인지,
  // 승인은 됐지만 아직 실행되지 않았는지를 스스로 확인할 방법이 없었다. queued/approved 만
  // 짧게 보여준다(claimed/running 이후는 위 in_progress_tasks 가 이미 커버).
  const pending_commands = db
    .prepare(
      `SELECT id, project_id,
              COALESCE(title, substr(instruction, 1, 120)) AS title,
              status, review_status, created_at
         FROM commands
        WHERE status IN ('queued','approved') ${projFilter}
        ORDER BY created_at DESC LIMIT 10`
    )
    .all(bind);

  return {
    generated_at: new Date().toISOString(),
    scope: { project_id: pid },
    active_projects,
    in_progress_tasks,
    open_issues,
    recent_decisions,
    key_memories,
    recent_activities,
    pending_commands,
  };
}
