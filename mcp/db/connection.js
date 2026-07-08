import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initializeSchema } from "./schema.js";

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = process.env.MALGNAI_DB_PATH || "./data/malgnai.db";
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
