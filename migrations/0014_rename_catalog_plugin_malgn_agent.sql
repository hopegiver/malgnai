-- Migration number: 0014 	 2026-08-25T00:00:00.000Z
--
-- GitHub 저장소(hopegiver/claude-plugins → malgnsoft/claude-plugins 이전)와 함께 플러그인
-- 디렉터리명도 malgn-dev → malgn-agent로 개명됐다(server/lib/catalog-sync.js REPO/PLUGIN_NAME/
-- 경로 정규식 갱신). catalog_items.plugin_name은 (plugin_name, item_type, slug) 유니크 인덱스의
-- 일부라 코드만 바꾸면 다음 sync가 기존 행을 못 찾고 전부 새 행으로 중복 삽입한다 — 기존 행을
-- 그대로 재사용하도록 plugin_name과 source_path의 디렉터리 접두사를 함께 정정한다.

UPDATE catalog_items
SET plugin_name = 'malgn-agent',
    source_path = 'malgn-agent/' || substr(source_path, length('malgn-dev/') + 1)
WHERE plugin_name = 'malgn-dev' AND source_path LIKE 'malgn-dev/%';
