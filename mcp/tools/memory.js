import { v4 as uuid } from "uuid";
import { getDb } from "../db/connection.js";

/** 검색 가능한 메모리/요약 기록 (Context Router 원재료). */
export function memoryAdd(params) {
  const db = getDb();
  const memory = {
    id: uuid(),
    project_id: params.project_id ?? null,
    command_id: params.command_id ?? null,
    memory_type: params.memory_type ?? "note",
    title: params.title,
    content: params.content,
    tags: params.tags ?? null,
    importance: params.importance ?? 3,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO memories (id, project_id, command_id, memory_type, title, content, tags, importance, created_at)
     VALUES (@id, @project_id, @command_id, @memory_type, @title, @content, @tags, @importance, @created_at)`
  ).run(memory);
  return memory;
}

/**
 * 메모리 검색.
 * 1차 버전은 텍스트 LIKE 검색(title/content/tags). 벡터 검색은 후순위(보류).
 * query가 없으면 최신/중요도 순 목록으로 동작한다.
 */
export function memorySearch(params) {
  const db = getDb();
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const conditions = [];
  const values = [];

  if (params.query) {
    conditions.push("(title LIKE ? OR content LIKE ? OR tags LIKE ?)");
    const like = `%${params.query}%`;
    values.push(like, like, like);
  }
  if (params.project_id) {
    conditions.push("project_id = ?");
    values.push(params.project_id);
  }
  if (params.memory_type) {
    conditions.push("memory_type = ?");
    values.push(params.memory_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit, offset);

  return db
    .prepare(`SELECT * FROM memories ${where} ORDER BY importance DESC, created_at DESC LIMIT ? OFFSET ?`)
    .all(...values);
}
