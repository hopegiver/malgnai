-- Migration number: 0015 	 2026-08-28T00:00:00.000Z
--
-- catalog_items.removed_at 컬럼 추가. GitHub(malgnsoft/claude-plugins) 쪽 파일이 삭제/이름변경돼
-- server/lib/catalog-sync.js의 스캔 결과에서 더 이상 발견되지 않는 기존 항목을, 지금까지는 아무
-- 표시도 남기지 않아 /catalog 화면·GET /api/catalog에 죽은 항목이 계속 노출되던 버그를 고치기
-- 위함(2026-08-28, 사용자 보고 "실제 저장소보다 항목이 더 많이 보인다").
--
-- catalog_item_versions/catalog_promotions/catalog_scores가 catalog_items.id를 FK로 참조하므로
-- (docs/schema.sql §3.17) 하드 DELETE는 이력 레코드를 고아로 만들 위험이 있어 금지 — 대신
-- removed_at TEXT(nullable, ISO8601)로 soft-remove 표시만 한다. syncCatalog()가 이번 스캔에서
-- 발견 못한 기존 항목을 markRemoved()로 마킹하고, 반대로 파일이 재등장하면 upsertCompanyItem()이
-- removed_at을 다시 NULL로 되돌린다(server/dao/catalog.js, server/lib/catalog-sync.js).
--
-- 순수 ADD COLUMN(nullable, 기본값 없음)이라 기존 행에 영향 없음 — 기존 행은 전부 removed_at IS
-- NULL(= 아직 활성)로 남는다.

ALTER TABLE catalog_items ADD COLUMN removed_at TEXT;
