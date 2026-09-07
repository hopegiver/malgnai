-- Migration number: 0020 	 2026-09-07T09:00:00.000Z
--
-- 사용량 식별 축의 명시적 연동 컬럼 도입.
-- 설계 정본: docs/design/usage-employee-identity-linking.md
--   (docs/design/usage-employee-identity.md §3.2 "employee_id = users.email 로컬파트" 규칙을 대체한다)
--
-- users.employee_id 는 Prometheus 메트릭 라벨 employee_id(직원 PC의 OTEL_RESOURCE_ATTRIBUTES
-- employee.id)와 "글자 그대로 같은 값"이다. ⚠️ 사번이 아니다.
-- NULL = 미연동(그 사용자에게 귀속할 관측 축이 아직 없음). '' 는 쓰지 않는다 —
-- usage_prom_daily.employee_id 의 '' 는 "상류에 라벨이 없었다"는 다른 뜻이라 섞이면 안 된다.
--
-- ⚠️ users 테이블은 재작성하지 않는다(인증 뿌리 테이블 + 이미 배포된 옛 코드와의 하위호환).
--    따라서 CHECK 제약은 두지 않고 형식 검증은 API 계층이 담당한다.

ALTER TABLE users ADD COLUMN employee_id TEXT;

-- 부분 UNIQUE 인덱스: 두 사용자가 같은 관측 축을 동시에 보유하는 상태를 DB 수준에서 봉쇄한다
-- (설계 §3.3 로컬파트 충돌 fail-closed 런타임 검사를 이 제약이 대체한다).
-- NULL은 색인하지 않으므로 미연동 사용자가 몇 명이든 공존한다.
CREATE UNIQUE INDEX idx_users_employee_id ON users(employee_id) WHERE employee_id IS NOT NULL;

-- 백필: 컷오버 시점의 귀속 결과를 현행(로컬파트 컨벤션 매칭)과 완전히 동일하게 만든다.
-- 조건 두 가지:
--   (a) instr(email,'@') > 1  → '@'가 있고 로컬파트가 비어 있지 않다
--   (b) NOT GLOB '*[^a-z0-9._%+-]*' → 소문자 로컬파트가 EMPLOYEE_ID_RE(=/^[a-z0-9._%+-]+$/)와
--       같은 허용목록 안에 있다. GLOB 문자클래스에서 '-'는 맨 끝이라 리터럴, '%'는 GLOB에서
--       와일드카드가 아니라 리터럴이다.
-- ⚠️ 이 UPDATE가 UNIQUE 위반으로 실패하면 그것은 "로컬파트 충돌이 실재한다"는 신호다(실측 0건).
--    위 CREATE UNIQUE INDEX를 백필보다 먼저 두는 이유가 이것이다 — 조용히 성공하는 대신 요란하게
--    실패해 사람이 확인하게 만든다.
-- ⚠️ updated_at은 건드리지 않는다. 스키마 백필은 계정 속성의 변경이 아니라 표현의 이관이며,
--    47행의 updated_at을 일괄로 밀면 "최근 변경된 계정" 판독이 통째로 망가진다.
UPDATE users
   SET employee_id = lower(substr(email, 1, instr(email, '@') - 1))
 WHERE instr(email, '@') > 1
   AND lower(substr(email, 1, instr(email, '@') - 1)) NOT GLOB '*[^a-z0-9._%+-]*';

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(재실행 시 "duplicate
-- column" 등 에러가 나도 별도 조치 불필요 — 러너가 애초에 재실행하지 않는다).
