// projects 테이블 DAO — user_id 직접 소유, project_members 없음(architecture.md §0-9).
// 2026-08-11 repositories 테이블 폐기(architecture.md §0 결정22) — repository_key/repository_name을
// 이 테이블이 직접 보유한다. repository_key는 GitHub 연동 전까지는 사용자가 붙이는 단순 정보값이라
// 전역 유니크가 아니라 (user_id, repository_key)로만 유니크하다(migrations/0010).
import { newId } from '../lib/ulid.js'

/** (userId, repositoryKey)로 get-or-create — 없으면 그 사용자의 신규 project 1개를 생성(§4.1/§4.2).
 *  name은 최초 생성 시에만 사용(없으면 repositoryName 또는 repositoryKey), 이미 존재하면 무시
 *  (project_bootstrap §4.11과 동일 원칙). */
export async function getOrCreateForUser(db, userId, repositoryKey, repositoryName, name) {
  const existing = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_key = ?')
    .bind(userId, repositoryKey).first()
  if (existing) return existing

  const id = newId()
  const now = new Date().toISOString()
  const finalRepositoryName = repositoryName || repositoryKey
  const finalName = name || finalRepositoryName
  try {
    await db.prepare(
      `INSERT INTO projects (id, user_id, repository_key, repository_name, project_key, name, status, classification, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'active', 'internal', ?, ?)`
    ).bind(id, userId, repositoryKey, finalRepositoryName, finalName, now, now).run()
    return {
      id, user_id: userId, repository_key: repositoryKey, repository_name: finalRepositoryName, project_key: null, name: finalName,
      status: 'active', classification: 'internal', created_at: now, updated_at: now
    }
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_key = ?').bind(userId, repositoryKey).first()
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

/** 같은 repository_key에 대한 여러 사용자의 작업을 조인해 열람(administrator 전용, api.md §5.3). */
export async function listByRepositoryKey(db, repositoryKey) {
  const { results } = await db.prepare(
    `SELECT p.id as project_id, p.user_id, u.name as user_name, u.email as user_email, p.status
     FROM projects p JOIN users u ON u.id = p.user_id
     WHERE p.repository_key = ? ORDER BY p.created_at DESC`
  ).bind(repositoryKey).all()
  return results
}
