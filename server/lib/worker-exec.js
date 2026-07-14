/**
 * worker-exec.js — 공용 워커 실행 모듈: "claude 프로세스를 어떻게 실행하는가"(HTTP 무관) 로직.
 *
 * 실행 인프라 재설계(docs/design/execution-infra-redesign.md §2.2, v3 최종)로
 *   bin/lib/poll-commands.js 에서 분리했다(로직 무변경, 위치만 이동 — poll 회귀 없음).
 *
 * 위치를 server/lib/(bin/lib/ 가 아니라)에 두는 이유: 이 시점부터 서버 프로세스 자신도
 *   (server/lib/dispatch-worker.js 를 통해) 직접 호출하는 1급 소비자가 된다 — 더 이상
 *   poll 전용 유틸이 아니다. env 스크럽(MALGNAI_API_KEY 삭제, MALGNAI_HEADLESS_WORKER=1 마커)과
 *   sandbox-exec 래핑이 이 모듈 안에 있으므로, poll 경로든 서버 직접 경로든 동일 보안경계를
 *   100% 공유한다(decision d01d3834 의 "spawn 전 로직이 본질" 근거를 코드로 강제).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 이 파일은 server/lib/ 에 있으므로 저장소 루트는 두 단계 위.
const REPO_ROOT = join(__dirname, '..', '..')

export const RESULT_MAX_CHARS = 8000
// 벽시계 타임아웃(턴 상한과 별개의 안전장치 — 워커가 응답 없이 매달리는 걸 막는다).
//   자율 project_cycle: 15분(실제 최대 19분 작업에 안전마진).
//   사람 직접 명령: 1시간(큰 작업 지원, 2026-07-10 hanging 명령 16시간 락 사건 이후 도입 — 무한 대기 차단).
export const SPAWN_TIMEOUT_MS = 900000 // 15분 (자율 project_cycle)
export const SPAWN_TIMEOUT_DIRECT_MS = 3600000 // 1시간 (사람 직접 명령)

// ── Write Sandbox v2: 커널 파일격리(sandbox-exec) ──
// SANDBOX_ENABLED='1' 이면 워커 spawn 을 sandbox-exec 로 래핑(비파괴 롤아웃 스위치, 기본 OFF).
//   OFF 면 기존 동작 그대로. macOS 아니거나 sandbox-exec 부재면 자동 skip(안전측 = 기존 동작).
export const SANDBOX_ENABLED = ['1', 'true', 'on'].includes(String(process.env.SANDBOX_ENABLED || '').toLowerCase())
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const SB_TEMPLATE = join(REPO_ROOT, 'bin', 'sandbox', 'worker.sb.template')
// 워커 전용 임시 루트(공유 /tmp 를 프로파일에 열지 않기 위해 dir 을 만들어 그 경로만 허용).
export const WORKER_TMP_ROOT = join(os.tmpdir(), 'malgnai-worker')

// (v2.2, issue ba85ad36 by-design) 워커는 전역 ~/.claude/CLAUDE.md·전역 에이전트를 **상속·활용**한다
//   (=플랫폼 핵심 기능). 페르소나/설정 격리는 하지 않는다. 여기 append 프롬프트는 전역을 교체·차단하지
//   않는 **가벼운 task 포커스 보강**만 담는다(순수 이번-task 범위 안내).
//   ⚠️ 2026-07-09(대표 지적 — 직접 명령이 프로젝트 폴더 밖 ~/workspace 에 새 폴더/산출물을 만든 사고):
//   물리적 경계는 여전히 sandbox-exec(Write Sandbox v2, SANDBOX_ENABLED)가 유일한 진짜 경계다(이
//   프롬프트는 그걸 대체하지 않는다 — 모델이 지시를 오독/무시하면 뚫릴 수 있는 소프트 가드일 뿐).
//   하지만 사고 당시 즉시디스패치 경로(server 프로세스)는 sandbox 가 꺼져 있었고(SANDBOX_ENABLED
//   미설정), 그 상태에서도 최소한의 억제력을 갖도록 쓰기 범위를 명시적으로 못박는다.
export const WORKER_SYSTEM_PROMPT = [
  '이번에 배정된 단일 task 범위에 집중해 수행하고, 완료되면 지정된 JSON 결과만 출력한다.',
  '파일/폴더 생성·수정·삭제는 반드시 지금 작업 중인 이 프로젝트 디렉터리(현재 작업 디렉터리) 내부에서만 수행한다.',
  '그 범위를 벗어난 경로(워크스페이스의 다른 프로젝트 폴더, 홈 디렉터리, 시스템 경로 등)는 필요 시 참고용으로 읽는 것만 허용되며, 새 파일·폴더 생성, 수정, 삭제는 절대 금지한다.',
  '산출물을 프로젝트 디렉터리 밖에 두어야 할 필요가 있다고 판단되면, 임의로 만들지 말고 그 사실과 이유를 결과 보고에 명시해 사람 판단을 받는다.',
].join(' ')

// 사람이 웹앱에서 직접 낸 명령(무제한 턴, task_type!=='project_cycle')에만 덧붙이는 단계화 지침.
//   턴 제한을 없앤 대신, 한 세션에서 거대한 작업을 통째로 밀어붙여 토큰을 낭비하지 않도록
//   "의미 있는 단계로 쪼개 이번엔 한 단계를 완결" 하는 습관을 프롬프트로 유도한다(사용자 요청).
//   NEXT_PHASE: 신호(server/lib/phase-chain.js 가 파싱)로 다음 단계 command 를 자동 생성·실행까지
//   이어지므로(재승인 없음), 여기서 끊기지 않고 마지막까지 자동 완결된다.
export const STAGED_EXECUTION_PROMPT = [
  '작업 범위가 크면 한 세션에서 전부 끝내려 하지 말고, 의미 있는 단계로 나눠서 진행한다.',
  '이번 세션에서는 한 단계를 완결한다.',
  '이번 단계로 프로젝트 진행 상태(코드/문서/설계 등)가 실제로 바뀌었다면, 다음 단계로 이어지든 여기서 전부 끝나든 상관없이 이번 세션을 마치기 전에 STATUS.md를 갱신한다 — "전체 작업이 다 끝난 뒤"가 아니라 "이번 단계가 끝날 때마다" 적용되는 규율이다.',
  '아직 남은 작업이 있으면, 응답의 맨 마지막에 정확히 다음 형식 한 줄만 남겨라(그 줄에 다른 말은 섞지 마라):',
  'NEXT_PHASE: <다음 세션이 이어받을 구체적 지시 — 지금까지 한 일과 남은 일을 판단할 수 있게 충분히 구체적으로>',
  '이 지시는 사람 확인 없이 그대로 다음 세션에 전달되어 자동 실행된다.',
  '이번 단계로 작업이 전부 끝났다면 그 줄을 남기지 말고 그냥 마무리한다.',
].join(' ')

// M-2: 워커 1태스크당 최대 턴 안전 기본값(설계 §5.1). claim 응답/서버 직접 디스패치 둘 다 이 값으로
//   폴백(호출부가 max_turns 를 못 구했거나 유효하지 않을 때 — 무제한 턴 루프 = 토큰/비용 런어웨이 차단).
//   2026-07-09: 자율운행 max turn 제한 제거(무제한 실행 허용).
export const DEFAULT_MAX_TURNS = 0

// 사람이 직접 낸 명령용 센티널: --max-turns 를 아예 붙이지 않는다(턴 무제한).
//   resolveMaxTurns(tool-profiles.js)가 비-자율(project_cycle 아님) 명령에 이 값을 돌려주고,
//   claim 응답/서버 직접 디스패치가 그대로 runClaude 에 전달한다. runClaude 는 이 값이면 상한을 걸지 않는다.
//   0 을 쓰는 이유: 기존 폴백 규칙(양의 정수만 상한)과 자연히 구분되고 JSON claim 응답으로도 안전히 실린다.
export const UNLIMITED_TURNS = 0

// sandboxAvailable — 이 실행환경에서 sandbox-exec 를 쓸 수 있는지(플래그 ON + macOS + 바이너리 존재).
export function sandboxAvailable() {
  if (!SANDBOX_ENABLED) return false
  if (process.platform !== 'darwin') return false
  try { return existsSync(SANDBOX_EXEC) && existsSync(SB_TEMPLATE) } catch { return false }
}

/**
 * renderWorkerSandbox — worker.sb.template 을 읽어 이번 워커 전용 .sb 로 렌더하고, 전용 tmp dir 을 만든다.
 *   subpath 는 **realpath 절대경로**로 넘긴다(심링크 프로젝트경로 우회 방지). 반환 { sbFile, workerTmp, cleanup }.
 */
