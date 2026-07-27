// project_states 공통 구현 — 낙관적 동시성(UPDATE ... WHERE project_id=? AND version=?),
// changes===0이면 VERSION_CONFLICT + 최신 상태 동봉(architecture.md §4.5, mcp-tools.md §4.5).
const HEALTHS = ['normal', 'warning', 'critical']
const PATCH_FIELDS = {
  progress: 'progress',
  currentWork: 'current_work',
  nextAction: 'next_action',
  health: 'health',
  phase: 'phase',
  blockerSummary: 'blocker_summary',
  activeBranch: 'active_branch',
  latestCommit: 'latest_commit',
  currentGoal: 'current_goal'
}

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}
function conflictError(current) {
  const e = new Error('VERSION_CONFLICT')
  e.name = 'ConflictError'
  e.current = current
  return e
}

export async function getState(db, projectId) {
  return db.prepare('SELECT * FROM project_states WHERE project_id = ?').bind(projectId).first()
}

export async function updateState(db, { projectId, userId, expectedVersion, patch = {} }) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError('expectedVersion must be a positive integer')
  if (patch.progress != null && (patch.progress < 0 || patch.progress > 100)) throw validationError('progress must be 0..100')
  if (patch.health != null && !HEALTHS.includes(patch.health)) throw validationError(`health must be one of ${HEALTHS.join(',')}`)

  const current = await getState(db, projectId)
  const now = new Date().toISOString()

  if (!current) {
    // 최초 상태 생성 — 버전 1이어야 함(그 외 값이면 클라이언트가 이미 존재한다고 잘못 알고 있는 것).
    if (expectedVersion !== 1) throw conflictError(null)
    await db.prepare(
      `INSERT INTO project_states
         (project_id, version, phase, health, progress, current_goal, current_work, next_action, blocker_summary, active_branch, latest_commit, state_json, updated_by, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(
      projectId, patch.phase ?? null, patch.health ?? null, patch.progress ?? null,
      patch.currentGoal ?? null, patch.currentWork ?? null, patch.nextAction ?? null,
      patch.blockerSummary ?? null, patch.activeBranch ?? null, patch.latestCommit ?? null,
      userId, now
    ).run()
    return getState(db, projectId)
  }

  const sets = ['version = version + 1', 'updated_by = ?', 'updated_at = ?']
  const binds = [userId, now]
  for (const [key, column] of Object.entries(PATCH_FIELDS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`)
      binds.push(patch[key])
    }
  }
  binds.push(projectId, expectedVersion)
  const res = await db.prepare(`UPDATE project_states SET ${sets.join(', ')} WHERE project_id = ? AND version = ?`).bind(...binds).run()

  if (res.meta.changes === 0) {
    throw conflictError(await getState(db, projectId))
  }
  return getState(db, projectId)
}
