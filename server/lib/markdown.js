// renderMarkdownSubset() — 마크다운 서브셋 렌더러. 의존성 0의 순수함수.
// 설계 정본: docs/design/email-send-tool.md §14(라운드 2, D10~D14). 아래 절 번호는 그 문서를 가리킨다.
//
// 이 파일은 배너·푸터·컨테이너 div를 포함하지 않는다(§14.11) — 그건 server/lib/email.js가
// 렌더 결과 바깥에서 조립한다(I-4 — 사용자 입력이 서버 블록을 위조·은폐할 수 없다).
//
// 파이프라인 6단계(§14.4-3, 이 순서가 곧 안전성이다):
//   1. 개행 정규화 → 2. 🔴 전체 이스케이프(escape-first, I-2) → 3. 줄 분할(상한 검사)
//   → 4. 블록 파싱(줄 단위 상태기계, 중첩 없음) → 5. 인라인 스캔(좌→우 단일 패스, 재귀 없음)
//   → 6. 조립·상한 검사
//
// ⚠️ 2번(전체 이스케이프)보다 앞에서 토큰을 스캔하지 않는다 — 그 순서가 I-2의 전부다.
// ⚠️ 정규식은 줄 접두 앵커 + 유한 반복만 쓴다(백트래킹 폭발 금지, §14.8). 인라인 스캔은
//    정규식이 아니라 문자 인덱스 루프 + 창(window) 제한 indexOf로 구현해 전체 비용을 O(n)으로
//    고정한다.

// RENDERER_VERSION을 바꾸는 커밋에는 반드시 골든 스냅샷(§14.10 T-G) 갱신이 함께 있어야 한다
// (§14.6 감당 방안 — 반대로 스냅샷만 갱신하고 버전을 안 올리면 리뷰에서 반려한다).
export const RENDERER_VERSION = 'md-subset@1'

// ---------------------------------------------------------------------------
// 자원 상한(§14.8) — 값을 넓히려면 이 파일과 §14.8을 함께 바꿀 것.
// ---------------------------------------------------------------------------
const MAX_TEXT_LINES = 1000
const MAX_LINK_COUNT = 50
const MAX_URL_LEN = 300
const MAX_RENDERED_HTML_BYTES = 512000
const CODE_WINDOW = 200
const LINK_DISPLAY_WINDOW = 200
const LINK_URL_WINDOW = 300
const EMPHASIS_WINDOW = 500

