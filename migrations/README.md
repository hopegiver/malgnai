# migrations/

스키마 **변경분**(기존 테이블 진화: `ALTER`/`DROP`/리네임, 새 인덱스 등)을 담는 곳.

## 왜 두 층인가
- `schema.sql`(루트) = 현재 스키마 **전체 그림**. 전부 `CREATE ... IF NOT EXISTS` 라 **재실행 안전**하지만, 그래서 **기존 테이블을 바꾸지 못한다**(이미 있으면 건너뜀).
- `migrations/NNN-이름.sql` = 기존 테이블을 실제로 바꾸는 **1회성 순차 변경**. `_migrations` 테이블이 적용 이력을 추적해 멱등.

## 워크플로 (테이블 변경 시)
1. `schema.sql` 을 새 목표 상태로 수정한다(= 새 컬럼/테이블의 최종 모습).
2. 기존 DB 를 그 상태로 옮기는 변경을 `migrations/NNN-무엇.sql` 로 추가한다(예: `ALTER TABLE x ADD COLUMN y ...`).
   - 새 테이블만 추가하는 경우엔 migration 없이 schema.sql 수정만으로 충분(다음 db:migrate 가 CREATE).
3. `pnpm run db:migrate` 로 라이브에 반영(자동 pre-migrate 백업 포함).

**대표 승인 = `schema.sql`(+ migration)의 git diff.** 웹서버 부팅과 MCP 는 스키마를 절대 만들지 않는다 —
부팅은 `verifySchema` 로 버전만 대조하고, 불일치면 "먼저 `pnpm run db:migrate`" 로 중단한다.

## 파일명 규칙
`001-add-x.sql`, `002-drop-y.sql` … 3자리 순번 + 짧은 설명. 파일명 오름차순으로 적용된다.
