import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

/** 이슈/장애물 기록 (Context Router 원재료). */
export function issueAdd(params) {
  const db = getDb();
  const issue = {
    id: uuid(),
    project_id: params.project_id ?? null,
    title: params.title,
    description: params.description ?? null,
    status: "open",
    severity: params.severity ?? "medium",
    related_file: params.related_file ?? null,
    created_at: new Date().toISOString(),
    resolved_at: null,
  };
  db.prepare(
    `INSERT INTO issues (id, project_id, title, description, status, severity, related_file, created_at, resolved_at)
     VALUES (@id, @project_id, @title, @description, @status, @severity, @related_file, @created_at, @resolved_at)`
  ).run(issue);
  return issue;
}

/** 이슈를 해결 처리한다. 없는 id거나 project_id 가 불일치하면 에러. */
export function issueResolve(params) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM issues WHERE id = ?").get(params.id);
  if (!existing) return { error: "ISSUE_NOT_FOUND", id: params.id };
  if (existing.project_id && existing.project_id !== params.project_id) {
    return { error: "PROJECT_MISMATCH", id: params.id, expected: existing.project_id, got: params.project_id };
  }

  const resolved_at = new Date().toISOString();
  db.prepare("UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ?").run(resolved_at, params.id);
  return { ...existing, status: "resolved", resolved_at };
}
