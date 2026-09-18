// renderMarkdownSubset() 단위테스트 — docs/design/email-send-tool.md §14.10 공격 벡터 전체 고정.
// T-H(1-6)·T-U(7-16)·T-D(17-21)·T-B(23-24, 렌더러 단독으로 검증 가능한 것만)·T-G(32, 본문 블록만)를
// 담는다. T-I(26-31)와 T-B 22·25(배너·푸터 조립이 필요해 server/lib/email.js에서만 확인 가능한
// 항목)는 server/lib/email.test.js에 있다 — §14.11이 markdown.js에는 "배너·푸터·컨테이너를
// 포함하지 않는다"고 명시했으므로 이 파일에서는 그 두 항목을 직접 검증할 수 없다.
import { describe, it, expect } from 'vitest'
import { renderMarkdownSubset, escapeHtml, RENDERER_VERSION } from './markdown.js'

function expectValidationError(fn) {
  expect(fn).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
}

// ---------------------------------------------------------------------------
// T-H. raw HTML 무력화(1~6)
// ---------------------------------------------------------------------------
describe('T-H — raw HTML은 escape-first로 무력화된다(I-2)', () => {
  const dangerousTagRe = /<(script|img|style|iframe)[\s>/]/i

  it('1. <script>alert(1)</script> → 태그가 생성되지 않는다', () => {
    const { html } = renderMarkdownSubset('<script>alert(1)</script>')
    expect(html).not.toMatch(dangerousTagRe)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('2. <img src=x onerror=alert(1)> → 태그가 생성되지 않는다', () => {
    const { html } = renderMarkdownSubset('<img src=x onerror=alert(1)>')
    expect(html).not.toMatch(dangerousTagRe)
    expect(html).not.toContain('<img')
  })

  it('3. <a href="https://evil.example">사내 포털</a> → 마크다운 경유로도 위장 앵커가 만들어지지 않는다(D6 핵심 회귀)', () => {
    const { html } = renderMarkdownSubset('<a href="https://evil.example">사내 포털</a>')
    expect(html).not.toContain('<a href="https://evil.example"')
    expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;')
  })

  it('4. <style>/<!-- -->/<iframe> → 전부 태그가 생성되지 않는다', () => {
    const inputs = ['<style>body{display:none}</style>', '<!-- 주석 -->', '<iframe src=https://evil.example></iframe>']
    for (const input of inputs) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toMatch(dangerousTagRe)
      expect(html).not.toContain('<!--')
    }
  })

  it('5. 강조/코드/링크 표시텍스트/제목 안에 raw HTML이 섞여도 태그가 생성되지 않는다', () => {
    const cases = [
      '**<script>x</script>**',
      '`<script>`',
      '[<script>](https://a.com)',
      '# <script>'
    ]
    for (const input of cases) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toMatch(dangerousTagRe)
      expect(html).toContain('&lt;script&gt;')
    }
  })

  it('6. <SCRIPT>(대문자)·중첩 우회·이미 이스케이프된 입력 전부 리터럴로 남는다', () => {
    const { html: h1 } = renderMarkdownSubset('<SCRIPT>alert(1)</SCRIPT>')
    expect(h1).not.toMatch(dangerousTagRe)

    const { html: h2 } = renderMarkdownSubset('<scr<script>ipt>')
    expect(h2).not.toMatch(dangerousTagRe)

    // 입력이 이미 "&lt;script&gt;"인 경우 — escapeHtml이 '&'만 다시 이스케이프해 이중 리터럴이 된다.
    const { html: h3 } = renderMarkdownSubset('&lt;script&gt;')
    expect(h3).toContain('&amp;lt;script&amp;gt;')
    expect(h3).not.toMatch(dangerousTagRe)
  })
})

