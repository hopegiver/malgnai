-- Migration number: 0016 	 2026-08-28T09:30:00.000Z
--
-- agent_scores(user_id+agent_name 스코프) 테이블 폐기 — catalog_scores(catalog_item_version_id
-- 스코프)로 통합(architecture.md §0 결정 갱신, 정본 decision `01m13thq2gbc0hw6tcc4yqh2sq`,
-- malgnai-hub projectId `01m0vr55135n2ychx4w5d3rj1x`). agent_score_record/agent_get_context는
-- 더 이상 이 테이블을 참조하지 않는다(server/lib/agent-scores.js, server/lib/agent-context.js).
-- agent_learnings/agent_learning_record는 이번 변경과 무관하며 그대로 유지된다.
--
-- SQLite(D1)는 CREATE TABLE에 IF NOT EXISTS를 관용적으로 붙이듯 DROP TABLE/INDEX에도
-- IF EXISTS를 붙이지만, 마이그레이션 러너가 체크섬으로 1회만 실행함을 보장하므로 재실행 시
-- 별도 조치는 불필요하다(migrations/README.md, 0004/0005 파일과 동일 관례).
--
-- ===== BACKFILL BEGIN (사용자 승인 시에만 유지 — 승인 전이면 이 블록을 통째로 삭제해도
-- 파일은 유효하다. 대상: 프로덕션 agent_scores 4행 중 트레이너 3행. `__schema-probe-evaluator`
-- 행(테스트 산출물, 대응 catalog_item 없음)은 백필 대상에서 제외한다.
--
-- 매핑 근거: 각 점수를 "채점 시점(agent_scores.created_at)에 현행이던(synced_at ≤ created_at
-- 중 최댓값) catalog_item_versions 행"에 귀속시킨다(이번 변경의 목적 — "이 버전이 실제로
-- 개선됐나"를 보려면 채점 당시 실제로 존재했던 버전에 점수가 붙어야 한다).
--   trainer catalog_items.id = 01kz8w95nsfvcw59jaj23tk942
--   trainer catalog_item_versions(synced_at DESC):
--     01m0zkq6x51k63erwsev3ya7f7 @ 2026-08-26T18:01:06.213Z
--     01m0y8dc2ngm9yxt0w4pkafjh0 @ 2026-08-26T05:24:15.061Z
--     01m0x1achcky14hg25j2w5gw95 @ 2026-08-25T18:01:02.764Z
--     01m0vqcf5sz8xwy5b43vhs4wsm @ 2026-08-25T05:48:10.809Z
--     01kz8w95st6ppw8808yejkykaf @ 2026-08-05T11:52:29.754Z
--   agent_scores 01m0y0ph0b47mmv86qhrmf5113(69.9 @ 2026-08-26T03:09:26.411Z)
--     → 최댓값 synced_at ≤ 03:09:26 = 01m0x1achcky14hg25j2w5gw95(2026-08-25T18:01:02.764Z)
--   agent_scores 01m13fdzj8xqmk4549343a56t6(87.2 @ 2026-08-28T06:03:07.208Z)
--     → 최댓값 synced_at ≤ 06:03:07 = 01m0zkq6x51k63erwsev3ya7f7(2026-08-26T18:01:06.213Z)
--   agent_scores 01m13h0b86df2wxgee6cp8jqg2(91.75 @ 2026-08-28T06:30:37.574Z)
--     → 최댓값 synced_at ≤ 06:30:37 = 01m0zkq6x51k63erwsev3ya7f7(2026-08-26T18:01:06.213Z, 같은 버전)
--
-- rater_type='evaluator', verified=1(원본이 evaluator 채점이었으므로), rater_id는 원본 4행 전부의
-- user_id(01kz8rm6azn7xg7d3e23a3mx47). note는 evaluator_note/improvement_note를 출처가 구분되게
-- 병합([평가자 코멘트]/[개선 제안] 절 표기). id는 사전 발급한 ULID(하우스 스타일, 소문자).
--
-- [이식성] VALUES가 아니라 `SELECT ... WHERE EXISTS(...)`로 감싼다 — 참조하는
-- catalog_item_version_id는 프로덕션 D1에만 존재하는 값이라, 로컬/타 개발자 D1처럼 그 행이 없는
-- 환경에서 그대로 VALUES INSERT를 쓰면 FK 제약 위반으로 마이그레이션 전체가 실패한다. EXISTS
-- 가드로 감싸면 해당 버전 행이 없는 환경에서는 조용히 0건 삽입(no-op)되고, 실제 대상 행이 있는
-- 프로덕션에서만 실질적으로 백필된다 — DROP 이하 구문은 모든 환경에서 항상 적용됨.
-- NOT EXISTS(id로 자기 자신 중복확인)까지 더해 재실행에도 안전하게(멱등) 만든다.

