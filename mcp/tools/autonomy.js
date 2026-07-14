import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";
import { CADENCE_VALUES } from "../../server/lib/cadence.js";
import { RISK_APPROVAL_THRESHOLD_VALUES, KPI_COMPLETE_ACTION_VALUES } from "../../server/lib/autonomy.js";

/**
 * project_autonomy_get / project_autonomy_update — 프로젝트별 자율 설정(목표/KPI/관찰 LEAD/
 *   박동주기/자율 on-off/위험승인임계값) 조회·변경.
 *
 * 웹 `GET/PUT /api/projects/:id/autonomy`(server/api/projects.js)와 **동일 계약**을 공유한다
 *   (cadence 허용값 = lib/cadence.js#CADENCE_VALUES, risk_approval_threshold 허용값 =
 *   lib/autonomy.js#RISK_APPROVAL_THRESHOLD_VALUES, LEAD 필수 fail-safe 규칙까지 동일).
 *   MCP 는 AI 콘솔 대화 중 자율 설정을 직접 조회/변경할 수 있게 하는 경로다(project-status.js와
 *   같은 패턴 — 웹은 D1 어댑터, MCP는 sync better-sqlite3 라 각자 자체 구현하되 규칙만 공유).
 */

// 프로젝트별 자율 "effective ON" 판정 — server/api/projects.js isProjectAutonomyOn 과 동일 기준.
function isProjectAutonomyOn(p) {
  if (!p) return false;
  const flag = p.autonomy_enabled;
  const on = flag === "1" || flag === "true" || flag === "on" || flag === 1 || flag === true;
  if (!on) return false;
  if (p.cadence && String(p.cadence).toLowerCase() === "off") return false;
  if (!p.lead_agent_name) return false;
  return true;
}

function autonomyView(p) {
  return {
    project_id: p.id,
    name: p.name,
    kind: p.kind,
    goal: p.goal ?? null,
    kpi_json: p.kpi_json ?? null,
    custom_instruction: p.custom_instruction ?? null,
    lead_agent_name: p.lead_agent_name ?? null,
    cadence: p.cadence ?? null,
    autonomy_level: p.autonomy_level ?? null,
    // 프로젝트별 자율 on/off — cadence='off' 도 OFF 로 반영(effective).
    autonomy_enabled: isProjectAutonomyOn(p),
    autonomy_enabled_raw: p.autonomy_enabled ?? null,
    risk_approval_threshold: p.risk_approval_threshold ?? null,
    kpi_complete_action: p.kpi_complete_action ?? "continue",
  };
}

/**
 * @returns {{autonomy: object}} 현재 자율 설정. 프로젝트 없으면 {error: 'PROJECT_NOT_FOUND', ...}.
 */
export function projectAutonomyGet(params) {
  const db = getDb();
  const proj = db.prepare("SELECT * FROM projects WHERE id = ?").get(params.project_id);
  if (!proj) {
    return { error: "PROJECT_NOT_FOUND", project_id: params.project_id, hint: "STATUS.md 헤더의 project_id 또는 get_current_context 로 확인하세요." };
  }
  return { autonomy: autonomyView(proj) };
}

/**
 * @returns {{autonomy: object}} 갱신된 자율 설정. 실패 시 {error, ...}.
 */
