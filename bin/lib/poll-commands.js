/**
 * poll-commands.js — 로컬 폴링 워커 로직 (웹→로컬 명령 실행 파이프라인)
 *
 * 흐름(1회 실행 = 1건만 직렬 처리):
 *   1) POST /api/commands/claim {host}  (X-API-Key) → 204면 처리할 것 없음(종료).
 *   2) claim 응답의 command.project_path 사용([H-001] 무인증 projects 조회 제거).
 *   3) 보안 게이트: project_path 가 WORKSPACE_ROOT 하위인지 prefix 검증. 벗어나면 rejected.
 *   4) PATCH status='running'.
 *   5) child_process.spawn('claude', [...], {cwd: project.path}) — 도구 화이트리스트.
 *   6) 종료코드 + stdout(json) 수집.
 *   7) PATCH status= exit_code===0?'done':'failed' (+exit_code/result/cost/session).
 *   8) 결과 PATCH 전송 실패 시 logs/poll-commands.log 에 기록.
 *
 * bin/loop.js 가 매 틱 두 번째 단계로 import 하고, bin/poll-commands.js 가 수동 디버깅용
 *   CLI 래퍼로 import 한다.
 *
 * ⚠️ 실행 인프라 재설계(docs/design/execution-infra-redesign.md §2, v3 최종) 이후 역할 변화:
 *   이전에는 이 pollOnce() 가 "유일한 실행 경로"였다. 이제는 사람 즉시스폰(§2.4, PATCH .../review
 *   approve 직후 server/lib/dispatch-worker.js 가 바로 실행) 과 spawn-due 즉시디스패치(§2.7,
 *   POST /api/lead/spawn-due 가 스폰 직후 바로 실행) 두 경로가 커맨드 대부분을 즉시 처리하므로,
 *   pollOnce 는 그 두 경로가 레이스에서 지거나(claim 실패) 실패/누락한 것만 걷어가는 **공용
 *   안전망**으로 역할이 바뀌었다. claude 프로세스 실행 로직 자체(runClaude 등)는
 *   server/lib/worker-exec.js 로 분리되어 이 두 경로와 100% 공유된다(보안경계 동일).
 *
 * 환경 변수:
 *   MALGNAI_SERVER_URL      기본 http://localhost:9000
 *   MALGNAI_API_KEY         인입 인증 키 (claim/patch X-API-Key)
 *   MALGNAI_HOST            대상 PC 식별자 (기본 os.hostname())
 *   MALGNAI_WORKSPACE_ROOT  허용 워크스페이스 루트 (기본 ~/workspace, OS 무관)
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import { resolveApiKey } from './load-api-key.js'
import { runClaude, parseClaudeJson, truncate } from '../../server/lib/worker-exec.js'
import { checkExecGuard } from '../../server/lib/workspace-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BIN_DIR = join(__dirname, '..')

const SERVER_URL = (process.env.MALGNAI_SERVER_URL || 'http://localhost:9000').replace(/\/+$/, '')
// [M-3] env 미주입 시 .dev.vars 단일 소스에서 키 확보(별도 설정 복제 없이 배선).
// 주의: 이 값은 apiHeaders() 에만 쓰고, spawn 자식에는 scrubbedEnv 로 계속 제거한다(worker-exec.js).
const API_KEY = resolveApiKey()
const HOST = process.env.MALGNAI_HOST || os.hostname()

// v3(대표 결정 2026-07-03): 도구 화이트리스트 폐지, 커널 sandbox(worker.sb)가 유일 경계.
//   claim 응답의 allowed_tools 가 null(신 배포 기본값)이면 --permission-mode bypassPermissions 로
//   전권 실행한다. 배열이 오면(향후 특수 케이스 대비 하위호환) 그 목록으로 --allowedTools 제한 실행.
const RESULT_MAX_CHARS = 8000

const LOG_DIR = join(BIN_DIR, '..', 'logs')
const LOG_FILE = join(LOG_DIR, 'poll-commands.log')

export function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj })
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 로깅 실패는 무시 */ }
  console.log('[poll-commands]', line)
}

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-API-Key'] = API_KEY
  return h
}

