// Phase 1(2026-06-30): 업무 축 + 목표/KPI 확장 컬럼. 전부 선택적(미지정 시 기존값/기본값 보존).
// 호출부(웹/MCP/sync)가 안 넘기면 건드리지 않으므로 기존 시그니처 100% 하위호환.
// P0(재설계): 소유권(owner_user_id=username, 블로커 B1 교정) + 1분 틱 due 컬럼(next_run_at/last_run_at)을
//   확장 컬럼 화이트리스트에 추가 → create/update 가 명시로 넘겨야만 SET/INSERT(미지정 시 기존값·기본값 보존).
const PROJECT_EXT_COLS = ['kind', 'lead_agent_name', 'goal', 'kpi_json', 'autonomy_level', 'cadence', 'autonomy_enabled', 'owner_user_id', 'next_run_at', 'last_run_at']

export default class ProjectsDao {
  constructor(db) { this.db = db }

  async findAll(status, limit = 50, offset = 0, kind) {
    // 선택적 필터(status, kind) 를 동적 WHERE 로 조립.
    // status 를 명시하지 않으면 소프트delete(status='deleted')는 기본적으로 숨긴다 — 목록/집계 등
    // "지금 살아있는 프로젝트"를 기대하는 호출부가 죽은 프로젝트로 오염되지 않게. status='deleted'를
    // 명시하면(휴지통 뷰 등) 그대로 조회된다.
    const where = []
    const args = []
    if (status) { where.push('status = ?'); args.push(status) }
    else { where.push("status != 'deleted'") }
    if (kind) { where.push('kind = ?'); args.push(kind) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    args.push(limit, offset)
    return (await this.db.prepare(
      `SELECT * FROM projects ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).bind(...args).all()).results
  }

  // workspace 경로 접두사로 시작하는(= 로컬 폴더 스캔 대상인) 프로젝트 중 아직 삭제되지 않은 것들.
  // sync 가 "이번 스캔에 없는 폴더 = 사라짐" 을 판단할 후보 집합을 구하는 데 쓴다.
  async findByPathPrefix(prefix) {
    return (await this.db.prepare(
      `SELECT id, path FROM projects WHERE path LIKE ? ESCAPE '\\' AND status != 'deleted'`
    ).bind(prefix.replace(/[\\%_]/g, '\\$&') + '%').all()).results
  }

  async findById(id) {
    return await this.db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first()
  }

  // 이름으로 조회(B-3 정기 업무: 잡 정의가 환경무관 프로젝트명을 쓰고 서버가 id로 매핑).
  async findByName(name) {
    return await this.db.prepare('SELECT * FROM projects WHERE name = ?').bind(name).first()
  }

  async create({ id, name, description, status, path, updated_at, ...ext }) {
    const now = new Date().toISOString()
    // updated_at = "최근 업데이트"(실제 작업 시각). 동기화가 폴더 mtime을 넘기면 그 값을 쓰고,
    // 없으면 생성 시각으로 둔다(정렬은 updated_at DESC).
    const updated = updated_at || now
    // Phase 1 확장 컬럼: 넘어온 것만 동적으로 INSERT. 미지정 컬럼은 DB 기본값(kind='dev' 등) 적용.
    const extCols = PROJECT_EXT_COLS.filter(c => ext[c] !== undefined)
    const cols = ['id', 'name', 'description', 'status', 'path', 'created_at', 'updated_at', ...extCols]
    const vals = [id, name, description || null, status || 'pending', path || null, now, updated, ...extCols.map(c => ext[c])]
    await this.db.prepare(
      `INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).bind(...vals).run()
    return await this.findById(id)
  }

  async update(id, fields) {
    const existing = await this.findById(id)
    if (!existing) return null
    const name = fields.name ?? existing.name
    const description = fields.description !== undefined ? fields.description : existing.description
    const status = fields.status ?? existing.status
    const path = fields.path !== undefined ? fields.path : existing.path
    // updated_at을 명시로 넘기면 그 값(폴더 mtime), 아니면 현재 시각.
    const updated = fields.updated_at || new Date().toISOString()
    // Phase 1 확장 컬럼: fields에 명시된 것만 SET 절에 추가(미지정 시 기존값 그대로 보존).
    const setCols = ['name=?', 'description=?', 'status=?', 'path=?', 'updated_at=?']
    const setVals = [name, description, status, path, updated]
    for (const c of PROJECT_EXT_COLS) {
      if (fields[c] !== undefined) { setCols.push(`${c}=?`); setVals.push(fields[c]) }
    }
    await this.db.prepare(
      `UPDATE projects SET ${setCols.join(', ')} WHERE id=?`
    ).bind(...setVals, id).run()
    return await this.findById(id)
  }

  async delete(id) {
    const result = await this.db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run()
    return result.meta.changes > 0
  }

  async upsert({ id, name, description, status, path, updated_at, ...ext }) {
    // 매칭 키 = **폴더명(basename)** 대소문자 무시. 머신/OS 이주로 경로 표기가 바뀌어도
    // (g:/workspace/x → /Users/.../x) 같은 프로젝트로 인식해 ID가 보존된다.
    // (이전엔 full path 정확매칭이라 Win→Mac 전환 시 같은 폴더가 새 UUID로 중복 생성되고,
    //  옛 행이 정리되며 FK ON DELETE SET NULL 로 decisions/issues/memories 링크가 끊겼다 — 이슈 cae69076.)
    // 한 워크스페이스 안에서 폴더명은 유일하다는 전제(같은 basename이 여러 위치면 첫 행에 병합).
    const norm = (path || '').replace(/\\/g, '/')
    const folder = norm.split('/').filter(Boolean).pop() || ''
    let existing = null
    if (norm) {
      // 정확 일치 OR 경로가 '/<folder>' 로 끝나는 행(세그먼트 경계 '/' 로 부분일치 오탐 방지).
      const likeFolder = '%/' + folder.replace(/[\\%_]/g, '\\$&')
      existing = await this.db.prepare(
        `SELECT * FROM projects
          WHERE LOWER(path) = LOWER(?) OR LOWER(path) LIKE LOWER(?) ESCAPE '\\'
          ORDER BY created_at ASC LIMIT 1`
      ).bind(norm, likeFolder).first()
    }
    // Phase 1: 업무 워크스페이스 태깅(kind/lead_agent_name/goal 등)을 sync 가 STATUS.md 메타로
    // 실어 보내면 통과시킨다. 미지정 시 빈 객체 → 기존 로직과 동일(하위호환).
    const extFields = {}
    for (const c of PROJECT_EXT_COLS) if (ext[c] !== undefined) extFields[c] = ext[c]
    if (existing) {
      // 이미 있는 프로젝트는 동기화가 시각/상태/경로만 갱신한다(ID·name·description 보존).
      // name/description은 MCP 큐레이션값(예: "맑은세일즈")이 폴더명(영문)으로 덮이지 않게 둔다.
      // 확장 메타(kind/lead 등)가 명시로 오면 함께 갱신, 안 오면 기존값 보존.
      return await this.update(existing.id, { status, path: norm, updated_at, ...extFields })
    }
    // 신규 생성: STATUS.md 헤더에서 넘어온 안정적 id 가 있으면 그것을(재생성해도 결정적),
    // 없으면 무작위 UUID. (sync-projects 가 각 폴더 STATUS.md 의 project_id 를 실어 보낸다.)
    const newId = (typeof id === 'string' && /^[0-9a-fA-F-]{8,}$/.test(id)) ? id : crypto.randomUUID()
    return await this.create({ id: newId, name, description, status, path: norm, updated_at, ...extFields })
  }

  async countByStatus() {
    const rows = (await this.db.prepare('SELECT status, COUNT(*) as cnt FROM projects GROUP BY status').all()).results
    const counts = { pending: 0, active: 0, completed: 0, on_hold: 0, deleted: 0 }
    for (const r of rows) counts[r.status] = r.cnt
    return counts
  }
}
