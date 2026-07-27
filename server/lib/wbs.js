// wbs_items 공통 구현 — wbs_list/wbs_add/wbs_bulk_add/wbs_update(mcp-tools.md §4.7~4.10,
// architecture.md §0 결정20). 그룹(자식 있는) 노드의 progress/status는 항상 자식 롤업 계산값 —
// 옛 malgnai 리뷰어가 잡은 Major 버그(그룹에 progress 직접 저장) 재발 방지 규칙을 그대로 이식.
import { newId } from './ulid.js'
import { parseIdempotencyKey } from './idempotency.js'

function validationError(message, code) {
  const e = new Error(message)
  e.name = 'ValidationError'
  if (code) e.code = code
  return e
}
function notFoundError(message) {
  const e = new Error(message)
  e.name = 'NotFoundError'
  return e
}
function forbiddenError(message, code) {
  const e = new Error(message)
  e.name = 'ForbiddenError'
  if (code) e.code = code
  return e
}

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

// ---------------------------------------------------------------------------
// 트리 조립 + 롤업(§3.14, §4.7)
// ---------------------------------------------------------------------------
export function buildWbsTree(rows) {
  const byId = new Map()
  for (const r of rows) byId.set(r.id, { ...r, children: [] })
  const roots = []
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node)
    else roots.push(node)
  }
  const bySeq = (a, b) => a.seq - b.seq || (a.created_at < b.created_at ? -1 : 1)
  for (const node of byId.values()) node.children.sort(bySeq)
  roots.sort(bySeq)

  function rollup(node) {
    if (node.children.length === 0) {
      node.computedProgress = node.progress
      node.computedStatus = node.status
      return
    }
    for (const c of node.children) rollup(c)
    const total = node.children.reduce((s, c) => s + c.computedProgress, 0)
    node.computedProgress = Math.round(total / node.children.length)
    const allDone = node.children.every((c) => c.computedStatus === 'done')
    const anyStarted = node.children.some((c) => c.computedStatus !== 'planned')
    node.computedStatus = allDone ? 'done' : anyStarted ? 'in_progress' : 'planned'
  }
  for (const r of roots) rollup(r)
  return roots
}

export function flattenDepthFirst(roots) {
  const out = []
  function visit(node) {
    out.push(node)
    for (const c of node.children) visit(c)
  }
  for (const r of roots) visit(r)
  return out
}

function computeBucket(computedStatus, endDate) {
  if (computedStatus !== 'done' && endDate && endDate < todayDate()) return 'delayed'
  return computedStatus
}

// ---------------------------------------------------------------------------
// wbs_list (§4.7)
// ---------------------------------------------------------------------------
export async function wbsList(db, projectId, { parentId, status, includeDone } = {}) {
  const { results } = await db.prepare(
    'SELECT * FROM wbs_items WHERE project_id = ? ORDER BY parent_id, seq, created_at'
  ).bind(projectId).all()
  const tree = buildWbsTree(results)

  let scopedRoots = tree
  if (parentId) {
    const flatAll = flattenDepthFirst(tree)
    const parentNode = flatAll.find((n) => n.id === parentId)
    scopedRoots = parentNode ? parentNode.children : []
  }
  const flat = flattenDepthFirst(scopedRoots)

  const withBucket = flat.map((n) => ({
    id: n.id,
    parentId: n.parent_id,
    depth: n.depth,
    seq: n.seq,
    title: n.title,
    status: n.status,
    computedProgress: n.computedProgress,
    bucket: computeBucket(n.computedStatus, n.end_date),
    responsibleTeam: n.responsible_team,
    assigneeAgentName: n.assignee_agent_name,
    startDate: n.start_date,
    endDate: n.end_date,
    completedDate: n.completed_date
  }))

  let items = withBucket
  if (status) items = withBucket.filter((i) => i.bucket === status)
  else if (!includeDone) items = withBucket.filter((i) => i.bucket !== 'done')

  const summary = { total: withBucket.length, planned: 0, inProgress: 0, done: 0, delayed: 0 }
  for (const i of withBucket) {
    if (i.bucket === 'planned') summary.planned++
    else if (i.bucket === 'in_progress') summary.inProgress++
    else if (i.bucket === 'done') summary.done++
    else if (i.bucket === 'delayed') summary.delayed++
  }
  return { summary, items }
}

