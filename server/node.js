// malgnai 서버 진입점 (Node).
//
// 이 프로젝트는 Cloudflare Workers/D1/wrangler 를 완전히 폐기하고 로컬 Node 서버로
// 운영한다(맥미니 상시 서버 + 터널링). 이 파일이 유일한 진입점이다.
//   - DB:     better-sqlite3 를 D1 호환 인터페이스로 감싼 어댑터(sqlite-adapter.js)
//   - ASSETS: 로컬 ./app 디렉터리 정적 서빙(fetch(Request) → Response)
//   - vars/secrets: .dev.vars + 환경변수(process.env)
// DAO/API 라우트는 D1 호환 어댑터 덕에 한 줄도 고치지 않는다.
//
// 실행: npm start   (= node server/node.js)

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { serve } from '@hono/node-server'

import { wrapD1 } from './db/sqlite-adapter.js'
import { createApp } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── .dev.vars 자동 로드 ───────────────────────────────────────────
// 과거 wrangler dev 가 자동 로드하던 KEY=value 파일. Node 로 직접 띄울 때도
// 같은 비밀번호/시크릿을 쓰도록 process.env 에 채운다(이미 설정된 값은 보존).
function loadDotVars(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // 따옴표로 감싼 값 허용.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotVars(join(ROOT, '.dev.vars'))

// ── 설정 ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 9000)
// 루프백 전용 바인딩(기본). 외부는 cloudflared 터널만 경유하도록 강제 — LAN/Tailscale 에서
// origin(9000)에 직접 붙어 cf-ray 게이트를 우회(무인증)하는 경로를 차단한다.
// LAN 노출이 필요하면 HOST=0.0.0.0 으로 명시(그 경우 인증 게이트 보강 필수).
const HOST = process.env.HOST || '127.0.0.1'
// 정본 DB. 맥미니 이주 시 mcp 의 통합 sqlite 경로를 DB_PATH 로 가리키면 된다.
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'malgnai.db')
const APP_DIR = process.env.APP_DIR || join(ROOT, 'app')
const ENVIRONMENT = process.env.ENVIRONMENT || 'development'

// ── DB: better-sqlite3 → D1 호환 어댑터 ──────────────────────────
const sqlite = new Database(DB_PATH)
const DB = wrapD1(sqlite)

// ── ASSETS: 정적 자산 서빙(fetch(Request) → Response) ─────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html'
    // 디렉터리 탈출 방지: APP_DIR 밖 경로는 404.
    const filePath = normalize(join(APP_DIR, pathname))
    if (!filePath.startsWith(normalize(APP_DIR))) {
      return new Response('Not found', { status: 404 })
    }
    if (!existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const buf = await readFile(filePath)
      const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
      return new Response(buf, { status: 200, headers: { 'Content-Type': type } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  },
}

// ── env 구성 + 앱 생성 ────────────────────────────────────────────
const env = {
  DB,
  ASSETS,
  ENVIRONMENT,
  APP_ORIGIN: process.env.APP_ORIGIN || `http://localhost:${PORT}`,
  MALGNAI_API_KEY: process.env.MALGNAI_API_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
}

// [보안] 운영 전환 기본비번 함정(H-001) 경고 — 부팅 1회.
if (!process.env.ADMIN_PASSWORD) {
  if (ENVIRONMENT === 'development') {
    console.warn('[malgnai][보안경고] ADMIN_PASSWORD 미설정 → 개발 기본비번 사용 중. 외부 노출 전 반드시 설정할 것.')
  } else {
    console.warn('[malgnai][보안경고] 운영 모드인데 ADMIN_PASSWORD 미설정 — admin 시드/로그인이 동작하지 않는다.')
  }
}

const app = createApp(env)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[malgnai] Node 서버 기동 — http://${HOST}:${info.port} (외부는 cloudflared 터널 경유)`)
  console.log(`[malgnai] DB=${DB_PATH}  ASSETS=${APP_DIR}  ENV=${ENVIRONMENT}`)
})
