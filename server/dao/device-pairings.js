// device_pairings 테이블 DAO — 디바이스 페어링 플로우 임시 상태(architecture.md §6.2, 10분 TTL).
const PAIRING_TTL_SECONDS = 600
// 혼동되기 쉬운 문자(0/O, 1/I/L) 제외한 사람이 읽기 쉬운 코드 알파벳.
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generatePairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = ''
  for (let i = 0; i < 8; i++) out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

export async function create(db, { deviceId, deviceName }) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000).toISOString()
  // 코드 충돌은 사실상 불가능한 확률(32^8)이지만, 혹시를 대비해 최대 3회 재시도.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePairingCode()
    try {
      await db.prepare(
        `INSERT INTO device_pairings (pairing_code, device_id, device_name, status, expires_at, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      ).bind(code, deviceId, deviceName || null, expiresAt, now.toISOString()).run()
      return { pairingCode: code, expiresIn: PAIRING_TTL_SECONDS }
    } catch (e) {
      if (!String(e.message || '').includes('UNIQUE') || attempt === 2) throw e
    }
  }
}

export async function findByCode(db, code) {
  return db.prepare('SELECT * FROM device_pairings WHERE pairing_code = ?').bind(code).first()
}

export async function approve(db, code, { approvedBy, deviceTokenId, rawTokenOnce }) {
  const res = await db.prepare(
    "UPDATE device_pairings SET status='approved', approved_by=?, device_token_id=?, raw_token_once=? WHERE pairing_code=? AND status='pending'"
  ).bind(approvedBy, deviceTokenId, rawTokenOnce, code).run()
  return res.meta.changes > 0
}

/** pair-status 폴링이 raw_token_once를 읽고 나면 즉시 지운다(평문 노출은 이 1회뿐). */
export async function consumeRawToken(db, code) {
  await db.prepare('UPDATE device_pairings SET raw_token_once = NULL WHERE pairing_code = ?').bind(code).run()
}

export function isExpired(pairing) {
  return new Date(pairing.expires_at).getTime() < Date.now()
}

export async function markExpired(db, code) {
  await db.prepare("UPDATE device_pairings SET status='expired' WHERE pairing_code = ? AND status='pending'").bind(code).run()
}