async function patchCommand(id, payload) {
  const res = await fetch(`${SERVER_URL}/api/commands/${id}`, {
    method: 'PATCH',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`PATCH /api/commands/${id} → ${res.status}`)
  }
  return res
}

// exit 0 후 WORKER/CYCLE 결과를 서버 파서로 전달(DB 쓰기/게이트는 서버 한 곳에만).
// poll 은 stdout 만 들고 POST 하고, 파싱·게이트·INSERT 는 전부 서버 트랜잭션에서 한다.
//
// ⚠️ 실행 인프라 재설계(execution-infra-redesign.md §1.4, v3 최종): POST /api/lead/worker-result
//   경로(postWorkerResult)는 폐지됐다 — commands.task_id 를 채우는 코드가 전무해져(상시 lead task
//   앵커·proposal INSERT 둘 다 §1.4 로 제거) 이 경로가 재현 불가능한 죽은 코드가 됐기 때문이다.
//   일반 커맨드("작업 카드"/"로컬에 직접 명령"/워커 proposal)는 아래 표준 PATCH(6~7단계, status/
//   exit_code/result/cost_usd/session_id/error)만으로 완결된다 — 추가 ingest 가 필요 없다.
// 분산 전환(설계 §2.10): project_cycle 워커 결과를 얇은 적재 라우트로 전달(배분 아님, summary+proposal만).
async function postCycleResult(commandId, stdout) {
  return fetch(`${SERVER_URL}/api/lead/cycle-result`, {
    method: 'POST', headers: apiHeaders(),
    body: JSON.stringify({ command_id: commandId, stdout }),
  })
}
// exitCode≠0(claude 프로세스 자체 실패) 전용: activity_log 기록 + task 종료 처리만(worker/cycle 결과 파싱 대상 없음).
async function postCommandFailed(commandId, error) {
  return fetch(`${SERVER_URL}/api/lead/command-failed`, {
    method: 'POST', headers: apiHeaders(),
    body: JSON.stringify({ command_id: commandId, error }),
  })
}

// PATCH 전송 실패 시 최소한 로컬 로그에 결과를 보존(부분 실패 대비).
async function patchCommandSafe(id, payload) {
  try {
    await patchCommand(id, payload)
    return true
  } catch (err) {
    logLine({ event: 'patch_failed', command_id: id, payload, error: err.message })
    return false
  }
}

