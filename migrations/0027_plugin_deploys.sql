-- Migration number: 0027 	 2026-09-10T08:58:11.756Z
--
-- plugin_deploys — 회사 Claude Code 플러그인 저장소(GitHub `malgnsoft/claude-plugins`)의
-- GitHub Actions가 "플러그인 버전업이 main에 배포됐다"고 알려오는 **인바운드 알림**의 기록.
-- 설계 정본: docs/design/plugin-deploy-notify.md, architecture.md §0 결정34, api.md §5.10.
--
-- ⚠️ 기존 카탈로그 축(catalog_items/catalog_item_versions, migrations 0006)과 **별개 축**이다.
--    같은 저장소·같은 플러그인을 가리키지만 세는 것이 다르다:
--      catalog_item_versions.content_sha = 파일 1개의 GitHub blob sha(우리가 pull해서 채움)
--      plugin_deploys.version            = 플러그인 패키지 전체의 semver 릴리스(CI가 push해서 채움)
--    카탈로그에는 "플러그인 semver"라는 개념 자체가 없고, catalog_items의 유니크 축
--    (plugin_name,item_type,slug)에는 릴리스 사건이 앉을 자리가 없다. 더 결정적으로,
--    catalog-sync.js는 매 동기화마다 "이번 GitHub 파일 스캔에 없는 기존 행"을 markRemoved()로
--    죽이므로(0015), 릴리스 행을 그 테이블에 얹으면 sync가 매번 그 행을 soft-remove 처리한다.
--    → 그래서 테이블을 분리한다. 두 축을 잇는 끈은 plugin_name의 값 공간 공유뿐이다.
--
-- ⚠️ 이력 테이블이다(플러그인당 1행 덮어쓰기가 아니다). "현재 버전"은
--    ORDER BY received_at DESC, id DESC LIMIT 1로 유도한다 — 이력에서 현재는 유도되지만
--    현재에서 이력은 복구되지 않는다. 연간 수십~수백 행이라 보관 비용이 사실상 0이고,
--    나중에 sessions.plugin_version(직원 PC 설치 버전)과 조인하면 "배포 후 채택 속도"를
--    계산할 수 있다 — 최신 1행만 남기면 그 질문은 영원히 답할 수 없게 된다.
--
-- FK(REFERENCES)는 쓰지 않는다(하우스 스타일, architecture.md §0-15). CHECK 화이트리스트도
-- 쓰지 않는다 — audit_logs.action이 값 하나 늘릴 때마다 테이블 전체 재작성을 요구했던
-- 선례(0009·0018·0021·0023·0026)를 새 테이블에서 반복하지 않는다. 값 형식 검증은
-- 라우트(server/api/plugin-deploys.js)가 정규식으로 한다.
CREATE TABLE plugin_deploys (
  id TEXT PRIMARY KEY,             -- ULID 소문자 26자(server/lib/ulid.js newId(), 하우스 스타일).
                                   -- 시간정렬 가능이라 received_at 동률 시 정렬 타이브레이커로도 쓴다.
  plugin_name TEXT NOT NULL,       -- 예: 'malgn-agent'. catalog_items.plugin_name과 같은 값 공간을
                                   -- 공유하지만 FK는 없다(위 주석). 라우트에서 ^[a-z0-9][a-z0-9._-]{0,49}$ 검증.
  version TEXT NOT NULL,           -- plugin.json의 version 원문(엄격 semver, 'v' 접두사 없음).
                                   -- prerelease/build 메타 허용(1.9.0-rc.1 / 1.9.0+build.5).
  commit_hash TEXT NOT NULL,       -- git 커밋 해시. **소문자로 정규화해 저장**한다 — 대소문자만 다른
                                   -- 값이 별개 행이 되면 아래 유니크 인덱스(=멱등성)가 뚫린다.
                                   -- 40자(SHA-1) 또는 64자(git SHA-256 전환 대비) hex.
  repository TEXT,                 -- 'owner/repo' 정규화본(URL/SSH 형태로 와도 라우트가 슬러그로 정규화).
                                   -- NULL 허용 = 호출자가 보내지 않음. 호출자가 1곳뿐이라 중복 정보처럼
                                   -- 보이지만, "누가 이 알림을 보냈다고 주장했는지"는 사고 조사 때
                                   -- 유일한 출처 단서라 남긴다(값 자체는 인증 근거가 아니다).
  deployed_at TEXT NOT NULL,       -- 호출자가 알린 배포(=워크플로 실행) 시각 ISO8601. 생략 시 서버가
                                   -- received_at을 복사해 채운다(NOT NULL 유지 — NULL 분기를 조회부에
                                   -- 퍼뜨리지 않기 위함). 시계 오차 방어로 미래 24h/과거 30d 범위 검증.
  received_at TEXT NOT NULL        -- 우리 서버가 받은 시각 ISO8601. **"현재 버전" 판정의 정본 축**이며
                                   -- 멱등 재전송 시에도 최초 값이 보존된다(갱신하지 않는다).
);

-- 멱등성의 정본(요청서 지정): 같은 배포가 GitHub Actions 재시도로 몇 번 도착해도 1행.
-- (plugin_name, version)만으로 유니크를 걸지 않는 이유 — 태그 재작성/force-push로 같은 버전이
-- 다른 커밋에 붙어 재배포되는 경우가 실제로 있고, 그건 별개 사건으로 남아야 한다.
CREATE UNIQUE INDEX idx_plugin_deploys_natural ON plugin_deploys(plugin_name, version, commit_hash);

-- "이 플러그인의 현재 버전"(LIMIT 1)과 목록 조회(GET /api/plugin-deploys?plugin=)를 커버한다.
-- 위 유니크 인덱스는 선두 컬럼이 plugin_name이라 동등 필터는 되지만 received_at 정렬을 주지
-- 못하므로 별도로 만든다(정렬용 인덱스가 없으면 매 조회가 전체 정렬로 떨어진다).
CREATE INDEX idx_plugin_deploys_recent ON plugin_deploys(plugin_name, received_at DESC);
