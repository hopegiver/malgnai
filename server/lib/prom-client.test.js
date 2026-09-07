// 최소 단위테스트(사람 승인 결정2, Cloudflare Tunnel 채택에 따른 https fail-closed) — 순수 함수
// validateUpstreamScheme()만 대상으로 한다(네트워크 호출 없음, server/lib/usage-prom.test.js와
// 같은 규약 — 외부 의존 없이 도는 순수 함수만 단위테스트, 통합/E2E는 실제 wrangler dev로 확인).
import { describe, it, expect } from 'vitest'
import { validateUpstreamScheme, UpstreamError } from './prom-client.js'

describe('validateUpstreamScheme — GRAFANA_BASE_URL 스킴 fail-closed(결정2)', () => {
  it('https면 GRAFANA_ALLOW_INSECURE_HTTP 여부와 무관하게 항상 통과', () => {
    expect(() => validateUpstreamScheme({}, 'https://grafana.example.com')).not.toThrow()
    expect(() => validateUpstreamScheme({ GRAFANA_ALLOW_INSECURE_HTTP: 'true' }, 'https://grafana.example.com')).not.toThrow()
  })

  it('http이고 GRAFANA_ALLOW_INSECURE_HTTP가 없으면(기본값 = 프로덕션 안전 기본) fail-closed', () => {
    expect(() => validateUpstreamScheme({}, 'http://14.0.87.123:3000')).toThrow(UpstreamError)
    try {
      validateUpstreamScheme({}, 'http://14.0.87.123:3000')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError)
      expect(err.reason).toBe('insecure_scheme')
    }
  })

  it('http이어도 GRAFANA_ALLOW_INSECURE_HTTP=true(.dev.vars 로컬 전용)면 통과', () => {
    expect(() => validateUpstreamScheme({ GRAFANA_ALLOW_INSECURE_HTTP: 'true' }, 'http://14.0.87.123:3000')).not.toThrow()
  })

  it('"true" 이외의 값(오타·다른 truthy 문자열)은 허용하지 않는다 — 정확히 문자열 "true"만', () => {
    expect(() => validateUpstreamScheme({ GRAFANA_ALLOW_INSECURE_HTTP: '1' }, 'http://14.0.87.123:3000')).toThrow(UpstreamError)
    expect(() => validateUpstreamScheme({ GRAFANA_ALLOW_INSECURE_HTTP: 'TRUE' }, 'http://14.0.87.123:3000')).toThrow(UpstreamError)
  })

  it('파싱 불가능한 URL은 invalid_upstream_url reason으로 던진다(상류로 나가지 않는다)', () => {
    try {
      validateUpstreamScheme({}, 'not a url')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError)
      expect(err.reason).toBe('invalid_upstream_url')
    }
  })
})