INSERT INTO catalog_scores (id, catalog_item_version_id, overall_score, dimension_scores, rater_type, rater_id, verified, note, created_at)
SELECT
  '01m13tyr1nn9pvbtjc77ab8y62',
  '01m0x1achcky14hg25j2w5gw95',
  69.9,
  '{"basicPerformance":79,"evalSet":70,"successRate":0,"costEfficiency":100,"requirementUnderstanding":14,"scopeManagement":10,"accuracy":24,"verificationQuality":12,"riskAwareness":6,"reportClarity":8,"outputEfficiency":5}',
  'evaluator',
  '01kz8rm6azn7xg7d3e23a3mx47',
  1,
  '[평가자 코멘트]
vue-zero utils.js 전역 로딩 절차 정정건. 강점: 정확도 24/25 — 문서의 모든 기술적 주장이 프로덕션 3종(malgnuniv·malgnhrd·malgnsales) 실물과 일치했고, JS 시맨틱(일반 스크립트 function 선언=window 속성, const/let은 아님, 모듈 최상위 선언은 모듈 스코프)도 정확. 약점: 교차파일 정합 스윕 미실시로 agents/frontend-dev.md:54의 동일 결함(composables/index.js 등록 지시)이 남아 정본과 정면 모순 발생. 상시 로드되는 에이전트 MD 쪽이 오지시를 더 많이 노출한다는 점을 리스크로 식별하지 못함. 실전성공률은 표본 n=1이라 저신뢰 지표.

[개선 제안]
근본 원인은 절차 부재가 아니라 이미 보유한 교훈의 미적용 — trainer의 최근 학습 이력에 "배타성 문장을 새로 넣을 때는 같은 정책을 서술한 다른 MD를 같은 라운드에서 함께 고친다", "지시받은 줄 번호만 고치면 같은 줄의 다른 위반을 놓친다"가 이미 있다. 개선안: agents/trainer.md 자기검증 체크리스트에 "정본(knowledge/skill)의 절차를 바꿨으면, 그 절차를 인용·요약하는 지점을 주제어로 malgn-agent 전역 grep해 같은 커밋에서 함께 정정하고 잔존 0건을 확인한다 — 특히 상시 로드되는 agents/*.md는 온디맨드 knowledge보다 오지시 노출이 크므로 우선 대상이다" 1줄 추가. 검증 커맨드도 함께 명시(옛 절차의 고유 문자열로 grep).',
  '2026-08-26T03:09:26.411Z'
WHERE EXISTS (SELECT 1 FROM catalog_item_versions WHERE id = '01m0x1achcky14hg25j2w5gw95')
  AND NOT EXISTS (SELECT 1 FROM catalog_scores WHERE id = '01m13tyr1nn9pvbtjc77ab8y62');

INSERT INTO catalog_scores (id, catalog_item_version_id, overall_score, dimension_scores, rater_type, rater_id, verified, note, created_at)
SELECT
  '01m13tyr1nz4rnprkgkwd3mzq4',
  '01m0zkq6x51k63erwsev3ya7f7',
  87.2,
  '{"basicPerformance":87,"evalSet":80,"successRate":100,"costEfficiency":100,"requirementUnderstanding":14,"scopeManagement":12,"accuracy":22,"verificationQuality":16,"riskAwareness":9,"reportClarity":9,"outputEfficiency":5}',
  'evaluator',
  '01kz8rm6azn7xg7d3e23a3mx47',
  1,
  '[평가자 코멘트]
malgnai-hub 의존 제거 마이그레이션(59파일 +740/-2531) 채점. 강점: 정확도 22/25 — 검증한 모든 주장이 원문과 일치했고(21개 memory:user, 죽은 glob 0, 삭제범위 일치, README 카운트 37/43 실측 일치), Phase 0의 미확인 사실(CLAUDE_CODE_DISABLE_AUTO_MEMORY가 subagent memory도 끄는가)을 1차출처(sub-agents.md:564)로 확인한 뒤 그 위에 레인A 비활성 분기를 10개 파일에 일관 배치했다. 산출효율 5/5 — 순감축 -1791줄, 신규 스크립트 0. 약점: 변경범위 12/15, 검증품질 16/20 — 교차파일 일관성 미확인. common-output-storage-and-path-management/SKILL.md의 §2(L110)를 신규 규약으로 고치면서 같은 파일 §3(L129) 파일명 규칙표의 "의사결정" 행을 구 규약(decision-<주제>-YYYY-MM-DD.md, docs/ 직하)으로 남겨 한 파일 안에서 상충시켰다. 파일 단위로 수정하고 파일 내부 정합을 다시 읽지 않은 패턴.

