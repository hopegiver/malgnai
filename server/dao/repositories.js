// repositories 테이블 DAO — "같은 코드베이스"의 유일한 정본(architecture.md §3.2). get-or-create.
import { newId } from '../lib/ulid.js'

export async function getOrCreate(db, repositoryKey, name) {
  const existing = await db.prepare('SELECT * FROM repositories WHERE repository_key = ?').bind(repositoryKey).first()
  if (existing) return existing

  const id = newId()
  const now = new Date().toISOString()
  const finalName = name || repositoryKey
  try {
    await db.prepare(
      'INSERT INTO repositories (id, repository_key, name, classification, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, repositoryKey, finalName, 'internal', now).run()
    return { id, repository_key: repositoryKey, name: finalName, classification: 'internal', created_at: now }
  } catch (e) {
    // 동시 요청 레이스로 다른 요청이 먼저 만들었으면 그 행을 그대로 재조회(UNIQUE 위반 시 안전 폴백).
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM repositories WHERE repository_key = ?').bind(repositoryKey).first()
      if (row) return row
    }
    throw e
  }
}

export async function findById(db, id) {
  return db.prepare('SELECT * FROM repositories WHERE id = ?').bind(id).first()
}