/** pollOnce — 큐 1건 claim→실행→결과보고. bin/loop.js 와 bin/poll-commands.js(CLI 래퍼)가 import 한다. */
export async function pollOnce() {
  if (!API_KEY) {
    logLine({ event: 'warn', message: 'MALGNAI_API_KEY 미설정 — 인증 없이 진행(로컬 개발 가정)' })
  }

  // 1) claim
  let claimRes
  try {
    claimRes = await fetch(`${SERVER_URL}/api/commands/claim`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ host: HOST }),
    })
  } catch (err) {
    logLine({ event: 'claim_failed', error: err.message })
    process.exit(1)
  }

  if (claimRes.status === 204) {
    logLine({ event: 'idle', host: HOST, message: 'no command to process' })
    return
  }
  if (!claimRes.ok) {
    logLine({ event: 'claim_failed', status: claimRes.status })
    process.exit(1)
  }

  const { command } = await claimRes.json()
  const commandId = command.id
  const started = Date.now()

  // 2) project.path — claim 응답에 포함됨([H-001] 무인증 projects 조회 제거).
  const projectPath = command.project_path

  // 3) 보안 게이트(공용 checkExecGuard — 즉시디스패치와 단일 소스, reviewer MAJOR-2/R-2):
  //    ① permission_mode='bypass' 거부 ② project.path 워크스페이스 화이트리스트.
  const guard = checkExecGuard(command, projectPath)
  if (!guard.ok) {
    await patchCommandSafe(commandId, { status: 'rejected', error: guard.error })
    logLine({ event: 'rejected', command_id: commandId, project: projectPath, reason: guard.error })
    return
  }

  // 4) running
  await patchCommandSafe(commandId, { status: 'running' })

  // 5) spawn claude (M-2: claim 응답의 max_turns 를 --max-turns 로 강제 전달)
  //    v3: claim 응답의 allowed_tools 는 항상 null → bypassPermissions 전권 실행 + sandbox_profile 로 격리.
  //    (§9) resume_session_id 가 오면 claude --resume 로 같은 세션을 이어받고 -p 는 resume_prompt(대표 답변).
  const promptText = command.resume_session_id ? command.resume_prompt : command.instruction
  const { exitCode, stdout, stderr, spawnError, sandboxed } = await runClaude(
    promptText, projectPath, command.max_turns, command.allowed_tools, command.sandbox_profile, command.resume_session_id
  )
  const parsed = parseClaudeJson(stdout)
  const duration = ((Date.now() - started) / 1000).toFixed(1)

  // 6~7) 결과 보고
  const finalStatus = exitCode === 0 ? 'done' : 'failed'
  // 우선순위: spawn 자체 실패 > claude stdout JSON 의 구조화 에러(예: max-turns 초과) > stderr 원문.
  //   stdout 이 있을 땐 stderr 는 보통 stdin-warning 같은 잡음뿐이라 cliError 가 훨씬 진단력이 높다.
  const errorMsg = spawnError
    ? `spawn error: ${spawnError}`
    : (exitCode !== 0 ? truncate(parsed.cliError || stderr || 'non-zero exit', 2000) : null)

  await patchCommandSafe(commandId, {
    status: finalStatus,
    exit_code: exitCode,
    result: truncate(parsed.result, RESULT_MAX_CHARS),
    cost_usd: parsed.cost_usd,
    session_id: parsed.session_id,
    error: errorMsg,
  })

  // 8) exit 0 이면 결과를 서버 파서로 분기 전달(distributed 단일 경로).
  //    DB 쓰기/게이트는 서버가 한다(poll 은 stdout 만 던진다). 분기 근거는 claim 응답의 task_type.
  //    project_cycle 만 추가 ingest 대상(summary→memories + proposal→승인함). 그 외 일반 커맨드
  //    ("작업 카드"/"로컬에 직접 명령"/워커 proposal, §1.4 v3 최종으로 worker-result 경로 폐지)는
  //    위 표준 PATCH(6~7단계)만으로 완결 — 추가 ingest 호출이 필요 없다.
  //    exit 0 이 아니면(claude 프로세스 자체 실패) worker/cycle JSON 파싱 대상이 없으므로, 대신
  //    command-failed 로 최소 적재(activity_log 기록 + task 종료 처리)만 한다 — 실패가 조용히
  //    사라져 activity_log·task 상태에 전혀 안 남던 갭(issue b620bf1a)의 수정.
  let ingest = null
  if (exitCode === 0) {
    try {
      if (command.task_type === 'project_cycle') {
        const res = await postCycleResult(commandId, parsed.result ?? stdout)
        const data = await res.json().catch(() => ({}))
        ingest = { kind: 'cycle', status: res.status, report: data.report || data.error || null }
      }
    } catch (err) {
      ingest = { kind: 'cycle', error: err.message }
      logLine({ event: 'ingest_failed', command_id: commandId, error: err.message })
    }
  } else {
    try {
      const res = await postCommandFailed(commandId, errorMsg)
      const data = await res.json().catch(() => ({}))
      ingest = { kind: 'failure', status: res.status, report: data.report || data.error || null }
    } catch (err) {
      ingest = { kind: 'failure', error: err.message }
      logLine({ event: 'ingest_failed', command_id: commandId, error: err.message })
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
    // v3 관측성: 도구 화이트리스트 폐지 이후엔 permission_mode_flag 가 실제 경계 근거(sandbox 여부와 합해서 판단).
    allowed_tools: command.allowed_tools || null,
    permission_mode_flag: Array.isArray(command.allowed_tools) && command.allowed_tools.length ? 'default' : 'bypassPermissions',
    // PoC v2 관측성(S5/S7): 이 워커가 실제로 커널 sandbox 로 감싸졌는지 + 요청 프로파일.
    sandbox_profile: command.sandbox_profile || null,
    sandboxed: !!sandboxed,
    setting_sources: 'inherited', // v2.2: 전역 CLAUDE.md·에이전트 상속(격리 안 함)
    ingest,
  })
}
