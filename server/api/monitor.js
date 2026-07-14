/**
 * monitor.js — AI 실행 실시간 모니터 API
 *
 * ⚠️ 2026-07-14 하이브리드 전환: "무엇이 실행중/최근완료인지" 목록·상태의 권위 소스는
 *   commands 테이블(GET /api/commands?status=claimed,running 등, DB 폴링, 크로스프로세스에도
 *   안전)로 이전됨 — 인메모리 execMonitor 싱글턴이 별도 프로세스(engine)의 이벤트를
 *   best-effort HTTP로 못 받는 근본적 취약성 때문(decision 참고). 이 파일의 exec-monitor
 *   기반 엔드포인트는 "선택한 1건의 라이브 stdout/stderr 로그 테일"(GET /log/:commandId)
 *   보조 용도로만 계속 쓰인다 — 값이 없어도(다른 프로세스 실행 등) 목록/상태 표시는
 *   DB 값으로 계속 정상 동작해야 한다(degrade gracefully).
 *
 * GET /api/monitor/stream[?project_id=]  — SSE 스트림(현재 프론트 미사용, 하위호환 유지). 이벤트:
 *   { type: 'init',     active: [...], recent: [...] }  — 연결 직후 현재 스냅샷(스코핑 적용됨)
 *   { type: 'start',    run: {...} }                     — 워커 실행 시작
 *   { type: 'end',      run: {...} }                     — 워커 실행 완료
 *   { type: 'progress', commandId, projectId, item }      — 실행 중 진행 항목(도구 호출/응답 요약)
 *   { type: 'chunk',    commandId, projectId, text }      — stderr 실시간 청크(진단용)
 *   { type: 'ping' }                                     — 15초 하트비트
 *
 * GET /api/monitor/active[?project_id=]  — JSON 현재 상태 스냅샷(execMonitor 싱글턴 기준, 현재
 *   프론트 미사용 — 목록/상태는 /api/commands 로 이전됨). 하위호환/디버그용으로 유지.
 *
 * POST /api/monitor/ingest  — engine/safety-poll.js(별도 프로세스, HTTP 미사용 자율 실행경로)가
 *   자기 진행 이벤트를 execMonitor 싱글턴에 채워 넣기 위해 호출하는 로컬 전용 엔드포인트.
 *   바디: { type: 'start'|'chunk'|'progress'|'end', commandId, ...payload }
 *
 * GET /api/monitor/log/:commandId[?since=]  — 선택한 1건의 진행/stderr 로그 델타 폴링(라이브
 *   테일). 프론트(activities.vue/projects/[id].vue)가 목록의 각 active run에 대해 계속 호출.
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

// POST /api/monitor/ingest — engine(별도 프로세스)이 fire-and-forget 으로 보내는 진행 이벤트를
//   execMonitor 싱글턴에 반영한다. 같은 맥미니의 엔진 프로세스에서만 호출되므로 checkAuth 의
//   "로컬 요청은 통과" 경로가 그대로 맞는다.
router.post('/ingest', async (c) => {
  if (!(await checkAuth(c))) return unauthorized(c)
  const body = await c.req.json().catch(() => null)
  if (!body || !body.type || !body.commandId) return c.json({ error: 'type, commandId required' }, 400)
  const { type, commandId, ...payload } = body

  if (type === 'start') {
    execMonitor.start(commandId, {
      projectId: payload.projectId,
      projectName: payload.projectName,
      instruction: payload.instruction,
      taskType: payload.taskType,
    })
  } else if (type === 'chunk') {
    execMonitor.chunk(commandId, payload.text)
  } else if (type === 'progress') {
    execMonitor.progress(commandId, payload.item)
  } else if (type === 'end') {
    execMonitor.end(commandId, payload.status, { costUsd: payload.costUsd })
  } else {
    return c.json({ error: `unknown type: ${type}` }, 400)
  }

  return c.json({ ok: true })
})

// GET /api/monitor/log/:commandId?since=<index>
// since: 마지막으로 받은 total 값 (= entries 배열 길이). 0이면 전체.
// 응답: { commandId, entries: [...], total: N, status: 'running'|'done' }
router.get('/log/:commandId', async (c) => {
  if (!(await checkAuth(c))) return unauthorized(c)
  const commandId = c.req.param('commandId')
  const since = parseInt(new URL(c.req.url).searchParams.get('since') || '0', 10)
  const result = execMonitor.getLog(commandId, isNaN(since) ? 0 : since)
  if (!result) return c.json({ error: 'not found' }, 404)
  return c.json({ commandId, ...result })
})

export default router
