// 스키마 정본은 웹서버(server/dao/init.js)다 — 웹앱 부팅 시 CREATE + ALTER 마이그레이션까지 그쪽이 소유한다.
// MCP 는 같은 sqlite 파일을 여는 두 번째 프로세스일 뿐이라 여기서 테이블을 만들지 않는다.
//
// 과거엔 여기서 db.exec(SCHEMA_SQL) 로 전체 CREATE TABLE IF NOT EXISTS 를 돌렸는데, 이것이 스키마
// 변경(테이블 제거)의 발목을 잡았다: 세션마다 뜬 mcp/index.js 서브프로세스가 종료되지 않고 누적된 채
// 구버전 이 파일을 메모리에 물고 있으면, getDb() 첫 연결에서 옛 CREATE 가 실행돼 이미 지운 테이블
// (tasks/feedbacks/file_summaries/sync_outbox)을 되살렸다(2026-07-06 실측·근절, issue 43110872).
// → 테이블 생성 책임을 웹서버 한 곳으로 일원화하고 여기선 커넥션 PRAGMA 만 맞춘다.

export function initializeSchema(db) {
  db.exec("PRAGMA journal_mode = WAL;");
  // 웹서버 커넥션(server/node.js)이 foreign_keys 를 켜지 않아 CASCADE/SET NULL이 강제되지 않는 것과
  // 통일 — 같은 DB 파일을 여는 두 프로세스의 FK 강제수준을 맞춘다(issue 884f02bf).
}
