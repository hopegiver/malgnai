// projects 테이블 DAO — user_id 직접 소유, project_members 없음(architecture.md §0-9).
import { newId } from '../lib/ulid.js'

/** (userId, repository.id)로 get-or-create — 없으면 그 사용자의 신규 project 1개를 생성(§4.1/§4.2).
 *  name은 최초 생성 시에만 사용(없으면 repository.name), 이미 존재하면 무시(bootstrap_project §4.11과 동일 원칙). */
export async function getOrCreateForUser(db, userId, repository, name) {
  const existing = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_id = ?')
    .bind(userId, repository.id).first()
  if (existing) return existing

  const id = newId()
  const now = new Date().toISOString()
  const finalName = name || repository.name
  try {
    await db.prepare(
      `INSERT INTO projects (id, user_id, repository_id, project_key, name, status, classification, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?)`
    ).bind(id, userId, repository.id, finalName, repository.classification, now, now).run()
    return {
      id, user_id: userId, repository_id: repository.id, project_key: null, name: finalName,
      status: 'active', classification: repository.classification, created_at: now, updated_at: now
    }
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_id = ?').bind(userId, repository.id).first()
      if (row) return row
    }
    throw e
  }
}

/** 본인 소유만 — 타인 소유 project_id는 존재해도 null(404 위장, IDOR 방지, api.md §5.3). */
export async function findOwnedById(db, userId, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(projectId, userId).first()
}

export async function findByIdAny(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first()
}

export async function listForUser(db, userId) {
  const { results } = await db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return results
}

/** 같은 레포에 대한 여러 사용자의 작업을 조인해 열람(administrator 전용, api.md §5.3). */
export async function listByRepository(db, repositoryId) {
  const { results } = await db.prepare(
    `SELECT p.id as project_id, p.user_id, u.name as user_name, u.email as user_email, p.status
     FROM projects p JOIN users u ON u.id = p.user_id
     WHERE p.repository_id = ? ORDER BY p.created_at DESC`
  ).bind(repositoryId).all()
  return results
}
