-- Migration number: 0022 	 2026-09-08T02:00:00.000Z
--
-- 공용 워크스테이션 축 레지스트리.
-- 설계 정본: docs/design/usage-shared-workstation-axes.md (PM 판정 3건 반영: rowKey 유지 / 시드 3건 / 명시적 meta)
--
-- Prometheus employee_id 라벨 중 "개인이 아니라 여러 명이 함께 쓰는 공용 PC"인 값을 관리자가 명시
-- 등록하는 테이블이다. 등록된 값은 어떤 회원 계정에도 귀속되지 않는다 —
-- mergeD1AndPromUsers가 그 값을 보유한 users 행으로 관측 엔트리를 consume하지 않고(사용량 0 +
-- shared_workstation_conflict 경고), 관측 엔트리는 별도 행으로 남아 총합이 보존된다(설계 §4.4).
-- ⚠️ users.employee_id 의 "그룹 계정"(= user_email, Claude 로그인 계정)과 다른 개념이다 —
--    이 테이블은 employee_id 축을, group_accounts 응답 필드는 user_email 축을 가리킨다(설계 §3.1).
-- ⚠️ 판정은 조회 시점에만 일어난다. usage_prom_daily(상류 라벨 그대로 적재)와 IDENTITY_VERSION은
--    이 테이블과 무관하며, 등록/해제는 재적재 없이 다음 요청부터 과거 구간까지 소급 반영된다(설계 §4.5).

CREATE TABLE usage_shared_workstations (
  employee_id   TEXT NOT NULL PRIMARY KEY
                CHECK (length(employee_id) BETWEEN 1 AND 64
                       AND employee_id NOT GLOB '*[^a-z0-9._%+-]*'),  -- EMPLOYEE_ID_RE와 같은 허용목록
                       -- GLOB 문자클래스에서 '-'는 맨 끝이라 리터럴, '%'는 GLOB 와일드카드가 아니라
                       -- 리터럴이다(migrations/0020 백필 조건과 같은 표현식).
                       -- ⚠️ NOT NULL을 명시하는 이유: SQLite는 rowid 테이블의 TEXT PRIMARY KEY에
                       --    NULL을 허용한다(명시하지 않으면 NULL 행이 들어갈 수 있다).
  label         TEXT,                      -- 사람이 읽는 이름("3층 공용 PC"). NULL 허용 — 표시 이름은
                                           -- label || employee_id 이며 관측 employee_name은 절대 쓰지
                                           -- 않는다(설계 §4.1-3, S14).
  note          TEXT,                      -- 자유 메모. NULL 허용
  registered_by TEXT,                      -- users.id(ULID). FK 없음 — 이 스키마 전체 관례.
                                           -- ⚠️ NULL 허용: 아래 시드 3건은 마이그레이션 유래라 행위자가
                                           --    없다. API로 등록된 행은 항상 채워진다.
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- 보조 인덱스 없음 — 조회 경로는 ① 전건 SELECT(≤수십 행, 읽기 경로가 Map으로 올린다) ② PK 단건
-- 조회 두 가지뿐이다. registered_by·created_at로 거르는 화면이 없다(쓰지 않는 구조를 만들지 않는다).

-- 시드 — 회사 담당자가 확인해 준 실측 공용 워크스테이션 3건(설계 §1-1).
--   employee_id="claude"  + 관측 employee_name="김도형" (user_email: claude@, ai@malgnsoft.com)
--   employee_id="malgn"   + 관측 employee_name="김덕조" (user_email: ai@malgnsoft.com)
--   employee_id="public"  + 관측 employee_name="이진화" (user_email: public@malgnsoft.com)
-- ⚠️ 'ai'는 employee_id가 아니라 user_email(그룹 계정)이므로 시드하지 않는다 — 이 테이블은
--    employee_id 축만 다룬다(설계 §3.2 경계).
-- ⚠️ 시드하는 이유(설계 §6.1의 "시딩 없음"을 PM이 뒤집음): 이 3개는 코드 상수가 아니라 감사되는
--    API로 편집되는 데이터이며, 시드가 없으면 배포 직후에도 오귀속 위험이 그대로 남는다.
--    PM이 --remote로 실측 확인함: SELECT ... FROM users WHERE employee_id IN
--    ('claude','malgn','public','ai') → 0건이라 0020 백필과 충돌하지 않는다(역방향 가드 §5.3의
--    "회원이 보유 중인 값"에 해당하지 않음).
-- label은 NULL로 둔다 — 관리자가 실제 위치·용도를 아는 사람이고, 그때까지 표시 이름은 employee_id
-- 자체로 폴백된다(관측 이름 "김도형"으로 폴백하지 않는 것이 이 설계의 핵심이다).
INSERT INTO usage_shared_workstations (employee_id, label, note, registered_by, created_at, updated_at) VALUES
  ('claude', NULL, 'migrations/0022 시드 — 회사 담당자 확인 공용 PC. 관측 employee_name="김도형"', NULL, '2026-09-08T02:00:00.000Z', '2026-09-08T02:00:00.000Z'),
  ('malgn',  NULL, 'migrations/0022 시드 — 회사 담당자 확인 공용 PC. 관측 employee_name="김덕조"', NULL, '2026-09-08T02:00:00.000Z', '2026-09-08T02:00:00.000Z'),
  ('public', NULL, 'migrations/0022 시드 — 회사 담당자 확인 공용 PC. 관측 employee_name="이진화"', NULL, '2026-09-08T02:00:00.000Z', '2026-09-08T02:00:00.000Z');

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(재실행 시 "table already
-- exists" 등 에러가 나도 별도 조치 불필요 — 러너가 애초에 재실행하지 않는다).
