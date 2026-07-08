/**
 * dispatch-worker.js — 서버 프로세스 직접 디스패치(설계 §2.3, v3 최종).
 *
 * dispatchApprovedCommand(db, commandId): HTTP 자기호출 없이 서버 프로세스 안에서 직접
 *   command 를 실행한다. 두 즉시디스패치 경로가 이 함수 하나를 공유한다:
 *   - §2.4 사람 즉시스폰: PATCH /api/commands/:id/review 가 approve 시 타겟claim 성공 직후 호출.
 *   - §2.7 spawn-due 즉시디스패치: POST /api/lead/spawn-due 가 project_cycle 스폰 직후 호출.
 *
 * 호출부는 항상 fire-and-forget(await 하지 않음) — 이 함수는 그래서 **절대 throw 하지 않는다**
 *   (전체를 try/catch 로 감싸 uncaught rejection 을 방지, 실패는 logActivity 로만 감사).
 *
 * ⚠️ poll 과의 레이스 차단(§2.5 의 "레이스" 절과 §2.7 의 프로젝트당 락 논증을 코드로 보강):
 *   §2.4 경로는 호출 전 instant-dispatch.js 의 타겟 claim 으로 이미 status='claimed' 다.
 *   §2.7 경로(spawnOneCycle)는 command 를 status='queued' 로 INSERT 한 직후 곧바로 이 함수를
 *   부르므로, 이 함수 시작 시점에 즉시 status='running' 으로 전이하지 않으면 바로 다음 pollOnce()
 *   틱의 claim()(status IN ('queued','approved') 대상)이 같은 row 를 집어가 동일 instruction 을
 *   중복 실행할 수 있다. 그래서 runClaude 호출 전에 무조건 한 번 'running' 으로 전이한다
 *   (§2.4 경로에서는 claimed→running 한 단계 더 진행하는 것뿐이라 무해하고, §2.7 경로에서는 이
 *   전이가 poll 재claim 을 막는 유일한 방벽이다 — 문서 §2.3 의 축약 의사코드에는 명시되지 않았지만
 *   poll 을 "안전망"으로 재정의한 §2.1 전제가 성립하려면 반드시 필요한 최소 보강).
 *
 *   ⚠️ **긴급 보강(reviewer 지적, High)**: 이 전이를 findById→updateStatus(읽고-쓰기, WHERE에 status
 *   가드 없음)로 구현하면 §2.7 경로에서 INSERT 직후~이 전이 사이의 틈에 poll 의 claim()이 먼저
 *   이겨도 감지를 못 하고 그냥 덮어써버려 **이중 실행**(비용 이중청구+파일 동시편집)이 날 수 있다.
 *   근본 수정은 두 겹이다: ① `spawnOneCycle`(server/api/lead.js)의 INSERT 자체를 'queued'가 아니라
 *   'claimed'(claimed_by='server-spawn-due')로 바꿔 poll의 claim()(status IN ('queued','approved')
 *   대상) 이 애초에 이 row 를 볼 수 없게 만든다(§2.4 의 reviewCommandTx 타겟claim과 동일 패턴,
 *   'queued' 노출 창 자체를 제거) ② 그래도 이 함수의 'running' 전이는 findById→updateStatus 가 아니라
 *   `CommandsDao.claimForRunning`(claim()/reviewCommandTx 와 동형인 조건부 UPDATE, WHERE status='claimed'
 *   한정)으로 수행한다 — 실패(false)는 이론상 발생하지 않아야 정상이지만(①로 창을 없앴으므로), 방어적
 *   이중 안전장치로 남겨둔다. 실패 시 조용히 스킵(에러 아님, 감사만 기록).
 */
import CommandsDao from '../dao/commands.js'
import ProjectsDao from '../dao/projects.js'
import { runClaude, parseClaudeJson, truncate, RESULT_MAX_CHARS } from './worker-exec.js'
import { resolveMaxTurns, resolveAllowedTools, resolveSandboxProfile } from './tool-profiles.js'
import { ingestCycleResultTx } from './cycle-ingest.js'
import { ingestCommandFailureTx, extractEmbeddedJson } from './worker-ingest.js'
import { checkExecGuard } from './workspace-guard.js'
import { buildResumePrompt, maybeRequeueResume } from './resume-loop.js'
import { logActivity } from './activity-log.js'

