import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

export function agentLearningLogAdd(params) {
  const db = getDb();
  const agent = db.prepare("SELECT name FROM agents WHERE name = ?").get(params.agent_name);
  if (!agent) throw new Error(`Agent not found: ${params.agent_name}`);

  const log = {
    id: uuid(),
    agent_name: params.agent_name,
    type: params.type,
    title: params.title,
    content: params.content ?? null,
    source: params.source ?? null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO agent_learning_logs (id, agent_name, type, title, content, source, created_at)
     VALUES (@id, @agent_name, @type, @title, @content, @source, @created_at)`
  ).run(log);
  return log;
}
