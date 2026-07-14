/**
 * exec-monitor.js — 실행 중인 AI 워커 상태를 메모리에서 추적하고 SSE 구독자에게 팬아웃한다.
 *
 * dispatch-worker.js(서버 프로세스 직접 실행 경로)가 이 싱글턴에 이벤트를 emit 하고,
 * /api/monitor/stream SSE 클라이언트가 구독한다. DB 저장 없음 — 재시작 시 초기화.
 *
 * engine/safety-poll.js(별도 프로세스, HTTP 미사용 자율 실행경로)는 별도 모듈 인스턴스라 이
 * 싱글턴을 직접 공유할 수 없다 — 대신 POST /api/monitor/ingest(server/api/monitor.js)로
 * fire-and-forget HTTP 이벤트를 보내 이 싱글턴을 간접적으로 채운다(2026-07-13).
 */
import { EventEmitter } from 'node:events'

const MAX_RECENT = 30
const MAX_EVENTS_PER_RUN = 50 // 진행 로그 백로그(늦게 구독한 SSE 클라이언트가 따라잡을 분량)
const GC_TTL_MS = 10 * 60 * 1000   // 완료 후 10분 뒤 GC
const MAX_LOG_PER_RUN = 2000        // 세션당 최대 로그 항목

class ExecMonitor extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(200)
    this.active = new Map()   // commandId → run
    this.recent = []          // 최근 완료 (max MAX_RECENT)
    this.logs = new Map()     // commandId → { entries: [], gcAt: null }
    setInterval(() => this.gc(), 60 * 1000).unref()
  }

  start(commandId, meta) {
    const run = {
      id: commandId,
      projectId: meta.projectId || null,
      projectName: meta.projectName || '?',
      instruction: meta.instruction || '',
      taskType: meta.taskType || 'direct',
      startedAt: Date.now(),
      events: [],
    }
    this.active.set(commandId, run)
    this.logs.set(commandId, { entries: [], gcAt: null })
    this.emit('exec', { type: 'start', run })
  }

  chunk(commandId, text) {
    if (!text || !text.trim()) return
    const run = this.active.get(commandId)
    this.emit('exec', { type: 'chunk', commandId, projectId: run?.projectId || null, projectName: run?.projectName || null, text })
    const logBuf = this.logs.get(commandId)
    if (logBuf) {
      logBuf.entries.push({ kind: 'stderr', text, ts: Date.now() })
      if (logBuf.entries.length > MAX_LOG_PER_RUN) logBuf.entries.shift()
    }
  }

  // progress — stream-json 을 요약한 진행 항목 1건(worker-exec.js summarizeStreamEvent 결과) 팬아웃.
  //   item.streaming && item.blockId 가 직전 항목과 같은 blockId 면(토큰 델타 연속 도착) 새 줄을
  //   추가하지 않고 마지막 항목을 갱신한다 — 타이핑되듯 자라는 텍스트를 로그 폭주 없이 표현.
  progress(commandId, item) {
    const run = this.active.get(commandId)
    if (!run) return
    const entry = { ...item, ts: Date.now() }
    const last = run.events[run.events.length - 1]
    const replace = !!(entry.streaming && last && entry.blockId != null && last.blockId === entry.blockId)
    if (replace) {
      run.events[run.events.length - 1] = entry
    } else {
      run.events.push(entry)
      if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift()
    }
    const logBuf = this.logs.get(commandId)
    if (logBuf) {
      logBuf.entries.push(entry)
      if (logBuf.entries.length > MAX_LOG_PER_RUN) logBuf.entries.shift()
    }
    this.emit('exec', { type: 'progress', commandId, projectId: run.projectId, projectName: run.projectName, item: entry, replace })
  }

  end(commandId, status, meta = {}) {
    const run = this.active.get(commandId)
    if (!run) return
    const completed = {
      ...run,
      status,
      endedAt: Date.now(),
      durationMs: Date.now() - run.startedAt,
      costUsd: meta.costUsd ?? null,
    }
    this.active.delete(commandId)
    this.recent.unshift(completed)
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT
    const logBuf = this.logs.get(commandId)
    if (logBuf) logBuf.gcAt = Date.now() + GC_TTL_MS
    this.emit('exec', { type: 'end', run: completed })
  }

  // getLog(commandId, since) — delta 폴링용 로그 조회.
  //   since: 마지막으로 받은 total 값(= entries 배열 길이). 0이면 전체.
  //   반환: { entries, total, status } | null (commandId 미등록)
  getLog(commandId, since = 0) {
    const logBuf = this.logs.get(commandId)
    if (!logBuf) return null
    const s = Math.max(0, since)
    return {
      entries: logBuf.entries.slice(s),
      total: logBuf.entries.length,
      status: this.active.has(commandId)
        ? 'running'
        : (this.recent.find(r => r.id === commandId)?.status ?? 'done'),
    }
  }

  // gc() — gcAt 가 지난 로그 버퍼를 정리한다. 1분 인터벌로 자동 호출.
  gc() {
    const now = Date.now()
    for (const [id, logBuf] of this.logs) {
      if (logBuf.gcAt && logBuf.gcAt < now) this.logs.delete(id)
    }
  }

  // snapshot(projectId) — projectId 주면 그 프로젝트로 스코핑(프로젝트 상세 페이지 탭용), 생략하면 전역.
  snapshot(projectId = null) {
    const active = Array.from(this.active.values())
    const recent = this.recent
    if (!projectId) {
      return { active, recent: recent.slice(0, 20) }
    }
    return {
      active: active.filter((r) => r.projectId === projectId),
      recent: recent.filter((r) => r.projectId === projectId).slice(0, 20),
    }
  }
}

export const execMonitor = new ExecMonitor()