const TERMINAL_STATUSES = ['done', 'failed', 'rejected', 'expired']

function nowIso() { return new Date().toISOString() }

// project_cycle 출력이 WORKER/CYCLE JSON 으로 파싱 안 될 때의 최소 적재(server/api/lead.js 의
// recordCycleParseFailure 와 동형 — HTTP 라운드트립 없는 이 경로 전용으로 로컬 재구현).
function recordCycleParseFailureTx(db, command, errorCode, rawStdout) {
  try {
    db.transaction((tx) => {
      const now = nowIso()
      tx.prepare(
        `INSERT INTO memories (id, project_id, memory_type, title, content, importance, agent_name, created_at)
         VALUES (?, ?, 'ISSUE', ?, ?, 4, 'system', ?)`
      ).bind(crypto.randomUUID(), command.project_id,
        '프로젝트 사이클 출력 파싱 실패', `errorCode=${errorCode}${rawStdout ? '\n' + String(rawStdout).slice(0, 2000) : ''}`, now).run()
      logActivity(tx, { project_id: command.project_id, agent_name: 'system', action: 'cycle_parse_fail', detail: `errorCode=${errorCode}`, created_at: now })
    })
  } catch { /* 실패 기록 자체 실패는 치명 아님(best-effort) */ }
}

/**
 * dispatchApprovedCommand — command 1건을 서버 프로세스 안에서 직접 실행한다.
 * @param {object} db         D1 호환 db(c.env.DB).
 * @param {string} commandId  실행할 command id.
 * @returns {Promise<void>}  절대 throw 하지 않는다(호출부가 fire-and-forget 이므로).
 */
