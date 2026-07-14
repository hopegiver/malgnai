/**
 * reap-hanging.js — running 상태로 30분 이상 갇혀있는 명령을 자동으로 failed로 변경.
 * spawn-due/poll-commands 같은 루프 함수가 주기적으로 호출해 좀비 명령을 정리한다.
 */

const HANGING_TIMEOUT_MS = 30 * 60 * 1000 // 30분

export async function reapHangingCommands(db) {
  const now = new Date()
  const cutoffTime = new Date(now - HANGING_TIMEOUT_MS)

  try {
    const stmt = db.prepare(`
      UPDATE commands
      SET status='failed',
          error='Timeout: running for 30+ minutes',
          updated_at=datetime('now')
      WHERE status='running' AND claimed_at IS NOT NULL
        AND datetime(claimed_at) < datetime(?)
    `)

    const result = stmt.run(cutoffTime.toISOString())

    if (result.changes > 0) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'reap_hanging',
        reaped: result.changes,
        timeout_ms: HANGING_TIMEOUT_MS
      }))
    }

    return result.changes
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'reap_hanging_error',
      error: e.message
    }))
    return 0
  }
}
