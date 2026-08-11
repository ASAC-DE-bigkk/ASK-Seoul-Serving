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
import { LOG_COLUMNS, logValues, logStatus } from "../src/index.js";

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

// ── pattern_id (ASAC-DAG#642 로깅 키) ────────────────────────────────────────
// `run_pattern`(#132)이 소비자로 생기면서 배선됐다. 세 축이 한 행에 모여야
// "어느 게시본의 어느 제품을, 어느 검증 패턴으로" 가 답해진다.
test("run_pattern 만 pattern_id 를 채운다 — 나머지 경로는 개념 자체가 없어 NULL", NEEDS_SQLITE, () => {
  const ran = logValues({ ...TRACE, patternId: "top_dong_by_events" }, { ASK_ENV: "prod" });
  assert.equal(ran[LOG_COLUMNS.indexOf("pattern_id")], "top_dong_by_events");
  // 일반 데이터 조회는 patternId 를 안 만든다 → NULL 이어야 한다(0·'' 로 굳지 않게)
  assert.equal(logValues(TRACE, { ASK_ENV: "prod" })[LOG_COLUMNS.indexOf("pattern_id")], null);
});

test("로깅 키 세 축이 한 행에 모인다 — (product_id, pattern_id, publication_id)", NEEDS_SQLITE, () => {
  const values = logValues(
    { ...TRACE, patternId: "top_dong_by_events", publicationId: "pub_2026_08_07" },
    { ASK_ENV: "prod" });
  assert.equal(values[LOG_COLUMNS.indexOf("product_id")], "culture_activity_by_dong");
  assert.equal(values[LOG_COLUMNS.indexOf("pattern_id")], "top_dong_by_events");
  assert.equal(values[LOG_COLUMNS.indexOf("publication_id")], "pub_2026_08_07");
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

test("요청 축이 제자리에 들어간다 — 목록과 값 순서가 어긋나면 다른 컬럼에 실린다",
  NEEDS_SQLITE, () => {
    const db = migratedDb();
    const trace = {
      ...TRACE,
      uaClass: "ai_agent", agentName: "anthropic", agentMode: "on_demand", agentVerified: 1,
      country: "KR", asn: "4766", refererHost: "chat.example.com",
      intent: "dong_activity_rank", publicationId: "pub_2026_08_04",
    };
    const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
      `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
    db.prepare(sql).run(...logValues(trace, { ASK_ENV: "local" }));

    const row = db.prepare("SELECT * FROM _gateway_request_log").get();
    assert.equal(row.ua_class, "ai_agent");
    assert.equal(row.agent_name, "anthropic");
    assert.equal(row.agent_mode, "on_demand");
    assert.equal(row.agent_verified, 1);
    assert.equal(row.country, "KR");
    assert.equal(row.asn, "4766");
    assert.equal(row.referer_host, "chat.example.com");
    assert.equal(row.intent, "dong_activity_rank");
    assert.equal(row.publication_id, "pub_2026_08_04");
  });

// 🔴 `0005` 의 22종이 이제 **전부 배선됐다** — 미배선 컬럼이 하나도 없다.
//    마지막이 `page_path` 였고 #285 에서 붙었다(전제였던 `[assets]` binding 은 #238 이 해소).
//    이 테스트는 "미배선을 목록에 넣지 마라"에서 **"배선했으니 값이 실린다"** 로 뒤집혔다.
test("배선한 컬럼도 해당 경로가 아니면 NULL 로 남는다", NEEDS_SQLITE, () => {
  assert.ok(LOG_COLUMNS.includes("page_path"), "#285 에서 배선했다");

  const db = migratedDb();
  const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
    `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...logValues(TRACE, { ASK_ENV: "local" }));
  const row = db.prepare("SELECT * FROM _gateway_request_log").get();
  // 데이터 조회는 문서 접근이 아니다 — 빈 문자열이 아니라 NULL 이어야 한다(§4-3)
  assert.equal(row.page_path, null);
  // 배선했어도 patternId 를 안 만든 경로(일반 데이터 조회)는 NULL 이어야 한다
  assert.equal(row.pattern_id, null);
});

test("page 요청은 page_path 가 경로 원문 그대로 실린다", NEEDS_SQLITE, () => {
  const db = migratedDb();
  const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
    `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...logValues(
    { ...TRACE, route: "page", table: null, productId: null, rows: null, pagePath: "/openapi.json" },
    { ASK_ENV: "prod" }));
  const row = db.prepare("SELECT * FROM _gateway_request_log").get();
  assert.equal(row.route, "page");
  assert.equal(row.page_path, "/openapi.json", "소문자화·정규화 없이 원문 그대로");
  // 🔴 콘솔 `AXIS_BUCKET` 이 `no_product` 갈래로 넣는 근거 — 둘 다 NULL 이어야 한다(#177 §3)
  assert.equal(row.product_id, null);
  assert.equal(row.table_name, null);
});

// 🔴 배선했다고 해서 값이 늘 채워지는 건 아니다 — 검증 대상이 아닌 요청(브라우저·curl)은
// NULL 로 남아야 한다. `?? null` 이 아니라 `|| null` 이었으면 **0 이 NULL 로 뒤바뀐다**.
test("agent_verified 는 배선됐지만 검증 대상이 아니면 NULL 이다", NEEDS_SQLITE, () => {
  assert.ok(LOG_COLUMNS.includes("agent_verified"), "#111 에서 배선했다");

  const db = migratedDb();
  const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
    `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...logValues(TRACE, { ASK_ENV: "local" }));
  assert.equal(db.prepare("SELECT * FROM _gateway_request_log").get().agent_verified, null);
});

