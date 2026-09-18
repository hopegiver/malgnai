-- Migration number: 0030
--
-- audit_logs.action CHECK에 'email.send' 1개를 추가하고, 같은 재작성 기회에
-- email_send 전용 멱등 UNIQUE 인덱스를 함께 만든다.
-- 설계 정본: docs/design/email-send-tool.md D3·D4
--
-- ⚠️ 액션 값은 0026 규율대로 **1개**만 추가한다 — 성공/실패 구분은 action을 늘리지 않고
--    Workers 로그 + Cloudflare Email Sending 로그로 본다(설계 §3.6).
--
-- ⚠️ 아래 CHECK 목록은 0026에서 **한 글자도 빠짐없이** 옮겨온 것이다. 이 마이그레이션은
--    DROP TABLE을 동반하므로 값 하나만 누락돼도 기존 감사기록이 CHECK 위반으로
--    유실되거나 복구가 필요해진다. 수정 시 반드시 직전 audit_logs 마이그레이션(=0026)을
--    열어 대조할 것.
--
-- SQLite(D1)는 CHECK를 ALTER로 바꿀 수 없어 0009·0018·0021·0023·0026과 동일 패턴
-- ("새 테이블 생성 → INSERT SELECT 복사 → DROP → RENAME → 인덱스 재생성")을 쓴다.
CREATE TABLE audit_logs_new (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'user.role_changed',
    'device_token.issued','device_token.revoked',
    'admin.cross_user_view',
    'oauth_client.registered',
    'oauth_refresh_token.reuse_detected',
    'admin.usage_sync',
    'user.employee_id_changed',
    'shared_workstation.changed',
    'auth.google',
    'email.send'
  )),
  target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
);
INSERT INTO audit_logs_new SELECT * FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

-- ⚠️⚠️ F-3(reviewer M-2) — 이 테이블의 인덱스는 이제 4개다(0026까지는 3개였다). 다음
--    audit_logs 마이그레이션(0031+)이 CHECK enum을 또 확장해 "DROP TABLE → 인덱스 재생성"
--    템플릿을 복사할 때, 아래 4개 CREATE INDEX/CREATE UNIQUE INDEX를 **전부** 함께
--    재생성할 것 — idx_audit_email_idem 하나만 빠뜨려도 email_send 멱등 UNIQUE가 무음으로
--    사라지고 중복 발송 차단 근거가 없어진다. 0009~0026의 "3개짜리" 템플릿을 그대로
--    복사하지 말고, 반드시 이 파일(0030)을 기준으로 대조할 것.
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
-- D4 — email_send 멱등성을 구조적으로 보장하는 부분 UNIQUE 인덱스.
-- action='email.send' 행에만 적용되므로 기존 다른 액션 행은 이 인덱스에 들어가지 않는다.
-- 같은 사용자가 같은 idempotencyKey로 두 번 INSERT하면 UNIQUE 위반으로 두 번째가 실패하고,
-- 감사 INSERT가 실패하면 발송도 하지 않는다(fail-closed)는 규약과 정확히 맞물려
-- "중복 메일 발송"이 원리적으로 불가능해진다.
-- U-5 확인 완료(backend-dev, node:sqlite로 실검증 — server/lib/email.test.js): json_extract
-- 기반 부분 UNIQUE 인덱스가 정상 생성되고 중복 INSERT 시 SQLITE_CONSTRAINT를 던진다.
-- (이 세션은 wrangler 사용이 금지되어 실제 D1 --local 적용까지는 확인하지 못했다 — node:sqlite는
-- D1과 동일한 SQLite 엔진이라 CREATE INDEX 문법 자체의 유효성은 이걸로 충분히 검증된다.)
CREATE UNIQUE INDEX idx_audit_email_idem
  ON audit_logs(actor_user_id, json_extract(metadata_json, '$.idempotencyKey'))
  WHERE action = 'email.send';
-- ⚠️ 위 4개가 "재생성 블록"이다 — 회귀 테스트: server/lib/email.test.js
-- "audit_logs에 명명된 인덱스가 정확히 4개다" (F-3 회귀 잠금).

-- 재실행 안전성: 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장한다(0026과 동일).
