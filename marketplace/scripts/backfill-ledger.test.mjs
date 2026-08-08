/**
 * backfill-migrations-ledger.sql — DB 모양별 판정을 고정한다.
 *
 * 이 스크립트가 틀리면 손해는 여기가 아니라 **그 다음에 도는 `migrations apply`** 에서
 * 난다(장부에 없는 마이그레이션을 실행하므로). 그래서 "무엇을 기록했나"가 아니라
 * **"그 결과 apply 가 무엇을 실행하게 되나"** 를 각 케이스 이름에 적었다.
 *
 * D1 대신 `node:sqlite` 인메모리를 쓴다 — 원격은 물론 로컬 Miniflare 상태도 건드리지
 * 않는다(로컬 D1 은 콘솔과 공유하는 상태다, decision/0003).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `node:sqlite` 는 Node 22.5+ 다. 팀 로컬 버전이 제각각이라 없는 환경에서는 이 파일만
// 건너뛴다 — 여기서 죽으면 `npm test` 전체가 막혀 배포 런북 §0 이 또 헛돈다(#42 와 같은 결).
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* 아래에서 skip 처리 */ }
const NEEDS_SQLITE = { skip: DatabaseSync ? false : "node:sqlite 없음 — Node 22.5+ 필요" };

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKFILL = readFileSync(join(HERE, "backfill-migrations-ledger.sql"), "utf8");

// 0002 가 만드는 우리 표. `route` 가 우리 것임을 가르는 표식이다.
const OURS = `CREATE TABLE _request_log (
  ts TEXT NOT NULL, route TEXT NOT NULL, table_name TEXT, status INTEGER NOT NULL,
  key_hash TEXT, filters TEXT, row_count INTEGER, ms INTEGER)`;
const OURS_WITH_REQUEST_ID = `${OURS.slice(0, -1)}, request_id TEXT)`;

// 원격에 선점돼 있는 남의 표 (2026-08-04 실측, 읽기만). dev 에는 0004 가 잘못 얹혀
// request_id 가 이미 붙어 있다 — 이 사고가 개명(#44 A)의 근거다.
const FOREIGN_PROD = `CREATE TABLE _request_log (ts TEXT, path TEXT, query TEXT, token TEXT)`;
const FOREIGN_DEV = `CREATE TABLE _request_log (ts TEXT, path TEXT, query TEXT, token TEXT, request_id TEXT)`;

const KEYS = `CREATE TABLE _keys (key_hash TEXT PRIMARY KEY)`;
const SERVICE_KEYS = `CREATE TABLE _service_keys (
  key_hash TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  service_name TEXT,
  scopes_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  daily_quota INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL,
  revoked_at TEXT
)`;
const BURST = `CREATE TABLE _burst (bucket TEXT PRIMARY KEY)`;

/** 주어진 모양의 DB 에 백필을 돌리고 (장부, DB핸들) 을 돌려준다. */
function backfill(...setup) {
  const db = new DatabaseSync(":memory:");
  for (const ddl of setup) db.exec(ddl);
  db.exec(BACKFILL);
  const ledger = db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((r) => r.name);
  return { db, ledger };
}

const columnsOf = (db, table) =>
  db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);

test("새 DB — 아무것도 기록하지 않는다 (apply 가 0001~0004 전부 실행)", NEEDS_SQLITE, () => {
  assert.deepEqual(backfill().ledger, []);
});

test("손으로 다 적용된 DB — 넷 다 기록한다 (apply 가 전부 건너뜀)", NEEDS_SQLITE, () => {
  const { ledger } = backfill(KEYS, OURS_WITH_REQUEST_ID, BURST);
  assert.deepEqual(ledger, [
    "0001_keys_usage.sql", "0002_request_log.sql", "0003_burst.sql", "0004_request_id.sql",
  ]);
});

test("우리 표에 0004 만 빠진 DB — 0004 를 기록하지 않는다 (apply 가 0004 만 실행 = 치유)", NEEDS_SQLITE, () => {
  const { ledger } = backfill(KEYS, OURS, BURST);
  assert.deepEqual(ledger, ["0001_keys_usage.sql", "0002_request_log.sql", "0003_burst.sql"]);
  assert.ok(!ledger.includes("0004_request_id.sql"));
});

