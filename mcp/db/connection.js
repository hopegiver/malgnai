import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSchema } from "./schema.js";

// 이 파일 위치(mcp/db/) 기준 프로젝트 루트를 고정 계산한다. server/node.js·engine/db.js·
// bin/*.js 는 전부 ROOT-앵커 기본값을 쓰는데 여기만 "./data/malgnai.db"(=process.cwd() 상대경로)
// 였다 — MCP 는 ~/.claude.json 이 정하는 cwd 에서 스폰되므로, env(MALGNAI_DB_PATH)가 어떤 이유로든
// 안 실리면 실행 위치에 따라 엉뚱한 곳에 빈 "유령" data/malgnai.db 가 새로 생길 수 있었다(issue
// 1cef0e3e). 다른 진입점들과 동일하게 ROOT 절대경로로 앵커링해 재발을 막는다.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = process.env.MALGNAI_DB_PATH || join(ROOT, "data", "malgnai.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  initializeSchema(db);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
