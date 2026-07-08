// Claude 모델 토큰 → USD "API 종량 환산값"(가상). 실청구액 아님.
// 대표님 실지출 = Claude Code 월 정액 구독($100/월, dashboard.js PLAN_MONTHLY_USD).
// 이 환산값은 정액 구독 대비 '절감효과' 산정 및 모델별 사용량 비교에만 쓴다.
// 단가: USD per 1M tokens. 2026 기준 표준 가격(요금제/할인 미반영).
// 모델 추가/단가 변동 시 이 파일만 수정.

const PRICING = {
  // family: [input, output, cacheWrite(5m), cacheRead]
  opus:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
}

// 모델명 → family. claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-... 등.
export function modelFamily(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  return 'sonnet' // 미매칭 폴백(보수적으로 중간 단가)
}

// 단일 모델 사용량 행 → 비용(USD). row: {input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens}
export function costForUsage(row) {
  const fam = modelFamily(row.model)
  const p = PRICING[fam]
  const M = 1_000_000
  const input = (row.input_tokens || 0) / M * p.input
  const output = (row.output_tokens || 0) / M * p.output
  const cacheWrite = (row.cache_creation_tokens || 0) / M * p.cacheWrite
  const cacheRead = (row.cache_read_tokens || 0) / M * p.cacheRead
  return {
    family: fam,
    matched: modelFamily(row.model) !== 'sonnet' || String(row.model || '').toLowerCase().includes('sonnet'),
    input, output, cacheWrite, cacheRead,
    total: input + output + cacheWrite + cacheRead,
  }
}

// model_usage 행 배열 → { models:[{model, family, total, ...토큰}], total_usd, total_tokens }
export function estimateCost(rows = []) {
  const models = rows.map((r) => {
    const c = costForUsage(r)
    return {
      model: r.model,
      family: c.family,
      matched: c.matched,
      input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0,
      cache_creation_tokens: r.cache_creation_tokens || 0,
      cache_read_tokens: r.cache_read_tokens || 0,
      total_tokens: (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_creation_tokens || 0) + (r.cache_read_tokens || 0),
      cost_usd: c.total,
    }
  })
  models.sort((a, b) => b.cost_usd - a.cost_usd)
  return {
    models,
    total_usd: models.reduce((s, m) => s + m.cost_usd, 0),
    total_tokens: models.reduce((s, m) => s + m.total_tokens, 0),
  }
}

// 일별 토큰(claude_token_stats: {date, model, tokens})을 단가로 환산.
// token_stats엔 토큰 종류 구분이 없어(총량=캐시 포함) 고정 단가를 곱하면 과대평가된다.
// → model_usage(누적, 토큰 종류 분해됨)에서 family별 '실효 평균단가'(누적비용/누적토큰)를 구해
//   그걸 토큰 총량에 곱한다. 누적과 이번달이 같은 단가 체계를 쓰므로 일관성 보장(이번달 ≤ 누적).
//
// effRates: estimateCost(modelUsage)로 구한 family별 {cost_usd, total_tokens} 맵. 없으면 폴백.
const FALLBACK_RATE = { opus: 1.5, sonnet: 0.4, haiku: 0.12 } // per 1M (실효단가 근사 폴백)

export function familyEffectiveRates(estimated) {
  const acc = {}
  for (const m of estimated.models || []) {
    const f = m.family
    if (!acc[f]) acc[f] = { cost: 0, tokens: 0 }
    acc[f].cost += m.cost_usd
    acc[f].tokens += m.total_tokens
  }
  const rates = {}
  for (const f of Object.keys(acc)) {
    rates[f] = acc[f].tokens > 0 ? acc[f].cost / acc[f].tokens * 1_000_000 : (FALLBACK_RATE[f] || FALLBACK_RATE.sonnet)
  }
  return rates
}

export function blendedCostForTokens(model, tokens, effRates) {
  const fam = modelFamily(model)
  const rate = (effRates && effRates[fam]) || FALLBACK_RATE[fam] || FALLBACK_RATE.sonnet
  return (tokens || 0) / 1_000_000 * rate
}

export { PRICING, FALLBACK_RATE }