// U-a~U-d(§14.3-1). 🔴 `&`는 `&amp;` 시퀀스로만 허용한다 — 통째로 허용하면 escape-first가
// 만든 `&quot;`/`&#39;`/`&lt;`까지 통과시켜 속성 탈출을 연다. 절대 느슨하게 바꾸지 말 것.
const URL_RE = /^https:\/\/(?:&amp;|[A-Za-z0-9\-._~:/?#[\]@!$*+,;=%])+$/

// 줄 접두 앵커 + 유한 반복만 쓴다(§14.8 허용 목록).
const HEADING_RE = /^(#{1,3}) (.+)$/
const UL_RE = /^- (.*)$/
const OL_RE = /^(\d{1,3})\. (.*)$/

function markdownValidationError(detail) {
  const e = new Error(`VALIDATION_ERROR: ${detail}`)
  e.name = 'ValidationError'
  e.code = 'VALIDATION_ERROR'
  return e
}

// escape-first(I-2)의 핵심. server/lib/email.js의 plain 경로가 쓰는 escapeHtml()과 로직은
// 동일하지만, plain 경로(buildHtml의 <pre> 출력)를 한 글자도 바꾸지 않기 위해 그 파일의 함수는
// 건드리지 않고 이 파일에서 별도로 export한다 — email.js는 markdown 경로(배너·푸터 조립)에서만
// 이 함수를 재사용한다(§14.4-6 경고 박스 — replyToEmail에도 반드시 적용할 것).
export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isBlockStart(line) {
  return HEADING_RE.test(line) || UL_RE.test(line) || OL_RE.test(line)
}

/** line[start..] 구간에서 target을 window자 이내로만 찾는다(백트래킹 없음, O(window) 고정 비용).
 *  찾으면 절대 인덱스, 못 찾으면 -1. */
function findBounded(line, target, start, window) {
  const windowEnd = Math.min(line.length, start + window)
  if (start >= windowEnd) return -1
  const idx = line.slice(start, windowEnd).indexOf(target)
  return idx === -1 ? -1 : start + idx
}

function extractHost(url) {
  const rest = url.slice('https://'.length)
  const m = /^[^/?#]*/.exec(rest)
  return m ? m[0] : ''
}

/** A7·§14.4-5 링크 시도. 실패하면 null(호출부가 '['를 리터럴로 1글자만 출력한다).
 *  성공하면 { html, next }를 반환한다. state.linkCount/linkHosts를 갱신한다(§14.4-2).
 *  자원 상한(MAX_LINK_COUNT) 초과는 여기서만 throw한다(§14.8 — 문법 오류가 아니라 비용 문제). */
function tryParseLink(line, openBracketIdx, state) {
  const displayStart = openBracketIdx + 1
  const closeBracket = findBounded(line, ']', displayStart, LINK_DISPLAY_WINDOW)
  if (closeBracket === -1) return null
  if (line[closeBracket + 1] !== '(') return null
  const urlStart = closeBracket + 2
  const closeParen = findBounded(line, ')', urlStart, LINK_URL_WINDOW)
  if (closeParen === -1) return null

  const display = line.slice(displayStart, closeBracket)
  const url = line.slice(urlStart, closeParen)

  if (url.length > MAX_URL_LEN) return null // U-b — 상한 초과는 에러가 아니라 그 링크만 평문(§14.8)
  if (!URL_RE.test(url)) return null // U-a·U-c·U-d

  if (state.linkCount + 1 > MAX_LINK_COUNT) {
    throw markdownValidationError(`too many links (max ${MAX_LINK_COUNT})`)
  }
  state.linkCount += 1
  const host = extractHost(url)
  if (host && state.linkHosts.length < 10 && !state.linkHosts.includes(host)) {
    state.linkHosts.push(host)
  }

  // §14.3 감당 방안 ① — 표시텍스트가 URL과 문자열 완전일치면 병기를 생략한다.
  const suffix = display === url ? '' : ` <span style="color:#666;font-size:12px">&lt;${url}&gt;</span>`
  // L2 — 표시텍스트는 재귀 처리하지 않는다(텍스트로만).
  const html = `<a href="${url}" rel="noopener noreferrer" style="color:#1a5fb4;text-decoration:underline">${display}</a>${suffix}`
  return { html, next: closeParen + 1 }
}

/** §14.4-5 인라인 규칙표 — 좌→우 단일 패스, 재귀 없음, 백트래킹 없음.
 *  매칭 실패 시 현재 문자를 리터럴로 출력하고 1칸 전진한다. */
function renderInline(line, state) {
  let out = ''
  let i = 0
  const n = line.length
  while (i < n) {
    const ch = line[i]

    if (ch === '`') {
      const close = findBounded(line, '`', i + 1, CODE_WINDOW)
      if (close !== -1) {
        const content = line.slice(i + 1, close)
        if (content.length >= 1) {
          out += `<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px">${content}</code>`
          i = close + 1
          continue
        }
      }
      out += '`'
      i += 1
      continue
    }

    // L5 — '[' 바로 앞이 '!'면 링크를 시도조차 하지 않는다(이미지 문법의 링크 둔갑 방지).
    if (ch === '[' && line[i - 1] !== '!') {
      let link
      try {
        link = tryParseLink(line, i, state)
      } catch (e) {
        throw e // 자원 상한(MAX_LINK_COUNT) — 렌더 전체를 중단한다.
      }
      if (link) {
        out += link.html
        i = link.next
        continue
      }
      out += '['
      i += 1
      continue
    }

    if (ch === '*') {
      if (line[i + 1] === '*') {
        // A2 — 강조(굵게). L1: 코드/링크보다 우선순위가 낮지만 여기까지 왔으면 코드/링크가 아니다.
        const searchStart = i + 2
        const close = findBounded(line, '**', searchStart, EMPHASIS_WINDOW)
        if (close !== -1) {
          const content = line.slice(searchStart, close)
          if (content.length >= 1) {
            out += `<strong>${content}</strong>`
            i = close + 2
            continue
          }
        }
        out += '*'
        i += 1
        continue
      }
      // A3 — 기울임. L4: 내용이 공백으로 시작·종료하면 성립하지 않는다.
      const searchStart = i + 1
      const close = findBounded(line, '*', searchStart, EMPHASIS_WINDOW)
      if (close !== -1) {
        const content = line.slice(searchStart, close)
        if (content.length >= 1 && !content.startsWith(' ') && !content.endsWith(' ')) {
          out += `<em>${content}</em>`
          i = close + 1
          continue
        }
      }
      out += '*'
      i += 1
      continue
    }

    // L6 — '_'는 어떤 강조도 아니다(분기 자체가 없어 항상 리터럴로 떨어진다).
    out += ch
    i += 1
  }
  return out
}

const HEADING_TAGS = { 1: 'h2', 2: 'h3', 3: 'h4' }
const HEADING_STYLES = {
  h2: 'font-size:18px;font-weight:600;margin:16px 0 8px',
  h3: 'font-size:16px;font-weight:600;margin:16px 0 8px',
  h4: 'font-size:14px;font-weight:600;margin:16px 0 8px'
}

/** §14.4-4 블록 규칙표 — 줄 단위 상태기계, 중첩 없음, 들여쓰기 없음. */
function parseBlocks(lines, state) {
  const blocks = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]

    if (line === '') {
      i += 1 // 빈 줄 — 연속 여러 개도 경계 1개(그냥 건너뛴다, 출력 없음)
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      const tag = HEADING_TAGS[level]
      blocks.push(`<${tag} style="${HEADING_STYLES[tag]}">${renderInline(heading[2], state)}</${tag}>`)
      i += 1
      continue
    }

    if (UL_RE.test(line)) {
      const items = []
      while (i < n) {
        const m = UL_RE.exec(lines[i])
        if (!m) break
        items.push(m[1])
        i += 1
      }
      const lis = items.map((it) => `<li style="margin:2px 0">${renderInline(it, state)}</li>`).join('\n')
      blocks.push(`<ul style="margin:0 0 12px;padding-left:20px">\n${lis}\n</ul>`)
      continue
    }

    const ol = OL_RE.exec(line)
    if (ol) {
      const startNum = ol[1]
      const items = []
      while (i < n) {
        const m = OL_RE.exec(lines[i])
        if (!m) break
        items.push(m[2])
        i += 1
      }
      const lis = items.map((it) => `<li style="margin:2px 0">${renderInline(it, state)}</li>`).join('\n')
      blocks.push(`<ol start="${startNum}" style="margin:0 0 12px;padding-left:22px">\n${lis}\n</ol>`)
      continue
    }

    // 그 외 — 문단. 빈 줄 또는 새 블록 시작 전까지 누적, 줄 사이는 <br>(A8).
    const paraLines = []
    while (i < n && lines[i] !== '' && !isBlockStart(lines[i])) {
      paraLines.push(lines[i])
      i += 1
    }
    const inner = paraLines.map((l) => renderInline(l, state)).join('<br>')
    blocks.push(`<p style="margin:0 0 12px">${inner}</p>`)
  }
  return blocks.join('\n')
}

/** 마크다운 서브셋을 HTML 조각으로 렌더한다. 배너·푸터·컨테이너는 포함하지 않는다.
 *  순수함수(난수·시각·env 미사용) — 같은 입력이면 항상 같은 출력(I-3).
 *  @param {string} text 사용자 원문(email.js가 길이/바이트 상한 검증을 마친 값)
 *  @returns {{ html: string, linkCount: number, linkHosts: string[] }}
 *  @throws {Error} name==='ValidationError' — 자원 상한 초과 시에만(§14.8)
 */
export function renderMarkdownSubset(text) {
  if (typeof text !== 'string') throw markdownValidationError('text must be a string')

  // 1) 개행 정규화(html 파트 전용 — text 파트는 email.js가 원문을 그대로 쓴다)
  const normalized = text.replace(/\r\n?/g, '\n')

  // 2) 🔴 전체 이스케이프 — 이 줄보다 앞에서 토큰을 스캔하지 않는다(I-2).
  const escaped = escapeHtml(normalized)

  // 3) 줄 분할 + 상한 검사(§14.8)
  const lines = escaped.split('\n')
  if (lines.length > MAX_TEXT_LINES) {
    throw markdownValidationError(`text must be <= ${MAX_TEXT_LINES} lines`)
  }

  // 4~5) 블록 파싱 + 인라인 스캔(state로 링크 수/호스트를 문서 전체에서 누적)
  const state = { linkCount: 0, linkHosts: [] }
  const html = parseBlocks(lines, state)

  // 6) 조립·상한 검사 — 방어적 안전핀(§14.8 산술상 도달 불가에 가깝다)
  const bytes = new TextEncoder().encode(html).byteLength
  if (bytes > MAX_RENDERED_HTML_BYTES) {
    console.error({ evt: 'email.markdown_render_too_large', bytes, limit: MAX_RENDERED_HTML_BYTES })
    throw markdownValidationError(`rendered html must be <= ${MAX_RENDERED_HTML_BYTES} bytes`)
  }

  return { html, linkCount: state.linkCount, linkHosts: state.linkHosts }
}
