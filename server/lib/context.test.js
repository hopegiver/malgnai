// computeProjectState의 취소 제외 회귀 잠금 (reviewer M-6).
//
// server/lib/context.js는 이번 wbs-cancelled-status 변경에서 수정되지 않았다. 취소된 최상위
// WBS 항목이 project_get_context의 state.progress에서 빠지는 것은 이 함수가 wbsList를
// { includeDone: true }로만 호출하고 includeCancelled를 넘기지 않기 때문에 wbsList 쪽 기본
// 숨김(server/lib/wbs.js:145)에 우연히 기대는 창발적 동작이다 — context.js 자체는 "취소"라는
// 개념을 전혀 모른다.
//
// 이 테스트는 그 우연한 동작이 지금 이 순간 성립함을 잠근다. 누군가 나중에 context.js:56에
// includeCancelled:true를 추가하면(예: "AI가 취소도 알아야 한다"는 이유로) 이 테스트가
// state.progress===100 대신 50을 받아 즉시 실패해야 한다.
import { describe, it, expect } from 'vitest'
import { computeProjectState } from './context.js'

function mkWbsRow(id, status, progress) {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id,
    parent_id: null,
    depth: 0,
    seq: 0,
    title: id,
    description: null,
    status,
    responsible_team: null,
    assignee_agent_name: null,
    start_date: null,
    end_date: null,
    completed_date: null,
    progress,
    session_id: null,
    idempotency_key: null,
    created_at: now,
    updated_at: now,
    project_id: 'proj-1',
    user_id: 'user-1'
  }
}

// works/issues/wbs 세 쿼리가 전부 db.prepare(sql).bind(...).all() 형태를 거치므로(server/lib/
// works.js:69, issues.js:93-95, wbs.js:108-110) sql 텍스트로 테이블을 구분해 각각의 고정
// fixture를 돌려주는 가벼운 fake db. works/issues는 이 테스트의 관심사가 아니라 빈 결과로 스텁한다.
function makeFakeDb({ wbsRows = [], worksRows = [], issuesRows = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind: (..._args) => ({
          all: async () => {
            if (sql.includes('FROM works')) return { results: worksRows }
            if (sql.includes('FROM issues')) return { results: issuesRows }
            if (sql.includes('FROM wbs_items')) return { results: wbsRows }
            throw new Error(`computeProjectState 테스트 fake db가 예상 못한 쿼리: ${sql}`)
          }
        })
      }
    }
  }
}

describe('computeProjectState — state.progress의 취소 제외 (reviewer M-6, 가장 위험한 미커버 항목)', () => {
  it('취소된 최상위 1개 + 완료된 최상위 1개 → state.progress===100 (취소가 분모에 포함되면 50이 된다)', async () => {
    const db = makeFakeDb({
      wbsRows: [mkWbsRow('cancelled-root', 'cancelled', 0), mkWbsRow('done-root', 'done', 100)]
    })
    const { ok, state } = await computeProjectState(db, 'proj-1')
    expect(ok).toBe(true)
    expect(state).not.toBeNull()
    // (0+100)/2=50이 아니다 — 취소된 최상위는 wbsList 기본 필터로 빠지고 done만 남아 100이다.
    // context.js:56이 includeCancelled:true를 받도록 바뀌는 순간 이 값이 50으로 무너진다.
    expect(state.progress).toBe(100)
  })

  it('최상위 전부가 취소면 wbs 섹션이 빈 배열이 되어 progress는 null(noWbs)이다(경계값 대조군)', async () => {
    const db = makeFakeDb({
      wbsRows: [mkWbsRow('c1', 'cancelled', 0), mkWbsRow('c2', 'cancelled', 50)]
    })
    const { ok, state } = await computeProjectState(db, 'proj-1')
    expect(ok).toBe(true)
    // work/issue도 없고 wbs도 전부 취소로 숨겨져 rootWbsItems.length===0 → noWbs 조건까지
    // 전부 참이면 buildState는 state 자체를 null로 반환한다(server/lib/context.js:35).
    expect(state).toBeNull()
  })
})
