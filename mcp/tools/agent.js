import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

export function agentLearningLogAdd(params) {
  const db = getDb();
  const agent = db.prepare("SELECT name FROM agents WHERE name = ?").get(params.agent_name);
  if (!agent) throw new Error(`Agent not found: ${params.agent_name}`);

  const proj = db.prepare("SELECT id FROM projects WHERE id = ?").get(params.project_id);
  if (!proj) {
    return { error: "PROJECT_NOT_FOUND", project_id: params.project_id, hint: "STATUS.md 헤더의 project_id 또는 get_current_context 로 확인하세요." };
  }

  const log = {
    id: uuid(),
    agent_name: params.agent_name,
    project_id: params.project_id,
    type: params.type,
    title: params.title,
    content: params.content ?? null,
    source: params.source ?? null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO agent_learning_logs (id, agent_name, project_id, type, title, content, source, created_at)
     VALUES (@id, @agent_name, @project_id, @type, @title, @content, @source, @created_at)`
  ).run(log);
  return log;
}
