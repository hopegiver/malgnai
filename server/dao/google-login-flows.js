// google_login_flows 테이블 DAO — Google 로그인(우리가 Google의 **클라이언트**인 축) 1회용 플로우
// 상태. 설계 정본: docs/design/google-oauth-login.md 결정 3·6, migrations/0024.
// ⚠️ server/dao/oauth-authorization-codes.js(우리가 **제공자**인 축)와 혼동 금지 — §0.2 규약.

/** /start — 인가 요청 개시. status='pending', 10분 TTL. */
export async function insert(db, { state, bindingHash, nonce, codeVerifier, redirectPath, mode, expiresAt }) {
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO google_login_flows
       (state, binding_hash, nonce, code_verifier, redirect_path, mode, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(state, bindingHash, nonce, codeVerifier, redirectPath || null, mode, expiresAt, now).run()
  return { state, binding_hash: bindingHash, nonce, code_verifier: codeVerifier, redirect_path: redirectPath || null, mode, status: 'pending', expires_at: expiresAt, created_at: now }
}

export async function findByState(db, state) {
  return db.prepare('SELECT * FROM google_login_flows WHERE state = ?').bind(state).first()
}

/** /callback 검증 순서 5 — "consume(state)". status='pending' AND 미만료 조건으로 단독 클레임
 *  (status→'authorized'). changes>0인 요청만 이 플로우 행의 배타적 소유권을 얻는다 — 이후 실패
 *  마킹(markFailed)은 이 클레임에 성공한 요청만 호출해야 한다(아래 markFailed 주석 참고). */
export async function claim(db, state) {
  const now = new Date().toISOString()
  const res = await db.prepare(
    "UPDATE google_login_flows SET status='authorized' WHERE state = ? AND status='pending' AND expires_at > ?"
  ).bind(state, now).run()
  return res.meta.changes > 0
}

/** 실패 마킹(§3.2 "검증 순서 — 하나라도 실패하면 즉시 중단, 플로우 행은 status='failed'").
 *  ⚠️ (보안점검 M2 처방) 이전에는 pending/authorized 둘 다 허용하는 단일 markFailed()가 있었으나,
 *  claim() **이전** 단계(에러 파라미터·코드 부재·바인딩 쿠키 불일치)는 이 요청이 그 행의 소유권을
 *  얻지 못한 상태(status는 여전히 'pending'이어야 정상)라 'authorized'까지 허용하면 다른 요청이
 *  방금 claim()한 행을 덮어써 정상 로그인을 방해할 수 있다(실증: repro-markfailed-stomp.mjs).
 *  그래서 소유권 상태별로 함수를 분리한다 — 호출부는 이 요청이 claim() 이전인지 이후인지에 따라
 *  아래 둘 중 하나만 부른다. */

/** claim() **이전** 실패 전용. status가 아직 'pending'인 행만 실패 처리한다 — 이미 다른 요청이
 *  claim()해 'authorized'가 된 행은 절대 건드리지 않는다(그 요청은 이 요청과 무관하게 진행 중일 수
 *  있다). changes>0이면 이 요청이 실제로 그 행을 pending→failed로 전이시켰다는 뜻이다. */
export async function markFailedIfPending(db, state) {
  const now = new Date().toISOString()
  const res = await db.prepare(
    "UPDATE google_login_flows SET status='failed', completed_at=? WHERE state = ? AND status='pending'"
  ).bind(now, state).run()
  return res.meta.changes > 0
}

/** claim() **이후**(이 요청이 소유한 'authorized' 행) 실패 전용. claim()에 성공한 요청만 호출해야
 *  한다 — 그 요청은 이미 이 행의 배타적 소유자이므로 'authorized' 상태를 그대로 매칭 조건으로 쓴다. */
export async function markFailedOwned(db, state) {
  const now = new Date().toISOString()
  await db.prepare(
    "UPDATE google_login_flows SET status='failed', completed_at=? WHERE state = ? AND status='authorized'"
  ).bind(now, state).run()
}

/** /callback 검증 순서 10 — 핸드오프 코드 발급. claim()으로 소유권을 얻은 'authorized' 행에만
 *  기록한다(재요청/레이스 방어). changes>0이어야 콜백이 핸드오프 hash를 응답에 실을 수 있다. */
export async function setHandoff(db, state, { userId, handoffCodeHash, handoffExpiresAt }) {
  const res = await db.prepare(
    "UPDATE google_login_flows SET user_id=?, handoff_code_hash=?, handoff_expires_at=? WHERE state=? AND status='authorized'"
  ).bind(userId, handoffCodeHash, handoffExpiresAt, state).run()
  return res.meta.changes > 0
}

export async function findByHandoffHash(db, handoffCodeHash) {
  return db.prepare('SELECT * FROM google_login_flows WHERE handoff_code_hash = ?').bind(handoffCodeHash).first()
}

/** POST /exchange — 핸드오프 코드 단독 소비. status='authorized' AND 미만료 조건부 UPDATE
 *  (oauth_authorization_codes.consume() 선례와 동일 형태). changes>0이면 성공(레이스/재사용 방지). */
export async function consumeHandoff(db, handoffCodeHash) {
  const now = new Date().toISOString()
  const res = await db.prepare(
    "UPDATE google_login_flows SET status='consumed', completed_at=? WHERE handoff_code_hash = ? AND status='authorized' AND handoff_expires_at > ?"
  ).bind(now, handoffCodeHash, now).run()
  return res.meta.changes > 0
}

/** 크론 스윕(6.9, 보안점검 H1 처방) — server/index.js scheduled()에서 독립 ctx.waitUntil로 호출.
 *  이전에는 상한 없는 단일 DELETE라 공격 트래픽으로 행이 급증하면 D1 실행 한도에 걸려 실패할 수
 *  있었다(그리고 실패해도 관측되지 않았다) — 그래서 batchSize 단위로 상한(maxBatches) 안에서
 *  반복 삭제하고, 총 삭제 건수를 반환해 호출부가 로그로 남길 수 있게 한다(이상 증가 관측 가능).
 *  실패는 여전히 예외를 던지므로(호출부 catch에서 로깅) 조용히 삼켜지지 않는다. */
export async function deleteExpiredBefore(db, cutoffIso, { batchSize = 5000, maxBatches = 20 } = {}) {
  let totalDeleted = 0
  for (let i = 0; i < maxBatches; i++) {
    const res = await db.prepare(
      'DELETE FROM google_login_flows WHERE state IN (SELECT state FROM google_login_flows WHERE expires_at < ? LIMIT ?)'
    ).bind(cutoffIso, batchSize).run()
    const deleted = res.meta.changes || 0
    totalDeleted += deleted
    if (deleted < batchSize) break // 이번 배치가 상한보다 적게 지웠다 = 더 지울 행이 없다
  }
  return totalDeleted
}
