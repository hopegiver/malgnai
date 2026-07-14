/**
 * FeatureRequestsDao — 사용자 "기능 개선 요청" 제출 → 엔진 완전자동 심사 큐 DAO.
 *
 * 상태 머신: pending → reviewing(엔진이 claim) → approved|rejected(종결).
 * 사람이 수동으로 승인/반려하는 경로는 없다(완전자동 심사 요구사항, PATCH 라우트 자체가 없음).
 * claimNextPending()은 CommandsDao.claim()과 동형의 단일 statement 조건부 UPDATE로 원자적
 *   점유를 보장한다(SELECT 서브쿼리로 대상을 고르고 같은 statement의 WHERE status='pending' 재확인
 *   으로 TOCTOU를 차단 — SELECT-then-UPDATE 두 단계로 쪼개면 두 엔진 틱이 동시에 같은 행을 집을 수
 *   있는 경합 창이 생긴다).
 * review_attempts(migrations/014)는 claim→실패→pending 재시도 루프의 횟수를 센다 — claimNextPending()
 *   이 항상 "가장 오래된 pending"을 집기 때문에, 카운터 없이는 영구 실패 요청 1건이 큐 전체를 무기한
 *   정지시킬 수 있다(engine/feature-review.js의 MAX_REVIEW_ATTEMPTS가 이 값을 보고 종결 반려한다).
 */
export default class FeatureRequestsDao {
  constructor(db) { this.db = db }

  /** status는 항상 'pending'으로 고정(호출부가 넘겨도 무시) — 완전자동 심사 전에는 사람이 상태를 정하지 않는다. */
  async create({ id, project_id, requester_user_id, title, description, created_at, updated_at }) {
    const now = new Date().toISOString()
    await this.db.prepare(
      `INSERT INTO feature_requests (id, project_id, requester_user_id, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      id,
      project_id,
      requester_user_id,
      title,
      description || null,
      created_at || now,
      updated_at || now,
    ).run()
    return await this.findById(id)
  }

  async findById(id) {
    return await this.db.prepare('SELECT * FROM feature_requests WHERE id = ?').bind(id).first()
  }

  /**
   * findAll — 목록 조회. malgnai 자신에 대한 업그레이드 요청 게시판이라 소유권 스코핑은 없다 —
   *   로그인한 사용자라면 누구나 전체 요청을 볼 수 있다(개인 프로젝트 데이터가 아님).
   */
  async findAll({ status, limit = 50, offset = 0 } = {}) {
    const conds = []
    const vals = []
    if (status) { conds.push('status = ?'); vals.push(status) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    vals.push(limit, offset)
    return (await this.db.prepare(
      `SELECT * FROM feature_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...vals).all()).results
  }

  /**
   * claimNextPending — 가장 오래된 pending 1건을 원자적으로 'reviewing'으로 점유.
   * @returns {Promise<object|null>} 점유한 row, 또는 pending이 없으면 null.
   */
  async claimNextPending() {
    const now = new Date().toISOString()
    const res = await this.db.prepare(
      `UPDATE feature_requests
          SET status='reviewing', updated_at=?
        WHERE id = (
                SELECT id FROM feature_requests WHERE status='pending' ORDER BY created_at ASC LIMIT 1
              )
          AND status='pending'`
    ).bind(now).run()
    if (!res.meta || res.meta.changes === 0) return null
    return await this.db.prepare(
      `SELECT * FROM feature_requests WHERE status='reviewing' AND updated_at=? ORDER BY created_at ASC LIMIT 1`
    ).bind(now).first()
  }

  /**
   * updateReview — 심사 결과 반영. status='pending'으로 되돌릴 때(파싱 실패 등 재시도)는
   *   review_reason/reviewed_at을 null로 넘겨 "아직 심사되지 않음" 의미를 보존한다(호출부 책임).
   * review_attempts를 넘기면 재시도 횟수 카운터를 함께 갱신한다(미지정 시 기존 값 유지 — 종결
   *   상태(approved/rejected) 반영처럼 카운터가 무의미한 호출은 생략 가능).
   */
  async updateReview(id, { status, review_reason = null, reviewed_at = null, review_attempts } = {}) {
    const now = new Date().toISOString()
    if (review_attempts === undefined) {
      await this.db.prepare(
        `UPDATE feature_requests SET status=?, review_reason=?, reviewed_at=?, updated_at=? WHERE id=?`
      ).bind(status, review_reason, reviewed_at, now, id).run()
    } else {
      await this.db.prepare(
        `UPDATE feature_requests SET status=?, review_reason=?, reviewed_at=?, updated_at=?, review_attempts=? WHERE id=?`
      ).bind(status, review_reason, reviewed_at, now, review_attempts, id).run()
    }
    return await this.findById(id)
  }
}