export function renderWorkerSandbox(cwd) {
  const tpl = readFileSync(SB_TEMPLATE, 'utf8')
  // 워커 전용 임시 dir(공유 /tmp 를 프로파일에 열지 않기 위해).
  mkdirSync(WORKER_TMP_ROOT, { recursive: true })
  const workerTmp = join(WORKER_TMP_ROOT, `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(workerTmp, { recursive: true })
  const projectReal = realpathSync(cwd)
  const claudeHome = join(os.homedir(), '.claude')
  // sandbox-exec -D 로 param 주입하지만, 안정성을 위해 렌더 파일에도 실경로를 그대로 박아 넣는다
  //   (template 은 (param "X") 를 쓰므로 -D 로만 주입; 여기선 파일은 그대로 두고 -D 로 전달).
  const sbFile = join(workerTmp, 'worker.sb')
  writeFileSync(sbFile, tpl, 'utf8')
  const cleanup = () => { try { rmSync(workerTmp, { recursive: true, force: true }) } catch { /* best-effort */ } }
  return { sbFile, workerTmp, projectReal, claudeHome, cleanup }
}

/**
 * buildSpawn — 격리 인터페이스 추상화(향후 제한유저/컨테이너로 교체 시 여기만 바꿈).
 *   sandbox 프로파일이면 sandbox-exec 로 래핑, 아니면 claude 직접 실행.
 * @returns {{ bin, argv, cleanup, sandboxed }}
 */
export function buildSpawn(claudeArgs, cwd, sandboxProfile) {
  if (sandboxProfile === 'sandbox' && sandboxAvailable()) {
    const sb = renderWorkerSandbox(cwd)
    const argv = [
      '-f', sb.sbFile,
      '-D', `PROJECT_DIR=${sb.projectReal}`,
      '-D', `CLAUDE_HOME=${sb.claudeHome}`,
      '-D', `WORKER_TMP=${sb.workerTmp}`,
      'claude', ...claudeArgs,
    ]
    return { bin: SANDBOX_EXEC, argv, cleanup: sb.cleanup, sandboxed: true, workerTmp: sb.workerTmp }
  }
  return { bin: 'claude', argv: claudeArgs, cleanup: () => {}, sandboxed: false, workerTmp: null }
}

// 실시간 모니터용 stream-json 이벤트 → 화면 표시 요약(진행 로그 1줄).
// 순수 진행 내용(assistant 응답 텍스트 · 도구 호출 · 도구 결과)만 뽑고, system(훅 발동 등)·
// result(최종, end()로 별도 처리)·rate_limit_event 등 잡음은 버린다.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const val = input.file_path || input.path || input.command || input.pattern || input.url || input.description
  if (val) return String(val).slice(0, 150)
  try { return JSON.stringify(input).slice(0, 150) } catch { return '' }
}

// assistant 의 text 블록은 여기서 다루지 않는다 — runClaude 가 --include-partial-messages 로
//   토큰 단위 stream_event(content_block_delta) 를 실시간 방출하므로, 완성된 'assistant' 메시지의
//   text 는 이미 다 보여준 내용의 중복이다(tool_use 만 discrete 이벤트라 여기서 뽑는다).
export function summarizeStreamEvent(evt) {
  if (!evt || typeof evt !== 'object') return []
  const items = []
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_use') {
        items.push({ kind: 'tool_call', tool: block.name, detail: summarizeToolInput(block.name, block.input) })
      }
    }
  } else if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type !== 'tool_result') continue
      const raw = Array.isArray(block.content)
        ? block.content.map((c) => c.text || '').join(' ')
        : (block.content || '')
      items.push({ kind: 'tool_result', isError: !!block.is_error, detail: String(raw).trim().slice(0, 200) })
    }
  }
  return items
}

/**
 * runClaude — headless claude 워커 1회 실행.
 * @param {string} resumeSessionId (§9 원격 승인 재개) 주어지면 `claude --resume <sid>` 로 그 세션을
 *   이어받아 실행한다(instruction 은 그 세션에 이어붙일 -p 프롬프트=대표 답변). 미지정이면 신규 세션.
 * @param {function} onChunk stderr 원문 텍스트 청크 콜백(진단용, 기존 동작 유지).
 * @param {function} onEvent stdout stream-json 각 줄을 summarizeStreamEvent()로 요약한 진행 항목 콜백(신규).
 * @param {boolean} interactive Claude Code 웹콘솔(사람과 실시간 멀티턴 채팅) 전용 플래그(신규,
 *   2026-07-09). true 면 STAGED_EXECUTION_PROMPT(NEXT_PHASE 자동 이어달리기 유도)와 coo 페르소나
 *   강제(--agent coo)를 모두 끈다 — 사람이 실시간 채팅 중인데 매 턴 끝에 자동으로 다음 단계
 *   command 가 생성·실행되면 채팅 흐름과 충돌하고, coo 페르소나 강제도 자유 대화 UX에 안 맞는다.
 * @param {function} onChild (SIGTERM 그레이스풀 셧다운 드레인용, 신규) spawn 성공 직후 자식
 *   프로세스(ChildProcess) 레퍼런스를 caller 에 넘기는 콜백. dispatch-worker.js 가 이걸로
 *   activeDispatches 맵에 child 를 채워, 서버 종료 시 남은 실행을 SIGTERM 으로 정리할 수 있게 한다.
 *   미지정이면 기존과 완전히 동일하게 동작(하위 호환, 순수 추가 파라미터).
 */
export function runClaude(instruction, cwd, maxTurns, allowedTools, sandboxProfile, resumeSessionId = null, onChunk = null, onEvent = null, interactive = false, onChild = null) {
  return new Promise((res) => {
    // env 스크럽: 인입 인증 키 등 불필요한 비밀을 자식 프로세스에 노출하지 않는다.
    const scrubbedEnv = { ...process.env }
    delete scrubbedEnv.MALGNAI_API_KEY
    // 전역 Stop 훅(~/.claude/hooks/hook-stop-mcp-reminder.cjs)이 헤드리스 워커 세션에서도 발동해
    // 리마인더 텍스트로 최종 JSON 출력을 덮어쓰는 문제(구 프로젝트명 하드코딩 예외가 vibecoding엔
    // 안 걸림)가 있어, 훅이 프로젝트명과 무관하게 예외처리할 수 있도록 마커를 심는다.
    scrubbedEnv.MALGNAI_HEADLESS_WORKER = '1'

    // max_turns 집행 규칙:
    //   - UNLIMITED_TURNS(0) → 사람이 직접 낸 명령: --max-turns 를 아예 붙이지 않는다(무제한).
    //   - 양의 정수         → 그 값으로 상한(자율 project_cycle 의 예산).
    //   - 그 외(누락·음수·비정수) → 안전 기본값(DEFAULT_MAX_TURNS)으로 폴백(런어웨이 차단).
    const unlimitedTurns = maxTurns === UNLIMITED_TURNS
    const turns = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS
    // 무제한(=사람 직접 명령)일 때만 단계화 지침을 덧붙여, 상한 없는 세션이 토큰을 통째로 태우지 않게
    //   유도한다. 단, interactive(웹콘솔 채팅)면 그 지침을 붙이지 않는다 — NEXT_PHASE 자동 체이닝이
    //   실시간 채팅 흐름과 충돌하기 때문(위 JSDoc 참조).
    const appendSystemPrompt = interactive
      ? WORKER_SYSTEM_PROMPT
      : (unlimitedTurns ? `${WORKER_SYSTEM_PROMPT} ${STAGED_EXECUTION_PROMPT}` : WORKER_SYSTEM_PROMPT)

    // v3: allowedTools 가 배열로 오면(하위호환·특수케이스) 그 목록으로 제한 실행, null/미제공이면
    //   전권(bypassPermissions) 실행 — 도구 제한 대신 커널 sandbox 가 유일 경계(tool-profiles.js 참조).
    let toolTokens = null
    if (Array.isArray(allowedTools) && allowedTools.length) toolTokens = allowedTools.filter(Boolean)
    else if (typeof allowedTools === 'string' && allowedTools.trim()) toolTokens = allowedTools.split(/[,]+/).map(s => s.trim()).filter(Boolean)

    const claudeArgs = [
      '-p', instruction,
      // (§9) resume 모드: 유효한 session id 면 --resume 로 같은 세션을 이어받는다(반환 session_id 동일).
      ...(typeof resumeSessionId === 'string' && resumeSessionId.trim() ? ['--resume', resumeSessionId.trim()] : []),
      // stream-json(--verbose 필수): 실행 도중 assistant/tool 이벤트를 줄 단위로 실시간 방출해
      // 실행 모니터가 진행 내용을 볼 수 있게 한다(구 'json'은 종료 후 결과 1건만 나와 진행 불가시였음).
      // --include-partial-messages: 이게 없으면 assistant 의 응답 텍스트가 "한 턴 전체 생성 완료"
      //   시점에야 한 덩어리로 나온다(수 초 침묵 후 결과가 통째로 뜸). 토큰 단위 delta(stream_event/
      //   content_block_delta)를 받아야 실제로 타이핑되듯 실시간으로 보인다.
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...(toolTokens
        ? ['--permission-mode', 'default', '--allowedTools', ...toolTokens]
        : ['--permission-mode', 'bypassPermissions']),
      // C.3(v2.2): 전역 CLAUDE.md·전역 에이전트 **상속 보존**(핵심 기능) — `--setting-sources` 미부여.
      //   (선택) 가벼운 task 포커스 보강만 append(전역을 교체/차단하지 않음).
      '--append-system-prompt', appendSystemPrompt,
      '--model', 'claude-sonnet-5',
      // 무제한 명령이면 --max-turns 자체를 생략(사람 직접 명령), 아니면 상한 전달.
      ...(unlimitedTurns ? [] : ['--max-turns', String(turns)]),
      // 사람이 직접 낸 명령(무제한 턴)은 coo 에이전트로 실행(전역 CLAUDE.md 기본 페르소나 강제).
      //   단, interactive(웹콘솔 채팅)는 페르소나 강제를 끈다 — 자유 대화 UX에 coo 강제가 안 맞는다.
      ...(unlimitedTurns && !interactive ? ['--agent', 'coo'] : []),
    ]

    // v2: 커널 sandbox 래핑(가능하면). buildSpawn 이 sandbox-exec 여부를 캡슐화.
    const { bin, argv, cleanup, sandboxed, workerTmp } = buildSpawn(claudeArgs, cwd, sandboxProfile)

    // v2.2 하드닝: sandbox 프로파일이 공유 /private/var/folders 쓰기를 닫았으므로, 자식의 임시경로를
    //   워커 전용 dir 로 강제 주입한다(claude/node 의 임시쓰기가 전부 WORKER_TMP 안으로 떨어짐 → 격리 유지).
    if (sandboxed && workerTmp) {
      scrubbedEnv.TMPDIR = workerTmp
      scrubbedEnv.TMP = workerTmp
      scrubbedEnv.TEMP = workerTmp
    }

    // 벽시계 상한: 자율 project_cycle 10분, 사람 직접 명령 30분(hanging 명령 차단).
    //   node spawn 의 내장 timeout 대신 명시 타이머를 쓴다 — sandbox-exec/claude 래퍼가 SIGTERM 을 받아
    //   143 으로 정상종료(code=143, signal=null)하면 내장 timeout 은 원인을 못 남겨 stderr 의 잡음
    //   (stdin 경고)이 그대로 에러로 저장돼 진짜 원인(타임아웃)을 가렸다. timedOut 플래그로 정확히 남긴다.
    const timeoutMs = unlimitedTurns ? SPAWN_TIMEOUT_DIRECT_MS : SPAWN_TIMEOUT_MS

    let child
    try {
      // stdin='ignore': claude 는 -p 로 프롬프트를 받으므로 stdin 불필요. 열어두면 3초간 stdin 을
      //   기다려 "no stdin data received in 3s" 경고를 뱉고(3초 낭비), 타임아웃 시 그 경고가 에러로 남는다.
      child = spawn(bin, argv, { cwd, env: scrubbedEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      if (onChild) try { onChild(child) } catch { /* caller 콜백 실패는 실행 자체를 막지 않는다 */ }
    } catch (err) {
      cleanup()
      res({ exitCode: 1, stdout: '', stderr: '', spawnError: err.message, sandboxed })
      return
    }

    let timedOut = false
    // timeoutMs===0(사람 직접 명령) 이면 타이머를 걸지 않는다 = 벽시계 상한 없음(끝까지 실행).
    const killTimer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* 이미 종료 */ }
      }, timeoutMs)
      : null

    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    // --include-partial-messages 의 stream_event/content_block_delta(text_delta) 누적 상태.
    //   이 실행(child) 1회 전용 클로저 변수라 실행 간 상태 누수 없음. blockId 로 프론트가
    //   "새 줄 추가" vs "직전 줄 갱신(타이핑 효과)"을 구분한다(exec-monitor.progress 의 in-place 교체).
    let curBlockId = null
    let curText = ''
    let curBlockSeq = 0
    child.stdout?.on('data', (d) => {
      const text = d.toString()
      stdout += text
      if (!onEvent) return
      // NDJSON: 줄 경계가 chunk 경계와 안 맞을 수 있어 미완성 줄은 버퍼에 남긴다.
      lineBuf += text
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let evt
        try { evt = JSON.parse(line) } catch { continue /* 불완전/비JSON 줄은 무시 */ }
        if (evt?.type === 'stream_event') {
          const se = evt.event
          if (se?.type === 'content_block_start' && se.content_block?.type === 'text') {
            curBlockId = `${se.index}-${curBlockSeq++}`
            curText = ''
          } else if (se?.type === 'content_block_delta' && se.delta?.type === 'text_delta') {
            curText += se.delta.text
            onEvent({ kind: 'text', text: curText, streaming: true, blockId: curBlockId })
          }
          continue
        }
        for (const item of summarizeStreamEvent(evt)) onEvent(item)
      }
    })
    child.stderr?.on('data', (d) => {
      const text = d.toString()
      stderr += text
      if (onChunk) try { onChunk(text) } catch { /* 모니터 실패는 무시 */ }
    })

    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer)
      cleanup()
      res({ exitCode: 1, stdout, stderr, spawnError: err.message, sandboxed })
    })
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      cleanup()
      // 타임아웃으로 죽였으면 그걸 최우선 원인으로 남긴다(래퍼가 143 으로 정상종료해도 정확).
      //   code===null 은 시그널로 종료(예: SIGKILL/SIGTERM) — 원인 진단을 위해 signal 을 남긴다.
      const spawnError = timedOut
        ? `timed out after ${Math.round(timeoutMs / 60000)}min (killed)`
        : (code == null && signal ? `killed by signal ${signal}` : null)
      res({ exitCode: code == null ? 1 : code, stdout, stderr, spawnError, sandboxed })
    })
  })
}

// claude --output-format stream-json 의 stdout(줄마다 JSON 이벤트) 중 마지막 type='result' 줄에서
// result/total_cost_usd/session_id 추출. (구 --output-format json 은 stdout 전체가 단일 JSON 이었으나
// 실시간 진행 스트리밍을 위해 stream-json 으로 전환 — 마지막 줄이 그 결과 객체와 동일 스키마.)
// claude 가 max-turns 초과 등으로 is_error=true 를 반환할 때도 exit code 는 0이 아니게 오지만
// stdout 에는 진단 가능한 JSON(subtype/errors)이 실려 있다 — cliError 로 같이 뽑아 error 필드에 반영한다.
export function parseClaudeJson(stdout) {
  const out = { result: null, cost_usd: null, session_id: null, cliError: null, parseError: null }
  if (!stdout) return out

  const applyResultJson = (json) => {
    out.result = json.result != null ? String(json.result) : null
    out.cost_usd = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : null
    out.session_id = json.session_id || null
    // is_error=true인데 subtype==="success"는 실제 에러 아님(성공 완료) — 무시.
    if (json.is_error && json.subtype !== 'success') {
      const reason = Array.isArray(json.errors) && json.errors.length ? json.errors.join('; ') : (json.subtype || 'unknown error')
      out.cliError = `claude ${json.subtype || 'error'}: ${reason} (num_turns=${json.num_turns ?? '?'})`
    }
  }

  // stream-json: 뒤에서부터 훑어 type='result' 줄을 찾는다(정상 종료 시 항상 마지막 줄).
  const lines = stdout.trim().split('\n').filter((l) => l.trim())
  let foundResult = false
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(lines[i])
      if (json && json.type === 'result') { applyResultJson(json); foundResult = true; return out }
    } catch { /* 다음 줄 계속 탐색 */ }
  }
  // result 타입 줄을 못 찾음 — 구 --output-format json(단일 JSON 전체) 형식 폴백 시도.
  if (lines.length === 1) {
    try { applyResultJson(JSON.parse(lines[0])); foundResult = true; return out } catch { /* 아래 최종 폴백 */ }
  }
  // 완전 실패: 원문을 result 로 보존 + 파싱 실패 신호.
  out.result = stdout
  out.parseError = `PARSE_FAILED: No 'type:result' JSON found in ${lines.length} lines. First line: ${lines[0]?.slice(0, 100) || '(empty)'}`
  return out
}

export function truncate(str, max) {
  if (str == null) return null
  return str.length > max ? str.slice(0, max) : str
}

// 리뷰 2026-07-09 Minor-1: 배치형 "직접 명령"의 result 는 요약일 뿐이라 8000자 트렁케이션이
//   무해했지만, 콘솔 채팅(task_type==='console')은 result 자체가 사용자에게 보여줄 유일한 산출물이다
//   — 문장 중간에서 무통보로 잘리면 사용자가 "여기서 끝났다"고 오인한다. 잘렸을 때만 명시적 마커를
//   덧붙인다(task_type!=='console'인 기존 동작은 완전히 그대로 유지).
export function truncateForTask(str, taskType, max = RESULT_MAX_CHARS) {
  if (str == null) return null
  if (str.length <= max) return str
  const cut = str.slice(0, max)
  return taskType === 'console' ? `${cut}\n\n[...응답이 ${max}자에서 잘렸습니다]` : cut
}