test("service key 표가 이미 있으면 0006도 기록한다 (apply가 중복 생성하지 않음)", NEEDS_SQLITE, () => {
  const { ledger } = backfill(SERVICE_KEYS);
  assert.deepEqual(ledger, ["0006_service_key_scope.sql"]);
});

test("기존 user key 표만 있으면 0006은 기록하지 않는다 (apply가 service key 표를 추가함)", NEEDS_SQLITE, () => {
  const { ledger } = backfill(KEYS);
  assert.deepEqual(ledger, ["0001_keys_usage.sql"]);
});

test("남의 표가 이름을 선점한 prod 모양 — 0004 를 기록한다 (apply 가 남의 표를 안 건드림)", NEEDS_SQLITE, () => {
  const { db, ledger } = backfill(FOREIGN_PROD);
  assert.ok(ledger.includes("0004_request_id.sql"),
    "0004 를 기록하지 않으면 apply 의 ALTER 가 남의 표에 우리 컬럼을 붙인다");
  // 0001·0003 은 우리 표가 없으니 기록하지 않는다 — apply 가 정상적으로 만들어야 한다.
  assert.deepEqual(ledger, ["0002_request_log.sql", "0004_request_id.sql"]);
  // 그리고 이 스크립트 자체는 남의 표를 건드리지 않는다.
  assert.deepEqual(columnsOf(db, "_request_log"), ["ts", "path", "query", "token"]);
});

test("남의 표에 우리 컬럼이 이미 얹힌 dev 모양 — 0004 를 기록한다 (재실행 시 죽지 않음)", NEEDS_SQLITE, () => {
  const { db, ledger } = backfill(KEYS, FOREIGN_DEV, BURST);
  assert.ok(ledger.includes("0004_request_id.sql"),
    "기록하지 않으면 apply 가 duplicate column name 으로 죽어 뒤 마이그레이션이 통째로 막힌다");
  assert.deepEqual(columnsOf(db, "_request_log"), ["ts", "path", "query", "token", "request_id"]);
});

test("두 절이 겹쳐도 0004 는 한 번만 — UNIQUE 제약을 건드리지 않는다", NEEDS_SQLITE, () => {
  // request_id 는 있고 route 는 없는 모양(dev)이 두 절 모두의 조건을 만족한다.
  const { ledger } = backfill(FOREIGN_DEV);
  assert.equal(ledger.filter((n) => n === "0004_request_id.sql").length, 1);
});

test("백필 → apply 전 과정 — 남의 표는 컬럼 하나 안 늘어난다", NEEDS_SQLITE, () => {
  // 이 파일에서 유일하게 "기록"이 아니라 **결과**를 보는 케이스다. apply 는 장부에 없는
  // 마이그레이션만 순서대로 실행하므로, 그 규칙을 그대로 재현해 실제 파일을 돌린다.
  const { db, ledger } = backfill(FOREIGN_PROD);
  const before = columnsOf(db, "_request_log");

  const migrations = readdirSync(join(HERE, "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    if (ledger.includes(file)) continue;
    db.exec(readFileSync(join(HERE, "..", "migrations", file), "utf8"));
  }

  assert.deepEqual(columnsOf(db, "_request_log"), before, "apply 가 남의 표에 컬럼을 붙였다");
  // 그러면서 우리 표는 정상적으로 생겨야 한다 — 막는 게 목적이 아니라 비켜 가는 게 목적이다.
  for (const t of ["_keys", "_usage", "_issuance_log", "_burst"]) {
    assert.ok(columnsOf(db, t).length > 0, `${t} 가 생기지 않았다`);
  }
});

test("두 번 돌려도 결과가 같다 — 시드 체인이 매번 부른다", NEEDS_SQLITE, () => {
  const db = new DatabaseSync(":memory:");
  for (const ddl of [KEYS, FOREIGN_DEV, BURST]) db.exec(ddl);
  db.exec(BACKFILL);
  const once = db.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
  db.exec(BACKFILL);
  const twice = db.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
  assert.deepEqual(twice, once);
});