export function projectAutonomyUpdate(params) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(params.project_id);
  if (!existing) {
    return { error: "PROJECT_NOT_FOUND", project_id: params.project_id, hint: "STATUS.md 헤더의 project_id 또는 get_current_context 로 확인하세요." };
  }

  const fields = {};

  if (params.goal !== undefined) fields.goal = params.goal;
  if (params.kpi_json !== undefined) fields.kpi_json = params.kpi_json;
  if (params.custom_instruction !== undefined) fields.custom_instruction = params.custom_instruction;

  // lead_agent_name — 반드시 실재 agent(agents.name). null/'' 은 LEAD 해제(→ 자율 자동 OFF 취급).
  if (params.lead_agent_name !== undefined) {
    if (params.lead_agent_name === null || params.lead_agent_name === "") {
      fields.lead_agent_name = null;
    } else {
      const agent = db.prepare("SELECT name FROM agents WHERE name = ?").get(params.lead_agent_name);
      if (!agent) {
        return { error: "INVALID_LEAD_AGENT", got: params.lead_agent_name, hint: `agents.name 에 등록된 에이전트여야 합니다.` };
      }
      fields.lead_agent_name = params.lead_agent_name;
    }
  }

  // cadence — enum(every15m/every30m/hourly/every3h/every6h/every12h/daily/weekly/off). 'off' = 정지.
  if (params.cadence !== undefined) {
    if (params.cadence === null) {
      fields.cadence = null;
    } else if (!CADENCE_VALUES.includes(params.cadence)) {
      return { error: "INVALID_CADENCE", allowed: CADENCE_VALUES, got: params.cadence };
    } else {
      fields.cadence = params.cadence;
    }
  }

  // autonomy_level(선택, 자유 라벨 — 게이트엔 미영향, 표시/메타용).
  if (params.autonomy_level !== undefined) {
    fields.autonomy_level = params.autonomy_level;
  }

  // risk_approval_threshold — 'off'(risk-blind)|'low'|'medium'|'high'|'critical'. null = 컬럼 초기화(=off 와 동일 효과).
  if (params.risk_approval_threshold !== undefined) {
    if (params.risk_approval_threshold === null) {
      fields.risk_approval_threshold = null;
    } else if (!RISK_APPROVAL_THRESHOLD_VALUES.includes(params.risk_approval_threshold)) {
      return { error: "INVALID_RISK_APPROVAL_THRESHOLD", allowed: RISK_APPROVAL_THRESHOLD_VALUES, got: params.risk_approval_threshold };
    } else {
      fields.risk_approval_threshold = params.risk_approval_threshold;
    }
  }

  // kpi_complete_action — 'continue'(기본, 모든 KPI 달성해도 자율운영 유지)|'off'(기존 동작, 자동 종료).
  if (params.kpi_complete_action !== undefined) {
    if (params.kpi_complete_action === null) {
      fields.kpi_complete_action = null;
    } else if (!KPI_COMPLETE_ACTION_VALUES.includes(params.kpi_complete_action)) {
      return { error: "INVALID_KPI_COMPLETE_ACTION", allowed: KPI_COMPLETE_ACTION_VALUES, got: params.kpi_complete_action };
    } else {
      fields.kpi_complete_action = params.kpi_complete_action;
    }
  }

  // 자율 on/off — boolean 을 '1'/'0' 으로 저장.
  if (params.autonomy_enabled !== undefined) {
    fields.autonomy_enabled = params.autonomy_enabled ? "1" : "0";
  }

  // ⚠️ fail-safe 안전 검사: autonomy_enabled 를 켜려는데 LEAD 가 없으면(기존/신규 모두) 거부.
  const willBeOn = fields.autonomy_enabled === "1"
    || (fields.autonomy_enabled === undefined && (existing.autonomy_enabled === "1" || existing.autonomy_enabled === 1));
  const effLead = fields.lead_agent_name !== undefined ? fields.lead_agent_name : existing.lead_agent_name;
  if (willBeOn && !effLead) {
    return { error: "LEAD_AGENT_REQUIRED", hint: "autonomy_enabled 를 켜려면 lead_agent_name 을 먼저 지정하세요." };
  }

  if (Object.keys(fields).length === 0) {
    return { error: "NO_FIELDS", hint: "goal/kpi_json/custom_instruction/lead_agent_name/cadence/autonomy_level/autonomy_enabled/risk_approval_threshold/kpi_complete_action 중 하나 이상 넘겨야 합니다." };
  }

  const setCols = Object.keys(fields).map((c) => `${c}=?`);
  const setVals = Object.keys(fields).map((c) => fields[c]);
  db.prepare(`UPDATE projects SET ${setCols.join(", ")} WHERE id=?`).run(...setVals, existing.id);

  const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(existing.id);

  // 감사로그 — 웹 PUT /:id/autonomy 와 동일 action('project_autonomy_update')으로 남겨 타임라인에서 함께 조회.
  try {
    db.prepare(
      `INSERT INTO activity_logs (id, project_id, command_id, agent_name, action, detail, created_at)
       VALUES (@id, @project_id, @command_id, @agent_name, @action, @detail, @created_at)`
    ).run({
      id: uuid(),
      project_id: updated.id,
      command_id: null,
      agent_name: params.agent_name ?? "mcp",
      action: "project_autonomy_update",
      detail: JSON.stringify(fields),
      created_at: new Date().toISOString(),
    });
  } catch { /* 감사 실패는 본 동작을 막지 않음 */ }

  return { autonomy: autonomyView(updated) };
}