// ---------------------------------------------------------------------------
// T-U. 링크·URL(7~16)
// ---------------------------------------------------------------------------
describe('T-U — 링크는 https:// 화이트리스트를 통과해야만 앵커가 된다(D12·§14.3-1)', () => {
  it('7. javascript: 스킴 → 링크 없음, 원문 전체가 평문', () => {
    const { html, linkCount } = renderMarkdownSubset('[사내 포털](javascript:alert(1))')
    expect(html).not.toContain('<a href')
    expect(html).toContain('[사내 포털](javascript:alert(1))')
    expect(linkCount).toBe(0)
  })

  it('8. data: / vbscript: / file: 스킴 → 전부 링크 없음', () => {
    const cases = ['[x](data:text/html;base64,AAAA)', '[x](vbscript:msgbox(1))', '[x](file:///etc/passwd)']
    for (const input of cases) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toContain('<a href')
    }
  })

  it('9. 프로토콜 상대·상대경로·http:// → https://만 허용이라 전부 링크 없음', () => {
    const cases = ['[x](//evil.example)', '[x](/relative/path)', '[x](http://plain.example)']
    for (const input of cases) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toContain('<a href')
    }
  })

  it('10. 속성 탈출 시도(따옴표 포함 URL) → URL_RE 탈락, 링크 없음', () => {
    const { html } = renderMarkdownSubset('[x](https://a.com" onmouseover="alert(1))')
    expect(html).not.toContain('<a href')
  })

  it('11. 정상 쿼리스트링(&)이 있는 링크는 생성되고 href에 &amp; 형태로 들어간다', () => {
    const { html, linkCount } = renderMarkdownSubset('[x](https://a.com?q=1&b=2)')
    expect(linkCount).toBe(1)
    expect(html).toContain('href="https://a.com?q=1&amp;b=2"')
  })

  it('12. 링크 생성 시 병기(&lt;URL&gt;)가 항상 존재한다(I-1 회귀 감지기 — 절대 빠지면 안 됨)', () => {
    const { html } = renderMarkdownSubset('[사내 포털](https://evil.example/login)')
    expect(html).toContain('<a href="https://evil.example/login"')
    expect(html).toContain('&lt;https://evil.example/login&gt;')
  })

  it('13. 표시텍스트===URL이면 병기가 생략된다(중복 회피)', () => {
    const { html } = renderMarkdownSubset('[https://a.com](https://a.com)')
    expect(html).toContain('<a href="https://a.com"')
    expect(html).not.toContain('&lt;https://a.com&gt;')
  })

  it('14. 이미지 문법은 <img>도 링크도 만들지 않는다(L5)', () => {
    const { html, linkCount } = renderMarkdownSubset('![alt](https://a.com/x.png)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a href')
    expect(linkCount).toBe(0)
  })

  it('15. 강조 안의 링크는 렌더되지 않는다(L2 — 재귀 없음), URL은 평문으로 보인다', () => {
    const { html, linkCount } = renderMarkdownSubset('**[표시](https://a.com)**')
    expect(html).toContain('<strong>')
    expect(html).not.toContain('<a href')
    expect(html).toContain('https://a.com')
    expect(linkCount).toBe(0)
  })

  it('16. URL 301자 → 링크 없음(U-b) / 링크 51개 → VALIDATION_ERROR', () => {
    const longUrl = 'https://a.com/' + 'x'.repeat(301 - 'https://a.com/'.length)
    expect(longUrl.length).toBe(301)
    const { html } = renderMarkdownSubset(`[x](${longUrl})`)
    expect(html).not.toContain('<a href')

    const lines = []
    for (let i = 0; i < 51; i++) lines.push(`[l${i}](https://a${i}.com)`)
    expectValidationError(() => renderMarkdownSubset(lines.join('\n')))
  })
})