[개선 제안]
1) [필수] SKILL.md:129 ''의사결정'' 행을 docs/decisions/<NNN>-<slug>.md로 교체하고 §3 형식문장에 결정문서 예외 명시 — 방치 시 §3을 따라 쓴 결정문서가 docs/ 직하에 놓여 전 에이전트 회수명령 grep -ri docs/decisions/ STATUS.md에 걸리지 않아 레인B 회수 완결성이 조용히 깨진다. 2) [필수] bin/check-output-conventions.mjs(148/243/292)의 decision- 접두어 규칙을 신규 규약과 정합화하거나 적용제외 명시. 3) [절차] 한 파일의 일부 절만 고칠 때 그 파일 전체를 다시 읽어 같은 개념이 다른 절에 다른 규약으로 서술돼 있는지 확인하는 단계를 추가 — 이번 결함은 grep 완료판정(hub 토큰 0건)으로는 잡히지 않는 유형이다. 규약을 바꾸는 변경에서는 ''옛 규약 문자열''로도 역grep한다.',
  '2026-08-28T06:03:07.208Z'
WHERE EXISTS (SELECT 1 FROM catalog_item_versions WHERE id = '01m0zkq6x51k63erwsev3ya7f7')
  AND NOT EXISTS (SELECT 1 FROM catalog_scores WHERE id = '01m13tyr1nz4rnprkgkwd3mzq4');

INSERT INTO catalog_scores (id, catalog_item_version_id, overall_score, dimension_scores, rater_type, rater_id, verified, note, created_at)
SELECT
  '01m13tyr1n00arah91ykw0y2yd',
  '01m0zkq6x51k63erwsev3ya7f7',
  91.75,
  '{"basicPerformance":92,"evalSet":92.86,"successRate":83.33,"costEfficiency":100,"previousScore":87.2}',
  'evaluator',
  '01kz8rm6azn7xg7d3e23a3mx47',
  1,
  '[평가자 코멘트]
malgnai-hub→Claude Code 메모리 마이그레이션 2차(후속) 채점. bin/calc-training-scorecard.mjs 산출. 1차 87.2 → 91.75(+4.55, threshold ±5 기준 정체 판정이나 실질 개선). 강점: 리스크 인지 10/10 — OS 스케줄러 등록이 플러그인 업데이트로 사라지지 않는다는 점을 잡아 CHANGELOG에 launchd/schtasks/크리덴셜 수동 정리 경로를 정확한 실제 상수로 기재. 필수수정을 한쪽만 패치하지 않고 SKILL §1·§3·체크리스트·검사 스크립트·lane B 정본 5곳으로 수렴시켰다.

[개선 제안]
약점 2건. ①검증 품질 17/20 — 결정문서 규약처럼 규칙을 새로 만든 변경에 회귀 픽스처를 저장소에 남기지 않아, 다음 회차가 같은 6케이스를 매번 수동 재구성해야 한다. 규칙 신설 시 픽스처 상설화를 기본값으로. ②정확도 23/25 — check-output-conventions.mjs에서 AREA_RULES의 decision 항목은 지웠으나 같은 파일 L160·L277·L326 주석은 여전히 decision-을 ''알려진 영역 접두어''로 서술. 코드에서 심볼을 제거할 때 그 심볼을 언급하는 주석까지 같은 grep으로 훑는 습관 필요.',
  '2026-08-28T06:30:37.574Z'
WHERE EXISTS (SELECT 1 FROM catalog_item_versions WHERE id = '01m0zkq6x51k63erwsev3ya7f7')
  AND NOT EXISTS (SELECT 1 FROM catalog_scores WHERE id = '01m13tyr1n00arah91ykw0y2yd');
-- ===== BACKFILL END =====

DROP INDEX IF EXISTS idx_agent_scores_user_agent;
DROP INDEX IF EXISTS idx_agent_scores_session;
DROP TABLE IF EXISTS agent_scores;