// ---------------------------------------------------------------------------
// wbs_add (§4.8)
// ---------------------------------------------------------------------------
export async function wbsAdd(db, { userId, projectId, parentId, title, description, responsibleTeam, assigneeAgentName, startDate, endDate, idempotencyKey }) {
  if (!idempotencyKey) throw validationError('idempotencyKey is required')
  if (!title || title.length < 1 || title.length > 200) throw validationError('title must be 1..200 chars')
  if (startDate && !isValidDate(startDate)) throw validationError('startDate must be YYYY-MM-DD')
  if (endDate && !isValidDate(endDate)) throw validationError('endDate must be YYYY-MM-DD')
  if (startDate && endDate && startDate > endDate) throw validationError('startDate must be <= endDate')

  const existing = await db.prepare('SELECT * FROM wbs_items WHERE idempotency_key = ?').bind(idempotencyKey).first()
  if (existing) return { id: existing.id, parentId: existing.parent_id, seq: existing.seq, createdAt: existing.created_at }

  let depth = 0
  if (parentId) {
    const parent = await db.prepare('SELECT * FROM wbs_items WHERE id = ? AND project_id = ?').bind(parentId, projectId).first()
    if (!parent) throw validationError('parent not found in this project', 'PARENT_PROJECT_MISMATCH')
    depth = parent.depth + 1
  }
  const maxSeqRow = await db.prepare(
    'SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM wbs_items WHERE project_id = ? AND parent_id IS ?'
  ).bind(projectId, parentId || null).first()
  const seq = (maxSeqRow?.maxSeq ?? -1) + 1

  const { sessionId } = parseIdempotencyKey(idempotencyKey)
  const id = newId()
  const now = new Date().toISOString()
  try {
    await db.prepare(
      `INSERT INTO wbs_items
         (id, project_id, user_id, parent_id, depth, seq, title, description, status, responsible_team, assignee_agent_name, start_date, end_date, progress, session_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).bind(
      id, projectId, userId, parentId || null, depth, seq, title, description || null,
      responsibleTeam || null, assigneeAgentName || null, startDate || null, endDate || null,
      sessionId, idempotencyKey, now, now
    ).run()
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const row = await db.prepare('SELECT * FROM wbs_items WHERE idempotency_key = ?').bind(idempotencyKey).first()
      if (row) return { id: row.id, parentId: row.parent_id, seq: row.seq, createdAt: row.created_at }
    }
    throw e
  }
  return { id, parentId: parentId || null, seq, createdAt: now }
}

// ---------------------------------------------------------------------------
// wbs_bulk_add (§4.9) — 트랜잭션 1개(db.batch)로 원자 생성, idempotencyKey 없음(옛 malgnai와 동일)
// ---------------------------------------------------------------------------
export async function wbsBulkAdd(db, { userId, projectId, items }) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw validationError('items must contain 1..100 entries')

  const seenTempIds = new Set()
  for (const it of items) {
    if (!it.tempId || seenTempIds.has(it.tempId)) throw validationError('each item needs a unique tempId')
    seenTempIds.add(it.tempId)
    if (!it.title || it.title.length < 1 || it.title.length > 200) throw validationError(`invalid title for tempId ${it.tempId}`)
  }

  // 배치 밖(이미 DB에 있는) parentId들의 depth를 미리 조회.
  const existingParentIds = [...new Set(items.filter((i) => i.parentId).map((i) => i.parentId))]
  const parentDepths = new Map()
  for (const pid of existingParentIds) {
    const row = await db.prepare('SELECT id, depth FROM wbs_items WHERE id = ? AND project_id = ?').bind(pid, projectId).first()
    if (!row) throw validationError(`parentId ${pid} not found in this project`, 'PARENT_PROJECT_MISMATCH')
    parentDepths.set(pid, row.depth)
  }

  const seqCounters = new Map()
  async function nextSeq(parentKey, parentIdOrNull) {
    if (!seqCounters.has(parentKey)) {
      const row = await db.prepare(
        'SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM wbs_items WHERE project_id = ? AND parent_id IS ?'
      ).bind(projectId, parentIdOrNull).first()
      seqCounters.set(parentKey, (row?.maxSeq ?? -1) + 1)
    }
    const seq = seqCounters.get(parentKey)
    seqCounters.set(parentKey, seq + 1)
    return seq
  }

  const now = new Date().toISOString()
  const resolved = new Map() // tempId -> { id, depth }
  const stmts = []
  const created = []

  for (const it of items) {
    let parentDbId = null
    let depth = 0
    if (it.parentTempId) {
      const p = resolved.get(it.parentTempId)
      if (!p) throw validationError(`parentTempId ${it.parentTempId} must appear earlier in the batch`)
      parentDbId = p.id
      depth = p.depth + 1
    } else if (it.parentId) {
      parentDbId = it.parentId
      depth = parentDepths.get(it.parentId) + 1
    }
    const parentKey = parentDbId || 'root'
    // 순차 await로 형제 seq 카운터를 안전하게 증가시킨다(배치 내 형제 순서 보장).
    const seq = await nextSeq(parentKey, parentDbId)
    const id = newId()
    resolved.set(it.tempId, { id, depth })

    stmts.push(
      db.prepare(
        `INSERT INTO wbs_items
           (id, project_id, user_id, parent_id, depth, seq, title, description, status, responsible_team, assignee_agent_name, start_date, end_date, progress, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        id, projectId, userId, parentDbId, depth, seq, it.title, it.description || null,
        it.responsibleTeam || null, it.assigneeAgentName || null, it.startDate || null, it.endDate || null,
        now, now
      )
    )
    created.push({ tempId: it.tempId, id, title: it.title, parentId: parentDbId })
  }

  await db.batch(stmts)
  return { created, count: created.length }
}