test("0 은 값이다 — agent_verified 가 0 이면 0 으로 실려야 한다", NEEDS_SQLITE, () => {
  // 자칭 AI 인데 CF 가 확인 못 한 경우다. `|| null` 이면 이 사실이 조용히 사라진다.
  const db = migratedDb();
  const sql = `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
    `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...logValues({ ...TRACE, agentVerified: 0 }, { ASK_ENV: "local" }));
  assert.equal(db.prepare("SELECT * FROM _gateway_request_log").get().agent_verified, 0);
});

test("축을 못 뽑은 요청도 기록된다 — 축이 없다고 행을 버리지 않는다", NEEDS_SQLITE, () => {
  const values = logValues(TRACE, {});   // uaClass 등 전부 undefined
  for (const c of ["ua_class", "country", "asn", "referer_host", "publication_id"])
    assert.equal(values[LOG_COLUMNS.indexOf(c)], null, `${c} 는 undefined 가 아니라 NULL`);
});

test("응답 상태가 곧 결과인 표면은 HTTP 상태를 그대로 쓴다", () => {
  assert.equal(logStatus({}, { status: 200 }), 200);
  assert.equal(logStatus({}, { status: 429 }), 429);
});

test("핸들러가 상태를 정해 뒀으면 그 값이 로그로 간다 — MCP 는 실패도 HTTP 200 이다", () => {
  // 이 한 줄이 없으면 `mcp` route 의 오류율이 영원히 0 이 된다(#62). 200 이 아니라
  // '실패했다'가 기록돼야 콘솔의 SUM(status >= 400) 이 뜻을 갖는다.
  assert.equal(logStatus({ status: 404 }, { status: 200 }), 404);
  assert.equal(logStatus({ status: 401 }, { status: 200 }), 401);
});

test("0 은 값이다 — ?? 가 아니라 || 였으면 조용히 응답 상태로 넘어간다", () => {
  assert.equal(logStatus({ status: 0 }, { status: 200 }), 0);
});

test("남의 표는 손대지 않는다 — 0005 는 _request_log 를 DROP 하지도 ALTER 하지도 않는다",
  NEEDS_SQLITE, () => {
    const sql = readFileSync(join(MIGRATIONS, "0005_gateway_request_log.sql"), "utf8");
    const statements = sql.replace(/--[^\n]*/g, "");   // 주석에는 이름이 나온다(설명이므로 정상)
    assert.ok(!/\b(DROP|ALTER)\b/i.test(statements), "0005 에 DROP·ALTER 가 있으면 안 된다");
    assert.ok(!/_request_log\b(?!_)/.test(statements.replace(/_gateway_request_log/g, "")),
      "0005 의 실행 문장이 _request_log 를 가리키면 안 된다");
  });
