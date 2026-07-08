/**
 * load-api-key.js — [M-3] X-API-Key 자동 배선 헬퍼.
 *
 * 자동화 스크립트(poll-commands, run-scheduled-jobs 등)가 X-API-Key 로 보호된
 * /api 라우트를 호출할 때 사용할 MALGNAI_API_KEY 를 확보한다.
 *
 * 우선순위:
 *   1) process.env.MALGNAI_API_KEY (LaunchAgent/셸이 이미 주입한 경우 — 최우선)
 *   2) 프로젝트 루트 .dev.vars 의 MALGNAI_API_KEY (서버와 동일한 단일 소스)
 *
 * 이렇게 두면 키를 여러 설정 파일에 복제하지 않고 .dev.vars 한 곳만 관리하면 된다
 * (키 표류·불일치로 파이프라인이 조용히 401 나는 사고 방지). 반환값은 문자열 또는 ''.
 * 절대 키 값을 로그로 출력하지 않는다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

function readFromDotVars(path) {
  if (!existsSync(path)) return ''
  try {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      if (line.slice(0, eq).trim() !== 'MALGNAI_API_KEY') continue
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      return val
    }
  } catch { /* 읽기 실패 시 빈 값 반환 */ }
  return ''
}

/** MALGNAI_API_KEY 를 해석해 반환하고, process.env 에도 채워준다(자식 프로세스 상속용). */
export function resolveApiKey() {
  if (process.env.MALGNAI_API_KEY) return process.env.MALGNAI_API_KEY
  const key = readFromDotVars(join(ROOT, '.dev.vars'))
  if (key) process.env.MALGNAI_API_KEY = key
  return key || ''
}
