// better-sqlite3 를 Cloudflare D1 의 인터페이스로 감싸는 얇은 어댑터.
//
// 목적: 맥미니(로컬 Node 서버) 이주 시, server/dao/*.js 와 server/api/*.js 를
// 한 줄도 고치지 않고 그대로 쓰기 위함. DAO 는 오직 D1 의 표면
//   db.prepare(sql) -> stmt
//   stmt.bind(...args) -> stmt        (D1 은 새 statement 를 반환하는 불변 API)
//   stmt.all()  -> { results: [...] }
//   stmt.first() -> row | null
//   stmt.run()  -> { meta: { changes, last_row_id } }
//   db.batch([stmt, ...]) -> [결과...]
// 에만 의존한다(코드 스캔으로 확인). 이 6개만 재현하면 DAO 가 그대로 동작한다.
//
// 주의(불변성): D1 의 .bind() 는 매번 새 statement 를 돌려주는데 better-sqlite3 의
// prepared statement 는 가변이라 재바인딩이 누적되면 위험하다. 그래서 여기서는
// "원본 SQL 만 들고 다니다가 실행 시점에 db.prepare 로 그때그때 새 stmt 를 얻어
// 바인딩 인자를 적용"하는 방식으로 D1 의 불변 의미를 흉내 낸다. better-sqlite3 는
// 내부에 statement 캐시가 있어 같은 SQL 재prepare 는 사실상 공짜다.

class WrappedStatement {
  constructor(db, sql, boundArgs) {
    this.db = db
    this.sql = sql
    this.boundArgs = boundArgs // undefined = 아직 bind 안 함
  }

  // D1: 새 statement 를 반환(불변). 여기서도 새 래퍼를 만들어 동일 의미 유지.
  bind(...args) {
    return new WrappedStatement(this.db, this.sql, args)
  }

  _prepared() {
    return this.db.prepare(this.sql)
  }

  _args() {
    return this.boundArgs ?? []
  }

  // SELECT 다건. D1 형태 { results: [...] } 로 래핑.
  all() {
    const stmt = this._prepared()
    // better-sqlite3 는 SELECT 가 아닌 문에 .all() 을 호출하면 던진다.
    // DAO 에서 .all() 은 항상 SELECT 에만 쓰이므로 그대로 통과시킨다.
    const results = stmt.all(...this._args())
    return { results }
  }

  // SELECT 단건. D1 은 없으면 null 을 돌려준다(better-sqlite3 는 undefined).
  first() {
    const stmt = this._prepared()
    const row = stmt.get(...this._args())
    return row === undefined ? null : row
  }

  // INSERT/UPDATE/DELETE/DDL. D1 형태 { meta: { changes, last_row_id } } 로 래핑.
  run() {
    const stmt = this._prepared()
    const info = stmt.run(...this._args())
    return {
      meta: {
        changes: info.changes,
        last_row_id: info.lastInsertRowid,
      },
    }
  }
}

class D1CompatDatabase {
  constructor(betterSqliteDb) {
    this.db = betterSqliteDb
  }

  prepare(sql) {
    return new WrappedStatement(this.db, sql, undefined)
  }

  // D1.batch: statement 들을 (D1 은 트랜잭션으로) 순차 실행하고 결과 배열 반환.
  // init.js 는 결과를 쓰지 않지만 계약을 맞춰 둔다. DDL/DML 혼재를 대비해
  // run() 으로 실행한다(SELECT 를 batch 에 넣는 사용처는 없음).
  batch(statements) {
    const tx = this.db.transaction((stmts) => stmts.map((s) => s.run()))
    return tx(statements)
  }

  // 원시 SQL 직접 실행이 필요할 때를 위한 탈출구(현재 DAO 미사용).
  exec(sql) {
    this.db.exec(sql)
  }

  // 트랜잭션 실행 — 읽기/쓰기가 뒤섞인 원자적 작업(예: LEAD ingest 의 budget 카운트→삽입)용.
  //
  // D1 의 batch()는 "미리 만든 statement 들의 순차 실행"만 지원해, 카운트 결과로 분기하는
  // (TOCTOU 차단) 로직을 담을 수 없다. better-sqlite3 는 동기 API라 db.transaction()으로
  // 한 콜백 안의 모든 prepare/run/get 을 단일 트랜잭션(BEGIN…COMMIT/ROLLBACK)으로 묶을 수 있다.
  //
  // 콜백 fn 에는 "동기" DB 파사드(tx)가 주어진다. tx 의 prepare().bind().run/first/all 은
  // D1 표면과 동일한 형태(meta.changes / row|null / {results})를 동기로 반환한다.
  // fn 안에서 예외가 던져지면 better-sqlite3 가 자동 롤백한다.
  //
  // @param {(tx) => T} fn  트랜잭션 내부에서 실행할 동기 함수.
  // @param {'immediate'|'exclusive'|'deferred'} [mode]  BEGIN 모드. 'immediate' 는 BEGIN 즉시
  //   쓰기락을 선점해 "첫 SELECT ~ 첫 UPDATE" 사이의 레이스 창을 제거한다(백필 changes() 실증 안정화).
  //   미지정 시 better-sqlite3 기본(deferred). better-sqlite3 는 tx 함수에 .immediate/.exclusive/.deferred
  //   변형 함수를 제공하므로 그대로 위임한다.
  // @returns T  fn 의 반환값.
  transaction(fn, mode) {
    const sync = new SyncTxDatabase(this.db)
    const wrapped = this.db.transaction(() => fn(sync))
    if (mode && typeof wrapped[mode] === 'function') return wrapped[mode]()
    return wrapped()
  }
}

// 트랜잭션 콜백에 주어지는 동기 DB 파사드.
// D1 호환 표면(prepare/bind/run/first/all)을 better-sqlite3 동기 호출로 그대로 노출한다.
// 비동기(Promise)를 쓰지 않는다 — better-sqlite3 트랜잭션은 동기 경계 안에서만 원자적이다.
class SyncTxStatement {
  constructor(db, sql, boundArgs) {
    this.db = db
    this.sql = sql
    this.boundArgs = boundArgs
  }
  bind(...args) { return new SyncTxStatement(this.db, this.sql, args) }
  _args() { return this.boundArgs ?? [] }
  all() { return { results: this.db.prepare(this.sql).all(...this._args()) } }
  first() {
    const row = this.db.prepare(this.sql).get(...this._args())
    return row === undefined ? null : row
  }
  run() {
    const info = this.db.prepare(this.sql).run(...this._args())
    return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
  }
}

class SyncTxDatabase {
  constructor(betterSqliteDb) { this.db = betterSqliteDb }
  prepare(sql) { return new SyncTxStatement(this.db, sql, undefined) }
}

// betterSqliteDb: new Database(path) 로 만든 better-sqlite3 인스턴스.
export function wrapD1(betterSqliteDb) {
  return new D1CompatDatabase(betterSqliteDb)
}
