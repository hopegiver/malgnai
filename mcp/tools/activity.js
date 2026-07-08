import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

export function activityLog(params) {
  const db = getDb();
  const log = {
    id: uuid(),
    project_id: params.project_id ?? null,
    command_id: params.command_id ?? null,
    agent_name: params.agent_name,
    action: params.action,
    detail: params.detail ?? null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO activity_logs (id, project_id, command_id, agent_name, action, detail, created_at)
     VALUES (@id, @project_id, @command_id, @agent_name, @action, @detail, @created_at)`
  ).run(log);
  return log;
}
