// renderMarkdownSubset() 단위테스트 — docs/design/email-send-tool.md §14.10 공격 벡터 전체 고정.
// T-H(1-6)·T-U(7-16)·T-D(17-21)·T-B(23-24, 렌더러 단독으로 검증 가능한 것만)·T-G(32, 본문 블록만)를
// 담는다. T-I(26-31)와 T-B 22·25(배너·푸터 조립이 필요해 server/lib/email.js에서만 확인 가능한
// 항목)는 server/lib/email.test.js에 있다 — §14.11이 markdown.js에는 "배너·푸터·컨테이너를
// 포함하지 않는다"고 명시했으므로 이 파일에서는 그 두 항목을 직접 검증할 수 없다.
import { describe, it, expect } from 'vitest'
import { renderMarkdownSubset, escapeHtml, extractHost, RENDERER_VERSION } from './markdown.js'

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
  it('23. 수평선(---, ***, ___)·인용(>)·코드펜스(```) → 어떤 것도 태그가 되지 않고, 입력 문자는 리터럴로(또는 이스케이프된 형태로) 출력에 남는다(L-1 — 부정 단언만으로는 "문자를 조용히 삭제하는 변경"을 못 잡는다)', () => {
    // expectLiteral은 escape-first(§14.4-3 2번)를 거친 뒤에도 원문 문자가 사라지지 않았음을
    // 확인하는 긍정 단언이다. '>'는 escapeHtml() 5종 치환 대상이라 '&gt;'로 남는 것이 정상
    // 동작이고(치환 ≠ 삭제), 그 외 문자(-, *, _, `)는 escapeHtml()의 치환 대상이 아니라
    // 원문 그대로 남아야 한다.
    const cases = [
      { input: '---', expectLiteral: '---' },
      { input: '***', expectLiteral: '***' },
      { input: '___', expectLiteral: '___' },
      { input: '> 인용', expectLiteral: '&gt; 인용' },
      { input: '```\ncode\n```', expectLiteral: '```' }
    ]
    for (const { input, expectLiteral } of cases) {
      const { html } = renderMarkdownSubset(input)
      expect(html).not.toContain('<hr')
      expect(html).not.toContain('<blockquote')
      expect(html).not.toContain('<pre')
      // 배너·푸터를 흉내낼 배경색·보더 스타일이 어떤 경로로도 생성되지 않는다.
      expect(html).not.toContain('border-left')
      expect(html).not.toContain('background:#eef3fb')
      // 긍정 단언 — 입력 문자가 출력에 리터럴(또는 이스케이프된 형태)로 남아 있다.
      expect(html).toContain(expectLiteral)
    }
    // 코드펜스 케이스는 'code' 본문 자체도 삭제되지 않고 남아야 한다.
    expect(renderMarkdownSubset('```\ncode\n```').html).toContain('code')
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

// ---------------------------------------------------------------------------
// T-A. authority·표시텍스트 참칭(33~39, 라운드 2-1 보정) — 기존 1~32번 번호는 그대로 둔다.
// ---------------------------------------------------------------------------
describe('T-A — authority userinfo(U-e)·표시텍스트 URL 참칭(L7) 방어(§14.3-1·§14.3-3, 라운드 2-1)', () => {
  it('33. userinfo 위장(portal.malgnsoft.com@evil.example) → 링크 없음, 전체 평문. 병기 존재는 통과 판정 근거가 아니다 — <a 개수 0을 직접 단언한다', () => {
    const { html, linkCount } = renderMarkdownSubset('[사내 포털](https://portal.malgnsoft.com@evil.example/login)')
    // ⚠️ 이 케이스는 병기 문자열(&lt;https://portal.malgnsoft.com@evil.example/login&gt;)이
    // 존재해도 그것이 원문 그대로라서 똑같이 속인다(§14.3-1 U-e 근거) — "병기가 있다"로
    // 통과 판정하면 안 되고, 클릭 가능한 요소(<a ) 자체가 0개임을 단언해야 한다.
    const anchorCount = (html.match(/<a /g) || []).length
    expect(anchorCount).toBe(0)
    expect(html).toContain('[사내 포털](https://portal.malgnsoft.com@evil.example/login)')
    expect(linkCount).toBe(0)
  })

  it('34. authority에 자격증명이 섞인 URL → 링크 없음, linkHosts가 빈 배열(감사 metadata에 자격증명이 실리지 않음, §14.6-1)', () => {
    const { html, linkCount, linkHosts } = renderMarkdownSubset('[x](https://svc:AKIA_SECRET@evil.example/cb)')
    expect(html).not.toContain('<a ')
    expect(linkCount).toBe(0)
    expect(linkHosts).toEqual([])
    // 렌더 출력에 원문이 평문으로 보이는 것은 정상(사용자가 쓴 문자는 사라지지 않는다).
    expect(html).toContain('https://svc:AKIA_SECRET@evil.example/cb')
  })

  it('35. %40 우회(퍼센트 인코딩된 @) → 링크 없음', () => {
    const { html, linkCount } = renderMarkdownSubset('[x](https://portal.malgnsoft.com%40evil.example/)')
    expect(html).not.toContain('<a ')
    expect(linkCount).toBe(0)
  })

  it('36. 오탐 방지(정상 케이스) — 경로·쿼리의 @, 포트는 authority userinfo가 아니라 링크가 정상 생성된다', () => {
    const r1 = renderMarkdownSubset('[x](https://a.example/@handle)')
    expect(r1.html).toContain('<a href="https://a.example/@handle"')
    expect(r1.linkHosts).toEqual(['a.example'])

    const r2 = renderMarkdownSubset('[x](https://a.example/p?to=user@malgnsoft.com)')
    expect(r2.html).toContain('<a href="https://a.example/p?to=user@malgnsoft.com"')
    expect(r2.linkHosts).toEqual(['a.example'])

    const r3 = renderMarkdownSubset('[x](https://a.example:8443/p)')
    expect(r3.html).toContain('<a href="https://a.example:8443/p"')
    expect(r3.linkHosts).toEqual(['a.example:8443']) // 포트는 유지한다
  })

  it('37. 표시텍스트가 병기 서식(꺾쇠)을 참칭 → 링크 없음, 전체 평문. <a 0개', () => {
    const { html, linkCount } = renderMarkdownSubset(
      '[사내 포털 <https://portal.malgnsoft.com/notice>](https://evil.example/login)'
    )
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
  })

  it('38. 표시텍스트가 URL 자체를 참칭(스킴 문자열 포함) → 링크 없음', () => {
    const { html, linkCount } = renderMarkdownSubset('[https://portal.malgnsoft.com/notice](https://evil.example/login)')
    expect(html).not.toContain('<a ')
    expect(linkCount).toBe(0)
  })

  it('39. L7 예외·오탐의 회귀 고정 — 완전일치는 링크가 되고(13번과 짝), 부등호가 든 정상 표시텍스트는 의도된 오탐으로 링크가 되지 않는다', () => {
    const exact = renderMarkdownSubset('[https://a.com](https://a.com)')
    expect(exact.html).toContain('<a href="https://a.com"')
    expect(exact.html).not.toContain('&lt;https://a.com&gt;') // 병기 생략(완전일치)
    expect(exact.linkCount).toBe(1)

    // '매출 > 10억'은 escape-first를 거치면 표시텍스트가 '매출 &gt; 10억'이 되어 '&gt;'를
    // 포함한다 — 부등호가 든 정상 표시텍스트가 링크가 되지 않는 것은 §14.3-3이 명시한
    // 의도된 오탐이지 고쳐야 할 버그가 아니다(손실은 0 — 문자 그대로 평문 표시).
    const mistaken = renderMarkdownSubset('[매출 > 10억](https://a.com)')
    expect(mistaken.html).not.toContain('<a ')
    expect(mistaken.linkCount).toBe(0)
  })
})

describe('escapeHtml — email.js의 markdown 경로(배너·푸터)가 재사용하는 함수', () => {
  it('5종 문자를 모두 치환한다', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })
})

// ---------------------------------------------------------------------------
// 라운드 2-2 — 보안 재검증(2회차) 반영. PM 직접 실측 반례: L7이 표시텍스트를 ASCII 원형
// 그대로만 검사해 전각·대소문자 변형이 통과했다(가짜 병기가 앵커 안에 남는다). L7 판정을
// display.normalize('NFKC').toLowerCase() 사본 기준으로 바꾼 데 대한 회귀 테스트.
// ---------------------------------------------------------------------------
describe('L7 정규화 사본 기준 판정(라운드 2-2) — 전각·대소문자 변형으로도 병기 참칭을 막는다', () => {
  it('전각 꺾쇠 + 대문자 스킴(＜HTTPS://…＞)으로 병기를 흉내낸 표시텍스트 → 링크 없음', () => {
    const { html, linkCount } = renderMarkdownSubset(
      '[사내 포털 ＜HTTPS://portal.malgnsoft.com＞](https://evil.example/login)'
    )
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
    expect(html).toContain('[사내 포털 ＜HTTPS://portal.malgnsoft.com＞](https://evil.example/login)')
  })

  it('대소문자 혼용 스킴(HtTps://…)으로 병기를 흉내낸 표시텍스트 → 링크 없음', () => {
    const { html, linkCount } = renderMarkdownSubset(
      '[사내 포털 HtTps://portal.malgnsoft.com](https://evil.example/login)'
    )
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
  })

  it('전각 스킴 전체(ｈｔｔｐｓ：／／…) → 링크 없음(NFKC가 전각 콜론·슬래시까지 반각으로 접는다)', () => {
    const { html, linkCount } = renderMarkdownSubset('[ｈｔｔｐｓ：／／evil.example](https://evil.example/login)')
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
  })

  it('전각 대문자 스킴(ＨＴＴＰＳ://…) → 링크 없음', () => {
    const { html, linkCount } = renderMarkdownSubset('[ＨＴＴＰＳ://evil.example](https://evil.example/login)')
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
  })

  it('오탐 방지(정상 케이스) — 정규화와 무관한 정상 표시텍스트는 여전히 앵커 1개 + 병기 1개로 렌더된다', () => {
    const { html, linkCount } = renderMarkdownSubset('[사내 포털](https://portal.malgnsoft.com/notice/12)')
    expect((html.match(/<a /g) || []).length).toBe(1)
    expect(linkCount).toBe(1)
    expect(html).toContain('&lt;https://portal.malgnsoft.com/notice/12&gt;')
  })

  // ⚠️ ‹›(U+2039/203A)·〈〉(U+3008/3009) 등 NFKC로 반각 꺾쇠에 접히지 않는 유사 꺾쇠는
  // 여전히 링크를 만든다 — 이것이 현재의 의도된 잔여 위험(계약)이다. 그 계약 자체는 아래
  // 'T-N — 벡터 41·42' describe 블록의 42번 테스트가 못 박는다(§14.10 벡터 42).
})

// ---------------------------------------------------------------------------
// T-N. 정규화 우회와 회귀 방지 공백(§14.10 라운드 2-2) — 41·42번.
// 40번(전각 꺾쇠·대소문자 혼용·전각 스킴 우회)·43번(U-d 빈 authority)·44번(extractHost 직접
// 단언)은 이미 위 'L7 정규화 사본 기준 판정' describe와 'U-d 회귀'·'extractHost()' describe가
// 동등한 입력으로 덮고 있어 여기서는 중복 작성하지 않는다.
// ---------------------------------------------------------------------------
describe('T-N — 벡터 41·42(§14.10 라운드 2-2)', () => {
  it('41. L7 완전일치 예외는 원문 기준이라 대소문자만 다른 표시텍스트로는 넓어지지 않는다 — [HTTPS://a.com](https://a.com)은 링크가 되지 않고, 39번의 [https://a.com](https://a.com)은 여전히 링크가 된다(두 케이스를 나란히 두어 예외가 원문 완전일치 기준임을 고정)', () => {
    const caseInsensitive = renderMarkdownSubset('[HTTPS://a.com](https://a.com)')
    expect((caseInsensitive.html.match(/<a /g) || []).length).toBe(0)
    expect(caseInsensitive.linkCount).toBe(0)
    expect(caseInsensitive.html).toContain('[HTTPS://a.com](https://a.com)')

    const exact = renderMarkdownSubset('[https://a.com](https://a.com)')
    expect((exact.html.match(/<a /g) || []).length).toBe(1)
    expect(exact.linkCount).toBe(1)
    expect(exact.html).not.toContain('&lt;https://a.com&gt;') // 병기 생략(완전일치)
  })

  // 42. 잔여 위험의 현재 계약 고정(§14.5-D ⓑ). 이 테스트의 취지는 "막는 것"이 아니라 "현재
  // 동작을 못 박는 것"이다 — 지금은 이 형태가 링크로 생성되는 것이 의도된 계약(수용된 잔여
  // 위험)이므로 그 사실을 단언한다. 누군가 유사 문자 목록을 추가해 이 동작을 바꾸면 이 테스트가
  // 깨지고, 그때 §14.5-D의 수용 판단(뒤집기 조건)을 함께 갱신하게 만드는 장치다 — 실패한다고
  // "고쳐야 할 버그"로 오인해 임의로 판정 로직을 넓히지 말 것.
  it('42. NFKC로 접히지 않는 유사 꺾쇠(‹›, 〈〉)는 현재 계약대로 여전히 링크가 생성된다(수용된 잔여 위험 — 취약점을 막는 테스트가 아니라 현재 동작을 고정하는 테스트)', () => {
    const angle1 = renderMarkdownSubset('[사내 포털 ‹portal.malgnsoft.com›](https://evil.example/login)')
    expect((angle1.html.match(/<a /g) || []).length).toBe(1)
    expect(angle1.linkCount).toBe(1)
    expect(angle1.html).toContain('<a href="https://evil.example/login"')

    const angle2 = renderMarkdownSubset('[사내 포털 〈portal.malgnsoft.com〉](https://evil.example/login)')
    expect((angle2.html.match(/<a /g) || []).length).toBe(1)
    expect(angle2.linkCount).toBe(1)
    expect(angle2.html).toContain('<a href="https://evil.example/login"')
  })
})

// ---------------------------------------------------------------------------
// 회귀 방지 공백 메우기(라운드 2-2 항목 2) — 코드는 옳지만 지워도 전 테스트가 통과하던 3건을
// 잠근다.
// ---------------------------------------------------------------------------
describe('U-d 회귀 — 빈 authority(https:///evil.example)는 링크를 만들지 않는다', () => {
  it('authority가 빈 URL → 링크 0개(linkHosts도 비어 있다)', () => {
    const { html, linkCount, linkHosts } = renderMarkdownSubset('[x](https:///evil.example)')
    expect((html.match(/<a /g) || []).length).toBe(0)
    expect(linkCount).toBe(0)
    expect(linkHosts).toEqual([])
    expect(html).toContain('[x](https:///evil.example)')
  })
})

describe('extractHost() — userinfo 절단 로직 직접 단언(테스트 전용 export, U-e 때문에 공개 API로는 도달 불가)', () => {
  it('userinfo가 있으면 절단하고 호스트만 남긴다', () => {
    expect(extractHost('https://user@host.example/path')).toBe('host.example')
  })

  it("a@b@c 형태(다중 '@')에서 마지막 '@' 뒤를 취한다", () => {
    expect(extractHost('https://a@b@c')).toBe('c')
  })

  it('포트는 절단하지 않고 유지한다', () => {
    expect(extractHost('https://a.example:8443/path')).toBe('a.example:8443')
  })

  it('IPv6 대괄호 형태([2001:db8::1]:8443)에서 오작동하지 않는다(내부 콜론을 userinfo 구분자로 오인하지 않음)', () => {
    expect(extractHost('https://[2001:db8::1]:8443/path')).toBe('[2001:db8::1]:8443')
  })
})
