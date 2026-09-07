-- Migration number: 0019 	 2026-09-07T08:03:14.000Z
--
-- 사용량 식별 축 전환: user_email(그룹 계정) → employee_id(개인) 1차키.
-- 설계 정본: docs/design/usage-employee-identity.md (docs/design/usage-prometheus-realtime.md rev.2의 식별 축 개정)
--
-- ⚠️ 이 마이그레이션은 usage_prom_daily를 재작성한다(SQLite는 PK를 ALTER로 못 바꾼다).
--    기존 행은 employee_id='' (미식별)로 보존 이전한다 — 값 자체는 여전히 유효한 Prometheus 유래
--    측정치이므로 버리지 않는다. 상류 보관기간(~37일) 안의 날짜는 Cron이 identity_version 불일치를
--    감지해 employee_id 축으로 자동 재적재하고(§18.4), 그보다 오래된 날짜는 미식별 상태로 계속 보인다.
-- ⚠️ 이 테이블에는 보조 인덱스·트리거·뷰·FK가 없다(0017 참고) — 재작성 후 복구할 부수 객체가 없다.

CREATE TABLE usage_prom_daily_new (
  day_at             TEXT    NOT NULL,               -- 'YYYY-MM-DD' (UTC 완결일)
  employee_id        TEXT    NOT NULL DEFAULT '',    -- Prometheus employee_id 라벨(소문자). '' = 미식별
  user_email         TEXT    NOT NULL DEFAULT '',    -- Prometheus user_email 라벨(그룹 계정, 소문자). '' = 라벨 없음
  employee_name      TEXT,                           -- 디코드된 표시 이름(없으면 NULL)
  session_count      INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (day_at, employee_id, user_email)
);

-- 레거시 행 보존 이전: 그 시점엔 employee_id를 몰랐으므로 전부 미식별('')로 들어간다.
INSERT INTO usage_prom_daily_new
  (day_at, employee_id, user_email, employee_name, session_count,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
SELECT day_at, '', user_email, employee_name, session_count,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
  FROM usage_prom_daily;

DROP TABLE usage_prom_daily;
ALTER TABLE usage_prom_daily_new RENAME TO usage_prom_daily;

-- 커버리지 마커에 "이 날짜가 어떤 식별 축으로 적재됐는가"를 추가한다.
-- 'v0' = employee_id 이전(레거시). 현재 코드 상수 IDENTITY_VERSION='v1'과 다르므로 적재 대상 판정에서
-- 재적재 대상이 된다(읽기 판정에는 쓰지 않는다 — §9.2).
ALTER TABLE usage_prom_sync_days ADD COLUMN identity_version TEXT NOT NULL DEFAULT 'v0';

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다. 위 문장은 IF NOT EXISTS를
-- 쓰지 않는다 — 재작성 절차에서 IF NOT EXISTS는 "이미 반쯤 적용된 상태"를 조용히 통과시켜 더 나쁜
-- 결과를 만든다(중간 상태로 남으면 러너가 실패를 보고하고 사람이 확인하는 편이 안전하다).
