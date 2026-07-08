import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

/**
 * 결정사항 기록 (Context Router 원재료).
 * 원격 미러는 후순위 — 현재는 로컬 SQLite 기준으로만 저장한다.
 */
export function decisionAdd(params) {
  const db = getDb();
  const decision = {
    id: uuid(),
    project_id: params.project_id ?? null,
    title: params.title,
    summary: params.summary ?? null,
    reason: params.reason ?? null,
    impact: params.impact ?? null,
    importance: params.importance ?? 3,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO decisions (id, project_id, title, summary, reason, impact, importance, created_at)
     VALUES (@id, @project_id, @title, @summary, @reason, @impact, @importance, @created_at)`
  ).run(decision);
  return decision;
}
