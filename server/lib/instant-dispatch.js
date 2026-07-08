/**
 * instant-dispatch.js — 승인 훅포인트(설계 §2.4, v3 최종).
 *
 * decision d01d3834 가 제시한 훅포인트 문구("review() 직후 claim() 을 마저 호출")를 문자 그대로
 *   구현하면 버그가 된다 — 기존 CommandsDao.claim({host}) 는 큐에서 가장 오래된 1건을 가져오는
 *   범용 메서드라, 방금 승인한 바로 그 command 를 가져간다는 보장이 없다(다른 승인된-미실행 커맨드가
 *   더 오래됐다면 그걸 대신 가져가 버린다). **타겟 지정 claim** 이 필요하다.
 *
 * reviewCommandTx 는 기존 CommandsDao.review() 의 SQL 을 동기 tx 버전으로 재구현하고,
 *   decision==='approve' && 방금 갱신 성공했을 때만 타겟 claim(범용 claim() 재사용 안 함)을
 *   같은 트랜잭션에서 이어 실행한다 — TOCTOU 차단(spawnOneCycle 과 동형 원자성 패턴).
 */

/**
 * reviewCommandTx — 검토(approve/reject/request_changes) + (approve 시) 타겟 claim 을
 *   하나의 트랜잭션으로 원자화한다.
 * @param {object} tx  동기 DB 파사드(db.transaction((tx) => ...) 콜백 안에서만 호출).
 * @param {{id:string, decision:string, review_note:string|null, reviewed_by:string|null}} args
 * @returns {{command: object|null, claimedForSpawn: boolean}}
 *   command===null → review 대상 없음(이미 검토됨/대기상태 아님, 호출부는 409).
 *   claimedForSpawn===true → 이 요청이 방금 실행 권한을 땄다(호출부가 dispatchApprovedCommand 트리거).
 *   claimedForSpawn===false(command 는 있음) → 극히 드문 경합으로 poll 이 그 찰나에 이미 채감,
 *     또는 approve 가 아닌 결정 — 정상 poll 경로로 폴백(에러 아님).
 */
/**
 * claimApprovedForProject — 'approved' command 1건을 **프로젝트당 active-1 불변식(§7)** 을 지키며
 *   타겟 claim('approved'→'claimed')한다. 즉시디스패치 경로(사람 approve·direct 명령·향후 AI)가 공유.
 *
 *   대상 프로젝트에 이미 claimed/running 인 command 가 있으면 UPDATE 는 NOT EXISTS 로 changes()=0 →
 *   false 반환. 호출부는 이 경우 즉시 dispatch 하지 않고 'approved' 상태로 남겨, 프로젝트가 비는 대로
 *   안전망 poll(claim, 동일 NOT EXISTS 가드)이 집어가게 한다. TOCTOU 는 단일 statement 원자성으로 차단.
 *
 * @param {object} tx        동기 DB 파사드.
 * @param {string} id        타겟 command id(호출 시점에 status='approved' 이어야 유의미).
 * @param {string} claimedBy claimed_by 마커(기본 'server-immediate').
 * @returns {boolean} true = 이 호출이 실행권을 땄다(claimed). false = 프로젝트가 실행 중이거나 경합.
 */
export function claimApprovedForProject(tx, id, claimedBy = 'server-immediate') {
  const now = new Date().toISOString()
  const res = tx.prepare(
    `UPDATE commands SET status='claimed', claimed_by=?, claimed_at=?, updated_at=?
      WHERE id=? AND status='approved'
        AND NOT EXISTS (
              SELECT 1 FROM commands a
               WHERE a.project_id = (SELECT project_id FROM commands WHERE id=?)
                 AND a.status IN ('claimed','running')
            )`
  ).bind(claimedBy, now, now, id, id).run()
  return !!(res.meta && res.meta.changes === 1)
}

export function reviewCommandTx(tx, { id, decision, review_note, reviewed_by }) {
  const MAP = {
    approve: { status: 'approved', review_status: 'approved' },
    reject: { status: 'rejected', review_status: 'rejected' },
    // (설계 §6) 수정요청 = 원본을 terminal('rejected')로 마감 + review_status='changes_requested'로
    //   "하드 반려"와 구분. 원본은 절대 재실행 안 됨(좀비 제거). 수정 반영은 다음 사이클 워커가
    //   review_note(아래 memory 적재)를 읽어 새 proposal 로 낸다.
    request_changes: { status: 'rejected', review_status: 'changes_requested' },
  }
  const m = MAP[decision]
  if (!m) return { command: null, claimedForSpawn: false } // 잘못된 decision은 API 라우트가 먼저 막지만 방어적으로 처리.

  const now = new Date().toISOString()

  // 1) 기존 review() 로직 그대로(kind 가드 없음 — §0.2 로 대상 자체가 없음).
  const reviewRes = tx.prepare(
    `UPDATE commands
        SET status=?, review_status=?, review_note=?, reviewed_by=?, reviewed_at=?, updated_at=?
      WHERE id=? AND review_status IS NULL AND status='queued'`
  ).bind(
    m.status,
    m.review_status,
    review_note ?? null,
    reviewed_by ?? null,
    now,
    now,
    id,
  ).run()

  if (!reviewRes.meta || reviewRes.meta.changes === 0) {
    return { command: null, claimedForSpawn: false }
  }

  // 2) decision==='approve' && 방금 갱신 성공했을 때만 — 프로젝트당 active-1(§7 가드②) 을 지키며
  //    타겟 claim. 프로젝트가 이미 실행 중이면 claimedForSpawn=false → 'approved' 로 남아 프로젝트가
  //    비는 대로 안전망 poll 이 집어간다(즉시 dispatch 안 함). 경합(poll 선점) 역시 false 로 폴백.
  let claimedForSpawn = false
  if (decision === 'approve') {
    claimedForSpawn = claimApprovedForProject(tx, id, 'server-immediate')
  }

  // 3) (설계 §6-2) 수정요청의 review_note 를 프로젝트 컨텍스트(memories)에 적재한다. 다음 사이클
  //    워커가 STATUS.md+MCP 컨텍스트로 이 note 를 읽어 "수정 반영한 새 proposal"을 낸다(별도 배선 0).
  if (decision === 'request_changes' && typeof review_note === 'string' && review_note.trim()) {
    const target = tx.prepare('SELECT project_id, task_type, instruction FROM commands WHERE id=?').bind(id).first()
    if (target?.project_id) {
      tx.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'FEEDBACK', ?, ?, 4, 'system', ?)`
      ).bind(
        crypto.randomUUID(), target.project_id,
        `수정 요청(승인 반려): ${target.task_type || '작업'}`,
        `대표 수정요청 내용: ${review_note.trim()}\n\n(대상 명령: ${String(target.instruction || '').slice(0, 300)})`,
        now,
      ).run()
    }
  }

  const command = tx.prepare('SELECT * FROM commands WHERE id=?').bind(id).first()
  return { command, claimedForSpawn }
}
