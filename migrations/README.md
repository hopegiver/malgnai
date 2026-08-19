# migrations/

D1 스키마 변경 이력. **wrangler 표준 마이그레이션 체계를 그대로 정본으로 사용**한다(architecture.md
§9.1) — 별도 `schema.sql` 단일 정본 + 커스텀 migrate 스크립트 조합(옛 로컬 sqlite 제품 방식)은 더
이상 쓰지 않는다. 설계 근거·테이블 정의 정본은 `docs/schema.sql`(문서), 이 디렉터리는 그 정의를
실제로 D1에 적용하는 순차 변경 파일들이다.

## 워크플로 (스키마 변경 시)

1. `wrangler d1 migrations create malgnai-hub <설명>` → `migrations/000N_<설명>.sql` 생성.
2. 그 파일에 `CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX` 등을 작성한다.
   - **forward-only**: 이미 적용된 파일은 절대 수정하지 않는다(체크섬으로 재실행 방지). 되돌려야
     하면 되돌리는 새 마이그레이션을 추가한다.
   - MySQL과 달리 SQLite(D1)는 `ALTER TABLE ... ADD COLUMN`에 `IF NOT EXISTS`가 없다 — 일반
     `ADD COLUMN`으로 작성한다(마이그레이션 러너가 체크섬으로 1회만 실행하므로 재실행 자체가
     일어나지 않는다).
3. 로컬 적용: `wrangler d1 migrations apply malgnai-hub --local` (= `pnpm run db:migrations:apply:local`)
4. 원격(운영) 적용: `wrangler d1 migrations apply malgnai-hub --remote` (= `pnpm run db:migrations:apply:remote`)
   — **devops 단계에서만 실행**. backend-dev는 로컬에만 적용하고 원격 적용은 하지 않는다.

## 파일명 규칙

`wrangler d1 migrations create`가 자동으로 `000N_설명.sql`(4자리 순번 + 설명) 형식으로 만들어준다.
번호 오름차순으로 적용된다.

## 현재 마이그레이션

- `0001_init_v1_schema.sql` — v1 전체 초기 스키마(users/repositories/projects/decisions/issues/works/
  project_states/device_tokens/device_pairings/refresh_tokens/audit_logs/wbs_items/sessions/
  session_agent_usage/usage_daily + FTS5 trigram 검색 가상테이블·트리거). 상세 설계 근거는
  파일 상단 주석과 `docs/architecture.md` §0/§3 참고.
- `0002_add_refresh_token_revoke_reason.sql` — `refresh_tokens.revoke_reason` 컬럼 추가. 회전
  직후 grace window(10초, `REUSE_GRACE_MS`) 이내 stale 토큰 재사용을 탈취로 오판하지 않기 위함
  (사내 private 프로젝트 ~/workspace/malgnai에서 검증된 패턴 이식, `server/api/auth.js` 참고).
- `0003_drop_project_states.sql` — `project_states` 테이블 폐기(2026-07-28 전면 개명 + state
  즉석계산 전환, `docs/mcp-tools.md` §4.1/§5, `docs/schema.sql` §3.7). `update_project_state`
  MCP 도구도 함께 제거됐다(`mcp/agent.js`).
- `0004_add_next_action_to_works.sql` — `works.next_action` 컬럼 추가([문서 갭 보완] `work_record`가
  이미 받고 있던 `nextAction` 입력을 저장할 전용 컬럼이 최초 스키마에 없었다 — `docs/schema.sql`
  §3.6 참고). `project_get_context`/`project_bootstrap`의 `state.nextAction` 즉석계산이 이 컬럼을
  읽는다(`server/lib/context.js`).
- `0011_slim_sessions_usage_daily.sql` — `sessions`(`result` 컬럼 삭제, `summary` 500자→120자 캡)/
  `session_agent_usage`(테이블 폐기, 대체 없음)/`usage_daily`(PK `(user_id,project_id,day_at,model)`
  → `(user_id,day_at)`로 축소, `project_id`/`model` 컬럼 제거) 슬리밍(2026-08-19, `docs/schema.sql`
  §3.10~3.12, `docs/architecture.md` §0 결정24·25). `POST /api/sessions` 미구현으로 로컬 D1 기준
  세 테이블 전부 0행임을 `COUNT(*)`로 확인한 뒤 DROP+CREATE로 처리(0010과 동일 관례).
