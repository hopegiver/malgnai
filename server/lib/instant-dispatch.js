/**
 * instant-dispatch.js — 승인 훅포인트(설계 §2.4).
 *
 * ⚠️ 2026-07-13 대표 결정: "자율실행의 프로세스는 메인루프(엔진)를 통해서만 처리한다" — approve 시
 *   웹서버 프로세스에서 즉시 claim+dispatchApprovedCommand 하던 것을 제거했다. 이제 approve는 상태를
 *   'approved'로 남기기만 하고, 실제 실행은 항상 engine/safety-poll.js 의 claim(status='approved'
 *   대상)이 다음 엔진 틱(최대 60초)에 집어가서 엔진 프로세스 안에서 수행한다. 웹서버는 더 이상 claude
 *   서브프로세스를 직접 스폰하지 않는다(§3-1 direct 명령·console 은 별도 — 이 결정의 범위 밖).
 *
 * reviewCommandTx 는 기존 CommandsDao.review() 의 SQL 을 동기 tx 버전으로 재구현한다. approve 시
 *   instruction append(즉시·100% 전달 채널)까지는 여기서 하지만, 그 뒤 실행 자체는 트리거하지 않는다.
 */

/**
 * reviewCommandTx — 검토(approve/reject/request_changes)를 트랜잭션으로 처리한다.
 * @param {object} tx  동기 DB 파사드(db.transaction((tx) => ...) 콜백 안에서만 호출).
 * @param {{id:string, decision:string, review_note:string|null, reviewed_by:string|null}} args
 * @returns {{command: object|null}}
 *   command===null → review 대상 없음(이미 검토됨/대기상태 아님, 호출부는 409).
 *   command 있음 → 검토 반영됨. approve 여도 실행은 트리거하지 않는다(엔진 safety-poll 이 집어감).
 */
/**
 * claimApprovedForProject — 'approved' command 1건을 **프로젝트당 active-1 불변식(§7)** 을 지키며
 *   타겟 claim('approved'→'claimed')한다. 웹서버 즉시디스패치 경로(§3-1 direct 명령·phase-chain)가
 *   공유 — approve 리뷰 경로는 2026-07-13부로 더 이상 이 함수를 호출하지 않는다(위 파일 docstring 참고).
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
  if (!m) return { command: null } // 잘못된 decision은 API 라우트가 먼저 막지만 방어적으로 처리.

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
    return { command: null }
  }

  // 2) 원본 스냅샷(instruction append 전) — approve 의 즉시 append 로 오염되기 전에 한 번만 읽어
  //    step 3 의 memory 요약(대상 명령 원문 300자)이 항상 "대표 결정 이전의 순수 제안"을 가리키게 한다.
  const target = tx.prepare('SELECT project_id, task_type, instruction FROM commands WHERE id=?').bind(id).first()

  if (decision === 'approve') {
    // 승인 메모(+ 대표 코멘트가 있으면 함께)를 instruction 끝에 추가 — 같은 트랜잭션·같은 command 라
    //   지연 없이 100% 전달되는 채널(처음 승인할 때만 — 중복 방지). 실행 자체는 트리거하지 않는다 —
    //   status='approved'로 남고, engine/safety-poll.js 가 다음 틱(최대 60초)에 claim 해 실행한다.
    if (target && !target.instruction.includes('승인됨')) {
      const noteLine = typeof review_note === 'string' && review_note.trim()
        ? `\n대표 코멘트: ${review_note.trim()}`
        : ''
      const approvalMsg = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n✅ 승인됨\n승인자: ${reviewed_by || 'admin'}\n시각: ${now}${noteLine}\n진행하세요.\n━━━━━━━━━━━━━━━━━━━━━━━━`

      tx.prepare('UPDATE commands SET instruction=?, updated_at=? WHERE id=?')
        .bind(target.instruction + approvalMsg, now, id)
        .run()
    }
  }

  // 3) (설계 §6-2, 2026-07-13 3종 통일) 대표의 결정 코멘트를 프로젝트 컨텍스트(memories/FEEDBACK)에
  //    적재한다. engine/spawn.js 가 project_cycle 스폰마다 무조건 조회해 워커 프롬프트 최상단에
  //    강제 주입하는 기존 경로를 그대로 재사용(별도 배선 0). 300자 요약(순수 원본, 위 approve append
  //    전 스냅샷) + 원본 command_id 참조를 남겨 다음 워커가 필요시 원본 전체를 조회할 수 있게 한다.
  //    - approve: 코멘트가 있을 때만 적재(코멘트 없으면 위 instruction append 로 이미 100% 전달됨 — 중복 소음 방지).
  //    - request_changes: 항상 적재(코멘트 없으면 사실상 없음 — API 계약상 필수 아니라 방어적으로 유지).
  //    - reject: 코멘트가 없어도 최소 "반려됨(사유 미기재)" 한 줄은 남겨, 다음 사이클 워커가 같은
  //      제안을 재차 올리지 않도록 한다.
  {
    const noted = typeof review_note === 'string' && review_note.trim() ? review_note.trim() : null
    const LABEL = { approve: '승인 코멘트', reject: '반려', request_changes: '수정 요청(승인 반려)' }[decision]
    const bodyText = noted || (decision === 'reject' ? '반려됨(사유 미기재)' : null)

    if (bodyText && target?.project_id) {
      tx.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'FEEDBACK', ?, ?, 4, 'system', ?)`
      ).bind(
        crypto.randomUUID(), target.project_id,
        `${LABEL}: ${target.task_type || '작업'}`,
        `${LABEL} 내용: ${bodyText}\n\n(대상 명령 #${id}: ${String(target.instruction || '').slice(0, 300)})`,
        now,
      ).run()
    }
  }

  const command = tx.prepare('SELECT * FROM commands WHERE id=?').bind(id).first()
  return { command }
}
