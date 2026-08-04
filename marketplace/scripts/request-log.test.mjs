/**
 * 요청 로그 기록 — **코드가 아는 컬럼과 실제 스키마가 어긋나지 않는지** 고정한다.
 *
 * 이 자리가 위험한 이유: `logRequest` 의 INSERT 실패는 `catch {}` 에 먹힌다(관측이 서빙을
 * 깨뜨리면 안 되므로 의도된 설계다). 그래서 컬럼 하나만 어긋나도 **아무 신호 없이 로그가
 * 전량 사라진다.** 시드 체인에서 `0004` 가 빠져 몇 주간 전량 유실된 실사고가 그 모양이었다.
 *
 * 그래서 마이그레이션을 인메모리 sqlite 에 **그대로 적용한 스키마**에 대고 실제 INSERT 를
 * 돌려 본다. 원격은 물론 로컬 Miniflare 상태도 건드리지 않는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_COLUMNS, logValues } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* 아래에서 skip */ }
const NEEDS_SQLITE = { skip: DatabaseSync ? false : "node:sqlite 없음 — Node 22.5+ 필요" };

/** 마이그레이션을 순서대로 적용한 DB — 기대 스키마의 정본은 파일이지 상수가 아니다. */
function migratedDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

const columnsOf = (db, table) =>
  db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name);

const TRACE = {
  route: "data", table: "gold_culture_activity_by_dong", productId: "culture_activity_by_dong",
  status: 200, keyHash: "abc123", filterCols: ["event_date", "gu_code"],
  rows: 42, ms: 17, requestId: "req_deadbeef",
};

test("코드가 아는 컬럼이 실제 스키마에 전부 있다 — 하나만 없어도 로그가 전량 사라진다",
  NEEDS_SQLITE, () => {
    const have = new Set(columnsOf(migratedDb(), "_gateway_request_log"));
    const missing = LOG_COLUMNS.filter((c) => !have.has(c));
    assert.deepEqual(missing, [], `스키마에 없는 컬럼: ${missing.join(", ")}`);
  });

test("INSERT 가 실제로 들어간다 — 컬럼 수와 바인딩 수가 어긋나면 여기서 죽는다",
  NEEDS_SQLITE, () => {
    const db = migratedDb();
    const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
      `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
    db.prepare(sql).run(...logValues(TRACE, { ASK_ENV: "local" }));

    const row = db.prepare("SELECT * FROM _gateway_request_log").get();
    assert.equal(row.route, "data");
    assert.equal(row.table_name, "gold_culture_activity_by_dong");
    assert.equal(row.product_id, "culture_activity_by_dong");   // 공개 식별자도 함께 남는다
    assert.equal(row.filters, "event_date,gu_code");            // 값이 아니라 **컬럼명만**
    assert.equal(row.env, "local");
  });

test("ASK_ENV 가 없으면 env 는 NULL — '모른다'를 'local' 로 꾸미지 않는다", NEEDS_SQLITE, () => {
  const values = logValues(TRACE, {});
  assert.equal(values[LOG_COLUMNS.indexOf("env")], null);
});

test("제품을 해석하기 전에 끝난 요청은 product_id 가 NULL 이다 (400·404)", NEEDS_SQLITE, () => {
  // 요청 문자열은 물리명 별칭일 수도 있어 해석 전에는 공개 식별자를 알 수 없다.
  // 억지로 채우면 존재하지 않는 제품의 호출이 집계에 생긴다.
  const values = logValues({ ...TRACE, productId: undefined, status: 404 }, { ASK_ENV: "prod" });
  assert.equal(values[LOG_COLUMNS.indexOf("product_id")], null);
  assert.equal(values[LOG_COLUMNS.indexOf("table_name")], TRACE.table);  // 무엇을 찾았는지는 남는다
});

test("값이 아니라 축만 남는다 — 로그 컬럼에 원문이 들어갈 자리가 없다", NEEDS_SQLITE, () => {
  // 이름으로 한 번 더 잠근다. 컬럼이 늘 때 원문 축(query·token·ua·email·ip)이 섞여 들어오면
  // agreement §3 대원칙이 조용히 깨진다.
  const forbidden = ["query", "token", "user_agent", "ua", "email", "ip", "ip_hash", "referer"];
  const have = columnsOf(migratedDb(), "_gateway_request_log");
  const found = have.filter((c) => forbidden.includes(c));
  assert.deepEqual(found, [], `원문 축이 스키마에 들어왔다: ${found.join(", ")}`);
});

test("남의 표는 손대지 않는다 — 0005 는 _request_log 를 DROP 하지도 ALTER 하지도 않는다",
  NEEDS_SQLITE, () => {
    const sql = readFileSync(join(MIGRATIONS, "0005_gateway_request_log.sql"), "utf8");
    const statements = sql.replace(/--[^\n]*/g, "");   // 주석에는 이름이 나온다(설명이므로 정상)
    assert.ok(!/\b(DROP|ALTER)\b/i.test(statements), "0005 에 DROP·ALTER 가 있으면 안 된다");
    assert.ok(!/_request_log\b(?!_)/.test(statements.replace(/_gateway_request_log/g, "")),
      "0005 의 실행 문장이 _request_log 를 가리키면 안 된다");
  });
