/**
 * engine/safety-poll.js — bin/lib/poll-commands.js 의 DB-direct 재작성(Phase 2).
 *
 * docs/design/engine-webapp-separation.md §5 Phase 2 / §2(C7·C8)의 핵심: poll-commands.js 가
 * HTTP(`POST /api/commands/claim`, `PATCH /api/commands/:id`, `POST /api/lead/cycle-result`,
 * `POST /api/lead/command-failed`)로 "빌려 쓰던" 판단을, 엔진 프로세스 안에서 **DB 직접 호출**로
 * 재현한다. 로직 자체(claim→running→spawn claude→결과 반영→ingest 분기)는 poll-commands.js 와
 * 100% 동형이다 — 통신 수단만 HTTP → 함수 호출로 바뀐다.
 *
 * 재사용(복제 금지):
 *  - claim/결과반영: server/dao/commands.js 의 CommandsDao(claim()/updateStatus() — 원자적
 *    조건부 UPDATE 그대로).
 *  - claude 실행: server/lib/worker-exec.js 의 runClaude/parseClaudeJson/truncate/truncateForTask.
 *  - 실행 파라미터 산정(claim 라우트가 응답에 실어보내던 것과 동일한 계산): resolveMaxTurns/
 *    resolveAllowedTools/resolveSandboxProfile/resolveInteractive(server/lib/tool-profiles.js),
 *    buildResumePrompt(server/lib/resume-loop.js).
 *  - ingest: exitCode===0 && task_type==='project_cycle' → ingestCycleResultTx(cycle-ingest.js).
 *            exitCode!==0 → ingestCommandFailureTx(worker-ingest.js). 그 외는 표준 결과 반영만으로 완결.
 *  - checkExecGuard(workspace-guard.js): bin/lib/poll-commands.js 가 이미 DEV MODE 로 주석 처리한
 *    상태 그대로 이식(별도 판단 없이 기존 관례 유지).
 *
 * 로깅은 poll-commands.log 가 아니라 logs/engine.log 로 분리한다(엔진과 안전망 프로세스를 구분해
 * 추적하기 쉽게 — 같은 파일을 두 프로세스가 동시에 append 하는 것 자체는 OS 레벨로 안전하지만,
 * 굳이 섞을 이유가 없다).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import CommandsDao from '../server/dao/commands.js'
import ProjectsDao from '../server/dao/projects.js'
import { runClaude, parseClaudeJson, truncate, truncateForTask, RESULT_MAX_CHARS } from '../server/lib/worker-exec.js'
// eslint-disable-next-line no-unused-vars -- DEV MODE: bin/lib/poll-commands.js 와 동일하게 게이트 자체는 주석 처리(§ 아래 참조), import 만 유지.
import { checkExecGuard } from '../server/lib/workspace-guard.js'
import { resolveInteractive, resolveMaxTurns, resolveAllowedTools, resolveSandboxProfile } from '../server/lib/tool-profiles.js'
import { buildResumePrompt } from '../server/lib/resume-loop.js'
import { ingestCycleResultTx, } from '../server/lib/cycle-ingest.js'
import { ingestCommandFailureTx, extractEmbeddedJson } from '../server/lib/worker-ingest.js'
import { logActivity } from '../server/lib/activity-log.js'
import { sendApprovalNotification } from '../server/lib/push-notifier.js'
import { maybeRequeuePhase } from '../server/lib/phase-chain.js'
import { dispatchApprovedCommand } from '../server/lib/dispatch-worker.js'
import { ROOT } from './db.js'

const HOST = process.env.MALGNAI_HOST || os.hostname()
const SERVER_URL = process.env.MALGNAI_SERVER_URL || 'http://localhost:9000'

const LOG_DIR = join(ROOT, 'logs')
const LOG_FILE = join(LOG_DIR, 'engine.log')

// postMonitorEvent — 실시간 실행 모니터(server/lib/exec-monitor.js)는 서버 프로세스 안의 인메모리
//   싱글턴이라 별도 프로세스인 엔진에서 직접 채울 수 없다. 대신 서버의 POST /api/monitor/ingest 로
//   fire-and-forget 전송해 대신 채워달라고 부탁한다. 모니터링은 best-effort 부가기능이지 핵심 실행
//   경로가 아니므로, 서버가 죽어있거나 응답이 늦어도 엔진 틱을 절대 블로킹·실패시키지 않는다 — 실패는
//   여기서 삼킨다(호출부에서 await 하더라도 절대 throw 하지 않음).
//
// (2026-07-14 버그수정) 반환값을 반드시 fetch Promise 로 돌려준다 — engine/run.js 의 main() 은
//   틱이 끝나자마자 `process.exit(0)` 을 호출한다(§ 파일 상단 JSDoc). 이 fetch 를 아무도 기다리지
//   않으면(구버전처럼 그냥 fire-and-forget), 'end' 이벤트 발송 이후 남은 작업(dao.updateStatus 등)이
//   better-sqlite3 동기 호출이라 마이크로태스크 수준으로 즉시 끝나버려 macrotask(TCP round-trip)인 이
//   fetch 보다 먼저 process.exit() 이 실행되는 경우가 실측됐다 — 'end' 요청이 서버에 도달하기 전에
//   프로세스가 죽어 exec-monitor.js 의 active Map 에서 해당 run 이 영원히 안 지워지고(§gc() 는 완료된
//   run 의 로그버퍼만 TTL 청소, active 자체는 end() 호출로만 빠짐) "완료된 지 몇 시간 지난 작업이 계속
//   진행 중으로 표시" 되는 버그의 근본원인이었다. state-transition 이벤트(start/end)만 아래에서
//   await 해 서버 도달을 보장한다(chunk/progress 는 유실돼도 무해하므로 여전히 fire-and-forget).
function postMonitorEvent(type, commandId, payload = {}) {
  return fetch(`${SERVER_URL}/api/monitor/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, commandId, ...payload }),
  }).catch(() => { /* best-effort — 모니터링 실패는 실행 결과에 영향 없음 */ })
}

