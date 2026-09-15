// GET /sso 회귀 테스트 — Worker 302 라우트로 전환됐음을 증명한다(app/pages/sso.vue SPA 구현
// 폐기, PM 지시서 "배경" 참고). 하우스 스타일은 server/api/oauth.js의 registerWellKnownRoutes()와
// 동일 패턴이라, 이 파일도 registerSsoRoute()를 새 Hono 인스턴스에 직접 등록해 라우트 단위로만
// 검증한다(server/index.js 전체 디스패처는 이 파일의 범위 밖).
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

  it.each([
    ['/sso', '/sso'],
    ['/sso/', '/sso/'],
    ['/SSO', '/SSO'],
    ['/sso?x=1', encodeURIComponent('/sso?x=1')]
  ])('redirect=%s(자기참조)는 파라미터가 제거된다', async (raw) => {
    const res = await get('/sso?redirect=' + encodeURIComponent(raw))
    expect(res.headers.get('Location')).toBe('/api/auth/google/start')
  })

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

  it('redirect가 문자열이 아니거나(배열) 비어있으면 파라미터를 생략한다', async () => {
    const res1 = await get('/sso?redirect=')
    expect(res1.headers.get('Location')).toBe('/api/auth/google/start')

    const res2 = await get('/sso?redirect=a&redirect=b')
    // Hono의 c.req.query()는 중복 키에서 첫 값을 문자열로 반환한다 — 배열이 아니므로 그대로 전달된다.
    expect(res2.headers.get('Location')).toBe('/api/auth/google/start?redirect=a')
  })

  it('응답에 Cache-Control: no-store를 붙인다', async () => {
    const res = await get('/sso')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