// ---------------------------------------------------------------------------
// T-D. malformed·DoS(17~21) — 예외 없이 선형 시간(로컬 100ms 이내)에 종료해야 한다.
// ---------------------------------------------------------------------------
describe('T-D — malformed 입력은 선형 시간에 리터럴로 떨어진다(백트래킹 없음, §14.8)', () => {
  function assertFastAndNoCrash(input) {
    const start = Date.now()
    let result
    expect(() => {
      result = renderMarkdownSubset(input)
    }).not.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100)
    return result
  }

  it('17. 같은 문자 5,000회 반복(*, **, [, `) — 예외 없이 100ms 이내 종료', () => {
    assertFastAndNoCrash('*'.repeat(5000))
    assertFastAndNoCrash('**'.repeat(5000))
    assertFastAndNoCrash('['.repeat(5000))
    assertFastAndNoCrash('`'.repeat(5000))
  })

  it('18. 불완전한 목록 마커·깊은 들여쓰기 목록 흉내 — 예외 없이 처리된다', () => {
    // '- '(내용 없는 목록 마커) 자체는 §14.2-1/§14.4-4가 최소 내용 길이를 규정하지 않아
    // 빈 <li>를 허용해도 설계 위반이 아니다 — 이 벡터의 취지는 "크래시하지 않는다"이지
    // "목록이 안 된다"가 아니다.
    assertFastAndNoCrash('- '.repeat(1))

    // 들여쓴 목록은 선행 공백 때문에 목록으로 인식되지 않고 문단 텍스트로 떨어진다(§14.4-4).
    const indented = '  '.repeat(200) + '- x'
    const r2 = assertFastAndNoCrash(indented)
    expect(r2.html).not.toContain('<ul')
  })

  it('19. 닫히지 않은 토큰(굵게/코드/링크) — 예외 없이 리터럴로 떨어진다', () => {
    const cases = ['**굵게', '`코드 ', '[표시](https://a.com', '[표시]']
    for (const input of cases) {
      const { html } = assertFastAndNoCrash(input)
      expect(html).not.toContain('<strong>')
      expect(html).not.toContain('<code')
      expect(html).not.toContain('<a href')
    }
  })

  it('20. 1,001줄 → VALIDATION_ERROR / 1,000줄 정확히 → 통과', () => {
    const line1001 = Array.from({ length: 1001 }, (_, i) => `line${i}`).join('\n')
    expectValidationError(() => renderMarkdownSubset(line1001))

    const line1000 = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n')
    expect(() => renderMarkdownSubset(line1000)).not.toThrow()
  })

  it('21. 40,960바이트에 가까운 한글 본문 — 렌더 성공, 출력이 512,000바이트 이내', () => {
    const text = '가'.repeat(13653) // 3바이트/자 × 13653 ≈ 40,959바이트
    const { html } = renderMarkdownSubset(text)
    const bytes = new TextEncoder().encode(html).byteLength
    expect(bytes).toBeLessThanOrEqual(512000)
  })
})

// ---------------------------------------------------------------------------
// T-B. 배너·푸터 위조·은폐 — 렌더러 단독으로 검증 가능한 항목만(23·24).
// 22·25(진짜 배너·푸터 문구 존재 확인)는 server/lib/email.test.js에 있다(배너·푸터는
// markdown.js가 모르는 값이라 여기서 검증할 수 없다, §14.11).
// ---------------------------------------------------------------------------
describe('T-B — 서브셋에는 전폭 박스·수평선·인용·코드펜스를 만들 문법이 없다(§14.2-2·§14.5)', () => {
  it('23. 수평선(---, ***, ___)·인용(>)·코드펜스(```) → 어떤 것도 태그가 되지 않는다', () => {
    const cases = ['---', '***', '___', '> 인용', '```\ncode\n```']
    for (const input of cases) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toContain('<hr')
      expect(html).not.toContain('<blockquote')
      expect(html).not.toContain('<pre')
      // 배너·푸터를 흉내낼 배경색·보더 스타일이 어떤 경로로도 생성되지 않는다.
      expect(html).not.toContain('border-left')
      expect(html).not.toContain('background:#eef3fb')
    }
  })

  it('24. 대량 개행 — 문단 경계 1개로 접혀 밀어내기가 무력화된다(MAX_TEXT_LINES 이내 구간)', () => {
    // §14.8의 MAX_TEXT_LINES(1,000)를 넘는 개행(예: 3,000개)은 이 테스트가 검증하려는
    // "빈 줄이 문단 경계 1개로 접힌다"는 동작에 도달하기 전에 VALIDATION_ERROR로 먼저
    // 거부된다(그 자체로 §14.5 B 위협에 대한 또 다른 유효한 방어선이다 — 아래에서 별도 확인).
    // 그래서 이 테스트는 상한 안(500줄)에서 접힘 동작 자체를 검증한다.
    const input = '\n'.repeat(500) + '본문'
    const { html } = renderMarkdownSubset(input)
    const pCount = (html.match(/<p /g) || []).length
    expect(pCount).toBeLessThanOrEqual(1)
    expect(html).toContain('본문')
  })

  it('24b. MAX_TEXT_LINES를 넘는 개행(3,000개)은 VALIDATION_ERROR로 거부된다(밀어내기 공격의 극단값은 자원 상한이 먼저 막는다)', () => {
    const input = '\n'.repeat(3000) + '본문'
    expectValidationError(() => renderMarkdownSubset(input))
  })
})

