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