export async function dispatchApprovedCommand(db, commandId) {
  const dao = new CommandsDao(db)
  try {
    const command = await dao.findById(commandId)
    if (!command) {
      logActivity(db, { agent_name: 'system', action: 'instant_dispatch_skip', detail: `command ${commandId} not found`, created_at: nowIso() })
      return
    }
    // 멱등 방어: 이미 종료 상태면 재실행하지 않는다(중복 트리거·재시도 안전).
    if (TERMINAL_STATUSES.includes(command.status)) return

    const project = command.project_id ? await new ProjectsDao(db).findById(command.project_id) : null
    if (!project || !project.path) {
      await dao.updateStatus(commandId, { status: 'failed', error: 'dispatch: project not found or missing path' })
      logActivity(db, { project_id: command.project_id || null, agent_name: 'system', action: 'instant_dispatch_error', detail: 'project missing path', created_at: nowIso() })
      return
    }

    // (reviewer MAJOR-2) poll(안전망)과 동일한 pre-exec 보안 게이트를 즉시디스패치도 적용한다.
    //   bypass 거부 + 워크스페이스 화이트리스트. 미적용 시 idle 프로젝트로 흐른 direct/AI 명령이
    //   무검증 실행돼 두 경로의 보안 처리가 타이밍에 따라 갈리는 비대칭이 생긴다(공용 checkExecGuard).
    const guard = checkExecGuard(command, project.path)
    if (!guard.ok) {
      await dao.updateStatus(commandId, { status: 'rejected', error: guard.error })
      logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'instant_dispatch_reject', detail: guard.error, created_at: nowIso() })
      return
    }

    // poll 과의 레이스 차단(위 파일 docstring 참조) — 두 호출부(§2.4/§2.7) 모두 이 시점엔 이미
    //   status='claimed' 여야 정상(§2.4=reviewCommandTx 타겟claim, §2.7=spawnOneCycle이 INSERT부터
    //   claimed). 'claimed'에서만 전이를 허용해 poll 의 claim() 대상('queued'/'approved')과 절대
    //   겹치지 않게 한다. 실패(false)는 방어적 안전장치일 뿐 정상 경로에서는 발생하지 않아야 한다.
    const gotRunning = await dao.claimForRunning(commandId, ['claimed'])
    if (!gotRunning) {
      logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'instant_dispatch_skip', detail: `command ${commandId} not in claimed state at dispatch time (unexpected)`, created_at: nowIso() })
      return
    }

    // resolveMaxTurns 가 command.task_type 으로 판정: 사람 개입 명령은 UNLIMITED_TURNS(무제한),
    //   자율 project_cycle 만 lead agent budget 상한(폴백 8).
    const maxTurns = await resolveMaxTurns(db, command)
    const allowedTools = resolveAllowedTools(command.task_type)
    const sandboxProfile = resolveSandboxProfile(command.task_type)

    // (§9 원격 승인 재개) task_type='resume' + session_id 면 그 세션을 이어받아 대표 답변(review_note)을
    //   -p 로 흘려보낸다. buildResumePrompt 가 답변 + 다음 라운드 신호 규약(§11 후속 다중 라운드)을 함께 싣는다.
    //   그 외는 신규 세션으로 instruction 실행(기존).
    const isResume = command.task_type === 'resume' && !!command.session_id
    const promptText = isResume ? buildResumePrompt(command.review_note) : command.instruction
    const resumeSid = isResume ? command.session_id : null

    const { exitCode, stdout, stderr, spawnError } = await runClaude(
      promptText, project.path, maxTurns, allowedTools, sandboxProfile, resumeSid
    )
    const parsed = parseClaudeJson(stdout)
    // poll(bin/lib/poll-commands.js)과 동일한 에러 우선순위: spawn 자체 실패 > claude stdout JSON 의
    //   구조화 에러(예: max-turns 초과) > stderr 원문.
    const errorMsg = spawnError
      ? `spawn error: ${spawnError}`
      : (exitCode !== 0 ? truncate(parsed.cliError || stderr || 'non-zero exit', 2000) : null)

    await dao.updateStatus(commandId, {
      status: exitCode === 0 ? 'done' : 'failed',
      exit_code: exitCode,
      result: truncate(parsed.result, RESULT_MAX_CHARS),
      cost_usd: parsed.cost_usd,
      session_id: parsed.session_id,
      error: errorMsg,
    })

    // (§11 후속 다중 라운드) resume 워커가 "또 승인 필요"(NEEDS_APPROVAL: 신호)로 끝났으면 같은
    //   session_id 로 새 resume command 를 승인함에 재큐잉한다(세션당 라운드 상한 내에서). exit 0 일 때만.
    if (exitCode === 0 && isResume) {
      const rq = maybeRequeueResume(db, command, parsed.result)
      if (rq.requeued) {
        logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'resume_requeue', detail: `다음 라운드 승인 필요 → command ${rq.newId} 큐잉`, created_at: nowIso() })
      } else if (rq.reason) {
        logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'resume_requeue_skip', detail: rq.reason, created_at: nowIso() })
      }
    }

    // §2.3-5: exitCode===0 이고 task_type==='project_cycle' 이면 사이클 결과 적재.
    //   §2.4(사람 즉시스폰)에는 사실 도달 안 함(project_cycle 은 spawn-due 전용 생성물이라 승인함에
    //   안 옴) — 방어적으로만 남겨둔다. §2.7(spawn-due 즉시디스패치)에서는 이게 주 경로다.
    if (exitCode === 0 && command.task_type === 'project_cycle') {
      const extracted = extractEmbeddedJson(parsed.result ?? stdout)
      if (extracted.ok) {
        try {
          db.transaction((tx) => ingestCycleResultTx(tx, command, extracted.value))
        } catch (e) {
          logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'instant_dispatch_error', detail: `ingestCycleResultTx failed: ${e.message}`, created_at: nowIso() })
        }
      } else {
        recordCycleParseFailureTx(db, command, extracted.error, stdout)
      }
    } else if (exitCode !== 0) {
      // §2.3-5: exitCode≠0 이면 ingestCommandFailureTx(project_cycle 여부 무관 — 분기 단순화).
      try {
        db.transaction((tx) => ingestCommandFailureTx(tx, command, errorMsg))
      } catch (e) {
        logActivity(db, { project_id: command.project_id, agent_name: 'system', action: 'instant_dispatch_error', detail: `ingestCommandFailureTx failed: ${e.message}`, created_at: nowIso() })
      }
    }
  } catch (e) {
    // §2.3-6: 전체 try/catch — 실패해도 throw 하지 않고 logActivity 로만 감사.
    try {
      logActivity(db, { agent_name: 'system', action: 'instant_dispatch_error', detail: e.message, created_at: nowIso() })
    } catch { /* 감사 실패는 무시(best-effort) */ }
  }
}