// ---------------------------------------------------------------------------
// T-G. 골든 스냅샷(32) — 본문 블록만(배너·푸터 포함 전문은 email.test.js에서 검증).
// 렌더 규칙이 바뀌면 이 스냅샷이 깨진다 — 그때 RENDERER_VERSION을 올리지 않으면 리뷰에서
// 반려된다(§14.6 감당 방안, §14.11 backend-dev 체크리스트 18번).
//
// ⚠️ §14.4-6의 예시 입력은 "## 제목"(레벨 2)을 <h2>로 보여주지만, §14.2-1·§14.4-4 블록
// 규칙표는 둘 다 "#→h2 / ##→h3 / ###→h4"로 일관되게 규정한다. 이 구현은 두 규칙표(서로
// 독립적으로 두 번 일치)를 따랐고, §14.4-6 예시의 태그명 표기가 그 둘과 어긋나는 것으로
// 판단해 규칙표 쪽을 정본으로 채택했다 — 이 불일치는 PM/설계자에게 별도 보고한다.
// ---------------------------------------------------------------------------
describe('T-G — 골든 스냅샷(§14.4-6)', () => {
  it('32. 종합 예시 입력 → 본문 블록 HTML 전문이 고정된 스냅샷과 일치한다', () => {
    const input = `## 9월 정기점검 안내

점검은 **9/20(토) 02:00~04:00**에 진행합니다. 대상은 아래와 같습니다.

- 사내 포털
- *일부* 배치 작업
- 로그 수집기(\`otel-collector\`)

자세한 내용은 [점검 공지](https://portal.malgnsoft.com/notice/12)를 확인하세요.

1. 02:00 서비스 중단
2. 04:00 정상화`

    const { html, linkCount, linkHosts } = renderMarkdownSubset(input)

    const expected = [
      '<h3 style="font-size:16px;font-weight:600;margin:16px 0 8px">9월 정기점검 안내</h3>',
      '<p style="margin:0 0 12px">점검은 <strong>9/20(토) 02:00~04:00</strong>에 진행합니다. 대상은 아래와 같습니다.</p>',
      '<ul style="margin:0 0 12px;padding-left:20px">\n' +
        '<li style="margin:2px 0">사내 포털</li>\n' +
        '<li style="margin:2px 0"><em>일부</em> 배치 작업</li>\n' +
        '<li style="margin:2px 0">로그 수집기(<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px">otel-collector</code>)</li>\n' +
        '</ul>',
      '<p style="margin:0 0 12px">자세한 내용은 <a href="https://portal.malgnsoft.com/notice/12" rel="noopener noreferrer" style="color:#1a5fb4;text-decoration:underline">점검 공지</a> <span style="color:#666;font-size:12px">&lt;https://portal.malgnsoft.com/notice/12&gt;</span>를 확인하세요.</p>',
      '<ol start="1" style="margin:0 0 12px;padding-left:22px">\n' +
        '<li style="margin:2px 0">02:00 서비스 중단</li>\n' +
        '<li style="margin:2px 0">04:00 정상화</li>\n' +
        '</ol>'
    ].join('\n')

    expect(html).toBe(expected)
    expect(linkCount).toBe(1)
    expect(linkHosts).toEqual(['portal.malgnsoft.com'])
    expect(RENDERER_VERSION).toBe('md-subset@1')
  })
})

describe('escapeHtml — email.js의 markdown 경로(배너·푸터)가 재사용하는 함수', () => {
  it('5종 문자를 모두 치환한다', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })
})