export function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: 'safety-poll', ...obj })
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 로깅 실패는 무시 */ }
  console.log('[engine:safety-poll]', line)
}

// project_cycle 출력이 WORKER/CYCLE JSON 으로 파싱 안 될 때의 최소 적재. server/api/lead.js 의
// recordCycleParseFailure, server/lib/dispatch-worker.js 의 recordCycleParseFailureTx 와 동형
// (HTTP 라운드트립이 없는 이 경로 전용 로컬 재구현 — 세 곳 모두 같은 짧은 패턴).
function recordCycleParseFailureTx(db, command, errorCode, rawStdout) {
  try {
    db.transaction((tx) => {
      const now = new Date().toISOString()
      tx.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'ISSUE', ?, ?, 4, 'system', ?)`
      ).bind(crypto.randomUUID(), command.project_id,
        '프로젝트 사이클 출력 파싱 실패', `errorCode=${errorCode}${rawStdout ? '\n' + String(rawStdout).slice(0, 2000) : ''}`, now).run()
      logActivity(tx, { project_id: command.project_id, command_id: command.id, agent_name: 'system', action: 'cycle_parse_fail', detail: `errorCode=${errorCode}`, created_at: now })
    })
  } catch { /* 실패 기록 자체 실패는 치명 아님(best-effort) */ }
}

/**
 * safetyPollOnce — 큐 1건 claim→실행→결과반영(DB 직접). engine/run.js 가 매 틱 두 번째 단계로 호출한다.
 * @param {object} db  D1 호환 어댑터(better-sqlite3 wrap 또는 테스트용 인메모리).
 * @returns {Promise<{outcome:'idle'}|{outcome:'processed', commandId:string, status:string}>}
 */
export async function safetyPollOnce(db) {
  const dao = new CommandsDao(db)
  const projectsDao = new ProjectsDao(db)

  // 1) claim — CommandsDao.claim()이 이미 원자적 조건부 UPDATE(status='approved'만 대상, §3-3).
  const command = await dao.claim({ host: HOST })
  if (!command) {
    logLine({ event: 'idle', host: HOST, message: 'no command to process' })
    return { outcome: 'idle' }
  }

  const commandId = command.id
  const started = Date.now()

  // 2) project.path — HTTP claim 라우트가 응답에 실어 보내던 것을 여기선 직접 조회.
  const project = command.project_id ? await projectsDao.findById(command.project_id) : null
  const projectPath = project?.path || null

  // 2.5) (2026-07-13, 실측 사고 발견 후 신설) project 가 없으면(project_id 가 가리키는 row 가 삭제됨
  //   등) 절대 실행하지 않는다 — dispatch-worker.js:84-88 의 동일 가드를 이식. projectPath=null 을
  //   그대로 runClaude 에 넘기면 child_process.spawn 의 cwd:null 은 "부모(엔진) 프로세스의 cwd 를
  //   상속"으로 해석돼, 엔진 LaunchAgent 의 WorkingDirectory(=malgnai 저장소 루트) 안에서 claude 가
  //   실행되는 사고가 실제로 발생했다(commands.project_id 는 FK CASCADE 가 의도적으로 비활성화돼
  //   있어 — issue `884f02bf` — 프로젝트 삭제 후에도 orphan approved command 가 남을 수 있음).
  if (!project || !project.path) {
    await dao.updateStatus(commandId, { status: 'failed', error: 'safety-poll: project not found or missing path' })
    logLine({ event: 'rejected', command_id: commandId, reason: 'project not found or missing path' })
    return { outcome: 'processed', commandId, status: 'failed' }
  }

  // 3) 보안 게이트(공용 checkExecGuard) — bin/lib/poll-commands.js 가 이미 DEV MODE 로 비활성화한
  //    상태 그대로 이식(별도 판단 없이 기존 관례 유지).
  // const guard = checkExecGuard(command, projectPath)
  // if (!guard.ok) {
  //   await dao.updateStatus(commandId, { status: 'rejected', error: guard.error })
  //   logLine({ event: 'rejected', command_id: commandId, project: projectPath, reason: guard.error })
  //   return { outcome: 'processed', commandId, status: 'rejected' }
  // }

  // 4) running
  await dao.updateStatus(commandId, { status: 'running' })

  // 5) 실행 파라미터 산정 — server/api/commands.js POST /claim 이 응답에 계산해 싣던 것과 동일 계산.
  const maxTurns = await resolveMaxTurns(db, command)
  const allowedTools = resolveAllowedTools(command.task_type)
  const sandboxProfile = resolveSandboxProfile(command.task_type)
  const resumeSessionId = (command.task_type === 'resume' || command.task_type === 'console') && command.session_id
    ? command.session_id : null
  const resumePrompt = command.task_type === 'resume' ? buildResumePrompt(command.review_note) : null
  const promptText = resumePrompt || command.instruction
  const interactive = resolveInteractive(command.task_type)

  // await: 'start' 가 서버에 먼저 도착해야 나중에 보내는 'end' 가 먼저 도착해 무시되는(§exec-monitor.js
  //   end() 는 active 에 run 이 없으면 no-op) 순서역전을 막는다 — 특히 runClaude 가 즉시 spawn 실패로
  //   끝나는(§153) 경로처럼 start~end 간격이 짧을 때 중요.
  await postMonitorEvent('start', commandId, {
    projectId: project.id,
    projectName: project.name || project.path?.split('/').pop() || '?',
    instruction: (promptText || '').slice(0, 200),
    taskType: command.task_type || 'direct',
  })

  const { exitCode, stdout, stderr, spawnError } = await runClaude(
    promptText, projectPath, maxTurns, allowedTools, sandboxProfile, resumeSessionId,
    (chunk) => postMonitorEvent('chunk', commandId, { text: chunk }),
    (item) => postMonitorEvent('progress', commandId, { item }),
    interactive
  )
  const parsed = parseClaudeJson(stdout)
  const duration = ((Date.now() - started) / 1000).toFixed(1)

  // 6~7) 결과 반영(DAO 직접 — HTTP PATCH 대체).
  const finalStatus = exitCode === 0 ? 'done' : 'failed'
  const errorMsg = spawnError
    ? `spawn error: ${spawnError}`
    : (exitCode !== 0 ? truncate(parsed.cliError || parsed.parseError || stderr || 'non-zero exit', 2000) : (parsed.parseError ? truncate(parsed.parseError, 2000) : null))

  // await 필수(위 postMonitorEvent JSDoc 참조) — 이걸 안 기다리면 engine/run.js 의 process.exit(0)
  //   이 이 fetch 보다 먼저 실행돼 'end' 가 서버에 도달하기 전에 프로세스가 죽을 수 있다.
  await postMonitorEvent('end', commandId, { status: finalStatus, costUsd: parsed.cost_usd })

  await dao.updateStatus(commandId, {
    status: finalStatus,
    exit_code: exitCode,
    result: truncateForTask(parsed.result, command.task_type, RESULT_MAX_CHARS),
    cost_usd: parsed.cost_usd,
    session_id: parsed.session_id,
    error: errorMsg,
  })

  // 8) exit 0 이면 결과를 서버 파서 함수로 직접 분기(HTTP POST 대신 ingestCycleResultTx 직접 호출).
  //    exitCode≠0 이면 ingestCommandFailureTx 직접 호출.
  let ingest = null
  if (exitCode === 0) {
    if (command.task_type === 'project_cycle') {
      const extracted = extractEmbeddedJson(parsed.result ?? stdout)
      if (extracted.ok) {
        try {
          const report = db.transaction((tx) => ingestCycleResultTx(tx, command, extracted.value))
          ingest = { kind: 'cycle', report }
          // (신규) proposal 이 승인함(queued)에 등록됐으면(=사람 승인이 실제로 필요한 건만) 진동 포함
          //   푸시 알림을 발송한다. tx 는 이미 끝났으므로 tx 밖 fire-and-forget. 'approved'(자동집행)는
          //   승인 요청이 아니므로 알림 대상에서 제외.
          if (report.proposal_created && report.proposal_status === 'queued' && project?.owner_user_id) {
            const p = extracted.value?.proposal || {}
            const title = p.task_type || truncate(p.instruction || '', 40) || '새 명령'
            sendApprovalNotification(db, project.owner_user_id, {
              id: report.proposal_command_id, title, status: 'queued',
            }).catch((e) => logLine({ event: 'push_notify_error', command_id: commandId, error: e.message }))
          }
        } catch (e) {
          ingest = { kind: 'cycle', error: e.message }
          logLine({ event: 'ingest_failed', command_id: commandId, error: e.message })
        }
      } else {
        recordCycleParseFailureTx(db, command, extracted.error, stdout)
        ingest = { kind: 'cycle', error: extracted.error }
      }
    }
  } else {
    try {
      const report = db.transaction((tx) => ingestCommandFailureTx(tx, command, errorMsg))
      ingest = { kind: 'failure', report }
    } catch (e) {
      ingest = { kind: 'failure', error: e.message }
      logLine({ event: 'ingest_failed', command_id: commandId, error: e.message })
    }
  }

  // 8.5) (단계 자동 이어달리기, 2026-07-13 신설) 승인/직접명령 실행이 이제 이 엔진 안전망 경로로만
  //   도는 이상, phase-chain 후속 단계도 여기서 판단해야 한다(이전엔 웹서버 dispatch-worker.js 에서만
  //   체크됐음 — 승인 즉시디스패치 제거로 그 경로가 approve 류에 대해선 더 이상 안 돎). project_cycle/
  //   resume/console 은 maybeRequeuePhase 내부에서 자동 no-op. dispatchApprovedCommand 의 재귀
  //   phase-chain 호출도 이제 await 이므로(위 import, dispatch-worker.js 참고), 여기서 await 하면
  //   MAX_PHASE_ROUNDS 까지의 전체 체인이 끝난 뒤에야 이 틱이 종료된다(engine/run.js 의
  //   process.exit(0) 이 중간 단계를 자르지 않도록).
  if (exitCode === 0) {
    const pc = maybeRequeuePhase(db, command, parsed.result)
    if (pc.requeued) {
      logLine({ event: 'phase_chain_create', command_id: commandId, next_command_id: pc.newId, claimed: pc.claimed })
      if (pc.claimed) {
        await dispatchApprovedCommand(db, pc.newId).catch((e) =>
          logLine({ event: 'phase_chain_dispatch_error', command_id: pc.newId, error: e.message }))
      }
    } else if (pc.reason) {
      logLine({ event: 'phase_chain_skip', command_id: commandId, reason: pc.reason })
    }
  }

  // 9) 구조화 로그 1줄
  logLine({
    event: 'processed',
    command_id: commandId,
    project: projectPath,
    status: finalStatus,
    exit_code: exitCode,
    cost: parsed.cost_usd,
    duration: Number(duration),
    task_type: command.task_type || null,
    ingest,
  })

  return { outcome: 'processed', commandId, status: finalStatus }
}
