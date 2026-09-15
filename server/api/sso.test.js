// GET /sso 회귀 테스트. 하우스 스타일은 server/api/oauth.js의 registerWellKnownRoutes()와 동일
// 패턴이라, 이 파일도 registerSsoRoute()를 새 Hono 인스턴스에 직접 등록해 라우트 단위로만 검증한다
// (server/index.js 전체 디스패처는 이 파일의 범위 밖).
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { registerSsoRoute } from './sso.js'

function makeApp() {
  const app = new Hono()
  registerSsoRoute(app)
  return app
}

async function get(path) {
  const app = makeApp()
  const res = await app.request(path)
  return res
}

describe('GET /sso', () => {
  it('redirect 없이 방문하면 302로 /api/auth/google/start로 보낸다', async () => {
    const res = await get('/sso')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/api/auth/google/start')
  })

  it('redirect=/usage는 그대로 인코딩되어 보존된다', async () => {
    const res = await get('/sso?redirect=%2Fusage')
    expect(res.headers.get('Location')).toBe('/api/auth/google/start?redirect=%2Fusage')
  })

  it.each(['/sso', '/sso/', '/SSO', '/sso?x=1'])(
    'redirect=%s(자기참조)는 파라미터가 제거된다',
    async (raw) => {
      const res = await get('/sso?redirect=' + encodeURIComponent(raw))
      expect(res.headers.get('Location')).toBe('/api/auth/google/start')
    }
  )

  it('redirect=/ssomething처럼 접두사만 같은 무관한 경로는 오차단하지 않는다', async () => {
    const res = await get('/sso?redirect=' + encodeURIComponent('/ssomething'))
    expect(res.headers.get('Location')).toBe('/api/auth/google/start?redirect=' + encodeURIComponent('/ssomething'))
  })

  it('silent=1이 실려 와도 Location에 silent가 포함되지 않는다', async () => {
    const res = await get('/sso?silent=1')
    const location = res.headers.get('Location')
    expect(location).toBe('/api/auth/google/start')
    expect(location).not.toContain('silent')
  })

  it('silent=1 + redirect가 함께 와도 silent는 버려지고 redirect만 전달된다', async () => {
    const res = await get('/sso?silent=1&redirect=%2Fusage')
    const location = res.headers.get('Location')
    expect(location).toBe('/api/auth/google/start?redirect=%2Fusage')
    expect(location).not.toContain('silent')
  })

  it('redirect=https://evil.com(절대 URL)이 Location의 오리진을 바꾸지 못한다 — 쿼리값으로만 실린다', async () => {
    const res = await get('/sso?redirect=' + encodeURIComponent('https://evil.com'))
    const location = res.headers.get('Location')
    expect(location.startsWith('/api/auth/google/start')).toBe(true)
    expect(location).toBe('/api/auth/google/start?redirect=' + encodeURIComponent('https://evil.com'))
  })

  it('redirect=//evil.com(스킴 상대 URL)이 Location의 오리진을 바꾸지 못한다 — 쿼리값으로만 실린다', async () => {
    const res = await get('/sso?redirect=' + encodeURIComponent('//evil.com'))
    const location = res.headers.get('Location')
    expect(location.startsWith('/api/auth/google/start')).toBe(true)
    expect(location).toBe('/api/auth/google/start?redirect=' + encodeURIComponent('//evil.com'))
  })

  it('redirect가 빈 문자열이면 파라미터를 생략한다', async () => {
    const res = await get('/sso?redirect=')
    expect(res.headers.get('Location')).toBe('/api/auth/google/start')
  })

  // 이 테스트는 우리 계약이 아니라 Hono c.req.query()의 중복 키 semantics(첫 값을 문자열로 반환,
  // 배열이 아님)를 고정한다 — Hono 업그레이드로 이 동작이 배열 반환으로 바뀌면 sso.js의
  // typeof rawRedirect === 'string' 가드가 실제로 발동해 파라미터를 생략하게 되므로 사용자 영향은
  // 없지만, 이 테스트는 그 변화를 감지하기 위해 빨개진다(의도된 조기경보).
  it('Hono가 중복 키 redirect=a&redirect=b를 문자열 "a"로 반환하는 현재 동작을 고정한다', async () => {
    const res = await get('/sso?redirect=a&redirect=b')
    expect(res.headers.get('Location')).toBe('/api/auth/google/start?redirect=a')
  })

  it('응답에 Cache-Control: no-store를 붙인다', async () => {
    const res = await get('/sso')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('redirect가 512자를 초과하면 파라미터를 생략하고 302는 정상 반환한다', async () => {
    const longPath = '/' + 'a'.repeat(600)
    const res = await get('/sso?redirect=' + encodeURIComponent(longPath))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/api/auth/google/start')
  })

  it('redirect가 정확히 512자(경계값)면 그대로 유지된다', async () => {
    const boundaryPath = '/' + 'a'.repeat(511)
    expect(boundaryPath.length).toBe(512)
    const res = await get('/sso?redirect=' + encodeURIComponent(boundaryPath))
    expect(res.headers.get('Location')).toBe('/api/auth/google/start?redirect=' + encodeURIComponent(boundaryPath))
  })
})

describe('GET /sso — CRLF/제어문자 페이로드 방어', () => {
  // 오픈 리다이렉트/헤더 인젝션 방어의 핵심 불변식: redirect에 무엇이 오든 Location은 항상
  // '/api/auth/google/start'로 시작하고, 그 뒤에는 '?redirect='로 시작하는 단일 쿼리만 오며,
  // 그 문자열 전체에 원문 CR/LF/TAB가 섞여 있지 않다(encodeURIComponent가 전부 %XX로 이스케이프).
  function assertSafeLocation(location) {
    expect(typeof location).toBe('string')
    expect(location.startsWith('/api/auth/google/start')).toBe(true)
    const rest = location.slice('/api/auth/google/start'.length)
    expect(rest === '' || rest.startsWith('?redirect=')).toBe(true)
    // '?'가 두 번 나오면 별도 쿼리 파라미터가 밀수입됐다는 뜻 — 단일 쿼리만 허용.
    expect(rest.indexOf('?', 1)).toBe(-1)
    expect(location).not.toMatch(/[\r\n\t]/)
  }

  it.each([
    ['CRLF(%0d%0a)', '/x\r\ny'],
    ['TAB(%09)', '/x\ty'],
    ['헤더 인젝션 시도(/a%0d%0aLocation: https://evil.com)', '/a\r\nLocation: https://evil.com'],
    ['절대 URL', 'https://evil.com'],
    ['절대 URL + CRLF', 'https://evil.com\r\nLocation: https://evil2.com']
  ])('%s가 섞인 redirect는 Location에 원문으로 들어가지 않는다', async (_name, raw) => {
    const res = await get('/sso?redirect=' + encodeURIComponent(raw))
    assertSafeLocation(res.headers.get('Location'))
  })
})
