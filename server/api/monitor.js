/**
 * monitor.js — AI 실행 실시간 모니터 API
 *
 * GET /api/monitor/stream[?project_id=]  — SSE 스트림. project_id 주면 그 프로젝트로 스코핑
 *   (프로젝트 상세 페이지 "모니터링" 탭용), 생략하면 전역(/claude "실행 모니터" 탭용). 이벤트:
 *   { type: 'init',     active: [...], recent: [...] }  — 연결 직후 현재 스냅샷(스코핑 적용됨)
 *   { type: 'start',    run: {...} }                     — 워커 실행 시작
 *   { type: 'end',      run: {...} }                     — 워커 실행 완료
 *   { type: 'progress', commandId, projectId, item }      — 실행 중 진행 항목(도구 호출/응답 요약)
 *   { type: 'chunk',    commandId, projectId, text }      — stderr 실시간 청크(진단용)
 *   { type: 'ping' }                                     — 15초 하트비트
 *
 * GET /api/monitor/active[?project_id=]  — JSON 현재 상태 스냅샷 (SSE 대신 폴링용)
 *
 * 인증: Cloudflare 경유 외부 요청에서는 EventSource가 헤더를 지원하지 않으므로
 *   ?token=<JWT> 쿼리 파라미터로 검증. 로컬(localhost) 요청은 통과.
 */
import { Hono } from 'hono'
import { execMonitor } from '../lib/exec-monitor.js'
import { verifyJwt } from '../middleware/auth.js'
import { unauthorized } from '../utils/response.js'

const router = new Hono()

async function checkAuth(c) {
  const viaCloudflare = c.req.header('cf-ray') || c.req.header('cf-connecting-ip')
  if (!viaCloudflare) return true
  const token = new URL(c.req.url).searchParams.get('token')
  if (!token) return false
  try {
    await verifyJwt(token, c.env.JWT_SECRET)
    return true
  } catch {
    return false
  }
}

router.get('/stream', async (c) => {
  if (!(await checkAuth(c))) return unauthorized(c)
  const projectId = new URL(c.req.url).searchParams.get('project_id') || null

  let closed = false
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()

  const write = (data) => {
    if (closed) return
    writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => { closed = true })
  }

  // 연결 직후 현재 상태 전송(project_id 있으면 그 프로젝트로 스코핑)
  write({ type: 'init', ...execMonitor.snapshot(projectId) })

  // 이후 이벤트 구독 — project_id 스코핑 시 다른 프로젝트 이벤트는 걸러낸다(start/end 는 run.project_id,
  //   progress/chunk 는 이벤트 자체의 projectId 필드로 판별).
  const onExec = (event) => {
    if (projectId) {
      const evtProjectId = event.run ? event.run.projectId : event.projectId
      if (evtProjectId !== projectId) return
    }
    write(event)
  }
  execMonitor.on('exec', onExec)

  // 15초 하트비트 (연결 유지 + 프록시 타임아웃 방지)
  const hb = setInterval(() => write({ type: 'ping' }), 15000)

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(hb)
    execMonitor.off('exec', onExec)
    writer.close().catch(() => {})
  }

  // Web API AbortSignal (Workers/Bun) 또는 Node.js IncomingMessage 'close' 이벤트 양쪽 지원.
  // @hono/node-server 에서 c.req.raw 는 http.IncomingMessage 라 .signal 이 없으므로
  // Node.js 'close' 이벤트로도 cleanup 을 연결한다.
  const signal = c.req.raw?.signal
  if (signal) signal.addEventListener('abort', cleanup, { once: true })
  if (c.req.raw && typeof c.req.raw.on === 'function') {
    c.req.raw.on('close', cleanup)
  }

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

router.get('/active', async (c) => {
  if (!(await checkAuth(c))) return unauthorized(c)
  const projectId = new URL(c.req.url).searchParams.get('project_id') || null
  return c.json(execMonitor.snapshot(projectId))
})

export default router