// ---------------------------------------------------------------------------
// wbs_update (§4.10)
// ---------------------------------------------------------------------------
export async function wbsUpdate(db, { projectId, id, title, description, status, progress, responsibleTeam, assigneeAgentName, startDate, endDate, completedDate }) {
  const row = await db.prepare('SELECT * FROM wbs_items WHERE id = ?').bind(id).first()
  if (!row) throw notFoundError('wbs item not found')
  if (row.project_id !== projectId) throw forbiddenError('item belongs to a different project', 'PROJECT_MISMATCH')

  if (status && !['planned', 'in_progress', 'done'].includes(status)) throw validationError('invalid status')
  if (progress != null && (progress < 0 || progress > 100)) throw validationError('progress must be 0..100')
  if (startDate && !isValidDate(startDate)) throw validationError('startDate must be YYYY-MM-DD')
  if (endDate && !isValidDate(endDate)) throw validationError('endDate must be YYYY-MM-DD')

  const childCountRow = await db.prepare('SELECT COUNT(*) AS cnt FROM wbs_items WHERE parent_id = ?').bind(id).first()
  const hasChildren = (childCountRow?.cnt || 0) > 0
  if (hasChildren) {
    if (progress !== undefined) throw validationError('progress is computed from children for group nodes', 'PROGRESS_LEAF_ONLY')
    if (status === 'done') throw validationError('status=done is computed from children for group nodes', 'STATUS_DONE_LEAF_ONLY')
  }

  const now = new Date().toISOString()
  let finalProgress = progress !== undefined ? progress : row.progress
  let finalStatus = status !== undefined ? status : row.status
  let finalCompletedDate = completedDate !== undefined ? completedDate : row.completed_date

  if (status === 'done' && progress === undefined) finalProgress = 100
  if (status === 'done' && completedDate === undefined) finalCompletedDate = now.slice(0, 10)
  if (row.status === 'done' && status !== undefined && status !== 'done' && completedDate === undefined) finalCompletedDate = null

  const sets = ['updated_at = ?', 'progress = ?', 'status = ?', 'completed_date = ?']
  const binds = [now, finalProgress, finalStatus, finalCompletedDate]
  if (title !== undefined) { sets.push('title = ?'); binds.push(title) }
  if (description !== undefined) { sets.push('description = ?'); binds.push(description) }
  if (responsibleTeam !== undefined) { sets.push('responsible_team = ?'); binds.push(responsibleTeam) }
  if (assigneeAgentName !== undefined) { sets.push('assignee_agent_name = ?'); binds.push(assigneeAgentName) }
  if (startDate !== undefined) { sets.push('start_date = ?'); binds.push(startDate) }
  if (endDate !== undefined) { sets.push('end_date = ?'); binds.push(endDate) }
  binds.push(id)

  await db.prepare(`UPDATE wbs_items SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return { id, status: finalStatus, progress: finalProgress, updatedAt: now }
}
