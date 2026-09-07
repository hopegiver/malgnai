-- Migration number: 0017 	 2026-09-03T00:00:00.000Z
--
-- usage_prom_daily / usage_prom_sync_days — Prometheus 유래 "사용자×완결일" 롤업 캐시 신규 2테이블.
-- 설계 정본: docs/design/usage-prometheus-realtime.md §17, docs/architecture.md §0 결정29(개정).
--
-- ⚠️ usage_daily(§3.12, 자체수집 유래)와는 완전히 별개 테이블이다. 두 테이블을 JOIN하거나 UNION하지
-- 말 것 — 소스가 다르고 usage_daily는 더 이상 신뢰 소스가 아니다(§0.1). 관리자 사용량 라우트는
-- usageDailyDao를 import조차 하지 않는다(오염 차단을 구조로, §17.2b).
--
-- ⚠️ usage_prom_daily에는 완결된 UTC 일자만 들어간다(day_at < 오늘 UTC). 부분일은 절대 저장하지
-- 않는다(W1 불변식, §19·§20.3) — 쓰기 경로는 server/lib/usage-rollup.js·server/dao/usage-prom-daily.js
-- 뿐이고, 관리자 라우트(GET, 읽기 전용)는 이 테이블에 쓰지 않는다.
--
-- 재활용이 아니라 신규 테이블인 이유(§17.2, 요약): ① 그레인이 user_id가 아니라 user_email이라
-- 허브에 계정이 없는 Prometheus-only 사용 주체를 usage_daily의 PK로는 담을 수 없다. ② usage_daily의
-- tool_calls 등 NOT NULL DEFAULT 0 컬럼에 Prometheus가 못 주는 값을 넣으면 "모른다(null)"가
-- "0건"으로 왜곡된다. ③ source 컬럼 추가안은 PK 확장을 강제해 POST /api/sessions 인입 경로 수정이
-- 필요해지므로 "자체수집 경로 무수정" 경계(§6.3)를 위반한다.
--
-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다. 만에 하나 수동으로 다시
-- 실행되는 경우에도 CREATE TABLE IF NOT EXISTS라 "table already exists" 재충돌이 나지 않는다.

CREATE TABLE IF NOT EXISTS usage_prom_daily (
  day_at             TEXT    NOT NULL,               -- 'YYYY-MM-DD' (UTC 완결일)
  user_email         TEXT    NOT NULL,               -- Prometheus user_email 라벨, 소문자 정규화 저장
  employee_name      TEXT,                           -- 최초 관측 employee_name (없으면 NULL)
  session_count      INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (day_at, user_email)
);
-- 인덱스는 PK 하나뿐이다(§17.4) — 선두가 day_at이라 모든 읽기(WHERE day_at BETWEEN ?)와 모든 쓰기
-- 단위(DELETE WHERE day_at = ?)가 PK 인덱스로 그대로 커버된다. 보조 인덱스(user_email, day_at)는
-- 지금 이를 쓰는 읽기 경로가 없어 추가하지 않는다 — 드릴다운의 과거 구간을 캐시에서 읽게 되면
-- (R10) 그때 스키마 변경 없이 인덱스만 추가한다.

CREATE TABLE IF NOT EXISTS usage_prom_sync_days (
  day_at             TEXT    NOT NULL,   -- 'YYYY-MM-DD' (UTC 완결일)
  agg_mode           TEXT    NOT NULL,   -- 적재 당시 AGG_MODE('increase'). 현재 값과 다르면 재적재 대상
  norm_version       TEXT    NOT NULL,   -- 값 정규화 로직 버전(§4.6). 규칙이 바뀌면 올려 재적재 유도
  user_rows          INTEGER NOT NULL,   -- 그날 적재된 사용자 행 수(0이면 "사용량 없는 날"로 확정)
  unknown_types_json TEXT,               -- 그날 관측된 미지의 type 라벨 배열 JSON, 없으면 NULL (§4.6-5)
  fetched_at         TEXT    NOT NULL,   -- ISO8601 UTC — 이 날짜를 상류에서 가져온 시각
  PRIMARY KEY (day_at)
);
-- "이 UTC 일자는 적재가 끝났다"를 선언하는 커버리지 마커. 이 테이블이 없으면 "그날 아무도 안
-- 썼다"(usage_prom_daily에 그 날짜 행이 0개)와 "그날을 아직 못 받았다"를 구분할 수 없어, 사용량
-- 0인 날(주말·연휴)을 영원히 재질의하게 된다(§17.3). 인덱스 없음 — 모든 조회가 PK(day_at) 단독
-- 또는 range이며 PK 인덱스가 그대로 커버한다.
