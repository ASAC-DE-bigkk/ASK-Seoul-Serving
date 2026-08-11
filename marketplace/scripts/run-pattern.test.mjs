// run_pattern 실행 계약(#118)의 위험 지점을 고정한다 — SQL 문자열을 만지는 함수라
// 테스트 없이는 다음 사람이 주석 제거·바인딩 순서를 깨도 신호가 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRunPattern } from "../src/index.js";

// d1_usage_patterns 한 행 + 데이터 질의를 흉내내는 최소 DB.
// prepare 된 SQL 에 무엇이 왔는지(converted/binds)를 기록해 검증에 쓴다.
function fakeEnv(patternRow, dataRows = [{ x: 1 }], patternIds = null) {
  const seen = { sql: null, binds: null };
  return {
    seen,
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              async first() { return sql.includes("d1_usage_patterns") ? patternRow : null; },
              async all() {
                // 404 안내용 pattern_id 목록 질의(#204)는 데이터 질의와 구분한다 — 같은 표를
                // 읽지만 쓰임이 다르고, 여기서 안 가르면 `seen.sql` 이 덮여 다른 테스트가 흐려진다.
                if (patternIds && sql.includes("SELECT pattern_id"))
                  return { results: patternIds.map((pattern_id) => ({ pattern_id })) };
                seen.sql = sql; seen.binds = binds; return { results: dataRows };
              },
            };
          },
        };
      },
    },
  };
}
const keyRow = { key_hash: "h", daily_quota: 1000 };

const VALID_EMPTY = {
  state: "valid_empty",
  code: "no_upcoming_precipitation_forecast",
  message_ko: "현재 수집된 유효 단기예보에는 향후 강수 구간이 없습니다.",
};

// countUsage·권리 게이트가 이 테스트의 관심사가 아니므로, 권리 증거는 허용 1행을 준다 —
// 게이트가 2단계(증거 누락 차단)라 0행이면 모든 케이스가 503 에서 끝나 버린다. 누락 차단
// 자체는 아래 전용 테스트가 본다. _usage 는 all/first 를 안 쓰는 경로가 없어 — countUsage 는
// INSERT/SELECT 를 쓴다. 그래서 여기서는 run() 이 필요하다: 위 fake 에 없으면 실패한다.
function fullEnv(patternRow, dataRows, patternIds) {
  const env = fakeEnv(patternRow, dataRows, patternIds);
  env.usageSql = [];
  env.catalogMeta = { name: "t", product_id: "p", publication_id: "pub1", exported_at: "s1" };
  env.sources = [{ source_id: "s", redistribution: "allowed_with_attribution" }];
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes("d1_usage_patterns")) return base(sql);   // "_usage" 부분일치 함정 회피
    if (sql.includes("d1_catalog_sources")) {                  // "_catalog" 부분일치 함정 — _catalog 보다 먼저
      return { bind: () => ({ all: async () => ({ results: env.sources }), first: async () => null }) };
    }
    if (sql.includes("_catalog")) {
      // 카탈로그 게이트(#132 사후 리뷰 ①) — catalogMeta 를 null 로 두면 "없는 제품"이 된다
      return { bind: () => ({ first: async () => env.catalogMeta }) };
    }
    if (sql.includes("d1_product_quality")) {
      return { bind: () => ({ first: async () => env.quality ?? null }) };
    }
    if (sql.includes("AS currentness_as_of")) {
      return { bind: () => ({ first: async () => env.currentness ?? null }) };
    }
    if (sql.includes("_usage")) {
      // 쿼터 문장을 전부 기록한다 — 되돌리기(#217 검토 중 발견)는 **안 하면 조용히 틀리는**
      // 종류라, "무엇을 실행했나"를 봐야 검증된다. 응답만 보면 되돌렸는지 알 수 없다.
      return {
        bind: (...binds) => {
          env.usageSql.push({ sql, binds });
          return { run: async () => ({}), first: async () => ({ count: 1 }) };
        },
      };
    }
    return base(sql);
  };
  return env;
}

const PATTERN = {
  sql: "-- :n=10\nSELECT a, b FROM t WHERE gu = :gu ORDER BY a LIMIT :n",
  question_ko: "질문", verified_rows: 10, verified_at: "2026-08-06", allow_empty: 0,
  insight_sample_ko: "예시 해석",
};

test("성공 — 주석 속 :n 은 자리로 안 세고, 본문 :gu·:n 만 순서대로 바인딩", async () => {
  const env = fullEnv(PATTERN);
  const res = await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.row_count, 1);
  assert.equal(body.insight_sample_ko, "예시 해석");
  assert.deepEqual(env.seen.binds, ["강남구", 10]);          // 등장 순서 = gu, n
  assert.ok(!env.seen.sql.includes(":gu"), "자리 치환 누락");
  assert.ok(!env.seen.sql.includes("--"), "주석이 실행 SQL 에 남음");
});

test("행수 파라미터는 상한으로 눌린다 — :n=999999 → 5000", async () => {
  const env = fullEnv(PATTERN);
  await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 999999 }, keyRow, {});
  assert.equal(env.seen.binds[1], 5000);
});

test("선언 밖 파라미터는 400 + 선언 목록 안내", async () => {
  const res = await handleRunPattern(fullEnv(PATTERN), "p", "pat", { gu: "x", n: 1, evil: "1;DROP" }, keyRow, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /gu, n/);
});

test("파라미터 누락은 400 — 무엇이 필요한지 말한다", async () => {
  const res = await handleRunPattern(fullEnv(PATTERN), "p", "pat", { gu: "x" }, keyRow, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /:n/);
});

test("미검증 패턴은 409 — 실행하지 않는다", async () => {
  const res = await handleRunPattern(fullEnv({ ...PATTERN, verified_at: null }), "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 409);
});

test("SELECT/WITH 아니면 400 — 저장 SQL 이라도 쓰기는 실행 안 한다", async () => {
  const res = await handleRunPattern(fullEnv({ ...PATTERN, sql: "DELETE FROM t" }), "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 400);
});

test("없는 패턴 404 — describe 로 안내", async () => {
  const res = await handleRunPattern(fullEnv(null), "p", "nope", {}, keyRow, {});
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /usage_patterns/);
});

test("0행 + allow_empty=1 이면 '정상일 수 있다' 를 말한다", async () => {
  const env = fullEnv({ ...PATTERN, sql: "SELECT a FROM t", allow_empty: 1 }, []);
  const body = await (await handleRunPattern(env, "p", "pat", {}, keyRow, {})).json();
  assert.match(body.empty_note, /정상/);
});


test("서빙 카탈로그에 없는 제품은 카탈로그 404 — 패턴 404 와 구분된다 (#132 리뷰 ①)", async () => {
  const env = fullEnv(PATTERN);
  env.catalogMeta = null;
  const res = await handleRunPattern(env, "nope", "pat", {}, keyRow, {});
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /서빙 카탈로그에 없다/);   // mcp 유사 제안 분기가 무는 문구
});

test("권리 증거가 없으면 503 — run_pattern 도 게이트 2단계를 탄다 (#88)", async () => {
  const env = fullEnv(PATTERN);
  env.sources = [];
  const res = await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, {});
  assert.equal(res.status, 503);
  assert.deepEqual((await res.json()).blockers, ["missing_source_rights_evidence"]);
});

test("정상 빈 상품의 run_pattern 은 0행 availability를 돌려주고 과금·SQL 실행을 하지 않는다", async () => {
  const env = fullEnv(PATTERN);
  env.catalogMeta = {
    name: "t",
    product_id: "p",
    publication_id: "pub1",
    serving_status: "published",
    row_count: 0,
    mcp_projection: JSON.stringify({ empty_result: VALID_EMPTY }),
  };
  env.quality = {
    source_row_count: 0,
    d1_row_count: 0,
    duplicate_primary_key_count: 0,
    null_primary_key_count: 0,
    freshness_as_of: new Date().toISOString(),
    freshness_slo_minutes: 240,
    serving_status: "published",
    measured_at: new Date().toISOString(),
    publication_id: "pub1",
  };

  const res = await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.row_count, 0);
  assert.deepEqual(body.rows, []);
  assert.deepEqual(body.availability, VALID_EMPTY);
  assert.equal(body.quota_charged, false);
  assert.equal(env.usageSql.length, 0);
  assert.equal(env.seen.sql, null, "정상 빈 결과는 pattern SQL을 실행하면 안 된다");
});

test("현재 스냅샷이 지난 시간이면 run_pattern 도 과금 전에 fail-closed 한다", async () => {
  const env = fullEnv(PATTERN);
  env.catalogMeta = {
    name: "t",
    product_id: "p",
    publication_id: "pub1",
    row_count: 1,
    mcp_projection: JSON.stringify({
      currentness: { field: "forecast_at", minimum: "current_kst_hour" },
    }),
  };
  env.currentness = { currentness_as_of: "2000-01-01 00:00:00" };

  const res = await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, {});
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.code, "product_not_ready");
  assert.ok(body.blockers.includes("quality_snapshot_not_current"));
  assert.equal(env.usageSql.length, 0);
  assert.equal(env.seen.sql, null, "stale snapshot은 pattern SQL을 실행하면 안 된다");
});

// ── 없는 패턴 404 의 회복 경로 (#204) ────────────────────────────────────────────
// 안내가 **실재하지 않는 곳**을 가리키던 것을 고친 자리다. 옛 문구는 "카탈로그의
// usage_patterns 에서 runnable 인 것을 고를 것"이었는데 카탈로그에 그 필드가 없었다.

test("없는 패턴 404 는 실행 가능한 pattern_id 를 그대로 실어 준다 (#204)", async () => {
  const env = fullEnv(null, undefined, ["free_in_gu", "gu_window", "today_in_gu"]);
  const res = await handleRunPattern(env, "p", "nope", {}, keyRow, {});
  assert.equal(res.status, 404);
  const { detail } = await res.json();
  for (const id of ["free_in_gu", "gu_window", "today_in_gu"]) assert.match(detail, new RegExp(id));
  // 🔴 목록이 있으면 **어디를 보라고 하지 않는다** — 그 '어디'가 틀렸던 게 이 결함이다.
  assert.doesNotMatch(detail, /카탈로그/);
});

test("패턴 목록을 못 얻으면 `runnable` 이 실제로 있는 곳을 가리킨다 (#204)", async () => {
  const env = fullEnv(null, undefined, []);
  const res = await handleRunPattern(env, "p", "nope", {}, keyRow, {});
  assert.equal(res.status, 404);
  const { detail } = await res.json();
  // 제품 번들만이 `runnable` 을 싣는다(v1.js). 카탈로그를 가리키면 다시 같은 결함이다.
  assert.match(detail, /\/api\/v1\/products\/p/);
  assert.doesNotMatch(detail, /카탈로그/);
});

test("목록 질의가 죽어도 404 안내는 나간다 — 덤이 본문을 막지 않는다 (#204)", async () => {
  const env = fullEnv(null, undefined, []);
  const base = env.DB.prepare;
  env.DB.prepare = (sql) => sql.includes("SELECT pattern_id")
    ? { bind: () => ({ all: async () => { throw new Error("D1 down"); } }) }
    : base(sql);
  const res = await handleRunPattern(env, "p", "nope", {}, keyRow, {});
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /'nope' 는 'p' 의 패턴에 없다/);
});

test("카탈로그 통과 시 trace 에 table·publication_id 가 남는다 (#132 리뷰 ①-d)", async () => {
  const env = fullEnv(PATTERN);
  const trace = {};
  await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, trace);
  assert.equal(trace.table, "t");
  assert.equal(trace.publicationId, "pub1");
});

// ── #217 1차: P0-a(거부 목록) · P1(기본값·허용값) · P3(배열) ─────────────────────────
// 파라미터 메타는 별도 표 d1_pattern_params 다 — paramRow 로 흉내낸다(컬럼은 JSON TEXT).

function extEnv(patternRow, paramRow, dataRows) {
  const env = fullEnv(patternRow, dataRows);
  const base = env.DB.prepare;
  env.DB.prepare = (sql) => sql.includes("d1_pattern_params")
    ? { bind: () => ({ first: async () => paramRow }) }
    : base(sql);
  return env;
}

test("P1: param_defaults 가 미전달 파라미터를 채운다 — ?major 만으로 실행", async () => {
  const env = extEnv({ ...PATTERN, sql: "SELECT a FROM t WHERE m = :major AND (:gu = 'ALL' OR g = :gu)" },
    { param_defaults: '{"gu":"ALL"}', param_enum: null, params: null });
  const res = await handleRunPattern(env, "p", "pat", { major: "health" }, keyRow, {});
  assert.equal(res.status, 200);
  assert.deepEqual(env.seen.binds, ["health", "ALL", "ALL"]);   // :gu 2회 등장 — 두 자리 다 기본값
});

test("P1: 소비자 값이 기본값을 덮는다", async () => {
  const env = extEnv({ ...PATTERN, sql: "SELECT a FROM t WHERE g = :gu LIMIT :n" },
    { param_defaults: '{"gu":"ALL","n":10}', param_enum: null, params: null });
  await handleRunPattern(env, "p", "pat", { gu: "서초구" }, keyRow, {});
  assert.deepEqual(env.seen.binds, ["서초구", 10]);
});

test("P1: param_enum 밖 값은 400 — 조용한 0행이 아니라 허용값 안내", async () => {
  const env = extEnv({ ...PATTERN, sql: "SELECT a FROM t WHERE d = :dir" },
    { param_defaults: null, param_enum: '{"dir":["asc","desc"]}', params: null });
  const res = await handleRunPattern(env, "p", "pat", { dir: "up" }, keyRow, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /asc, desc/);
  assert.equal(env.seen.sql, null, "검증 실패인데 실행됨");
});

test("P3: spec array 선언 + REST JSON 배열 문자열 → ?,?,? 전개", async () => {
  const env = extEnv({ ...PATTERN, sql: "SELECT a FROM t WHERE g IN (:gus)" },
    { param_defaults: null, param_enum: null, params: '{"gus":{"type":"array","item":"string","max_len":100}}' });
  const res = await handleRunPattern(env, "p", "pat", { gus: '["강남구","서초구"]' }, keyRow, {});
  assert.equal(res.status, 200);
  assert.match(env.seen.sql, /IN \(\?,\?\)/);
  assert.deepEqual(env.seen.binds, ["강남구", "서초구"]);
});

test("P3: 선언 없는 파라미터의 JSON 문자열은 스칼라 그대로 — json_each 관용구 무회귀", async () => {
  const env = extEnv({ ...PATTERN, sql: "SELECT a FROM t WHERE g IN (SELECT value FROM json_each(:gus))" }, null);
  const res = await handleRunPattern(env, "p", "pat", { gus: '["강남구","서초구"]' }, keyRow, {});
  assert.equal(res.status, 200);
  assert.match(env.seen.sql, /json_each\(\?\)/);
  assert.deepEqual(env.seen.binds, ['["강남구","서초구"]']);
});

test("메타 표를 못 읽어도(표 없음 등) 기존 계약 그대로 동작한다 — 전 파라미터 필수", async () => {
  const env = fullEnv(PATTERN);
  const base = env.DB.prepare;
  env.DB.prepare = (sql) => sql.includes("d1_pattern_params")
    ? { bind: () => ({ first: async () => { throw new Error("no such table"); } }) }
    : base(sql);
  const missing = await handleRunPattern(env, "p", "pat", { gu: "x" }, keyRow, {});
  assert.equal(missing.status, 400);                       // :n 누락 — 기본값 없음
  const ok = await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, {});
  assert.equal(ok.status, 200);
});

test("P0-a: 게시된 SQL 이 내부 표(_keys)를 읽으면 400 pattern out of scope — 실행 없음", async () => {
  const env = fullEnv({ ...PATTERN, sql: "SELECT a FROM t, _keys" });
  const res = await handleRunPattern(env, "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).title, "pattern out of scope");
  assert.equal(env.seen.sql, null, "거부된 패턴이 실행됨");
});

test("P0-a: WITH 접두 쓰기(WITH x AS(…) DELETE)는 SELECT/WITH 정규식을 지나도 게이트가 잡는다", async () => {
  const env = fullEnv({ ...PATTERN, sql: "WITH x AS (SELECT 1) DELETE FROM t" });
  const res = await handleRunPattern(env, "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).title, "pattern out of scope");
  assert.equal(env.seen.sql, null);
});

test("P0-a: d1_migrations(거부 목록 명시 항목)도 막는다", async () => {
  const env = fullEnv({ ...PATTERN, sql: "SELECT a FROM t JOIN d1_migrations ON 1=1" });
  const res = await handleRunPattern(env, "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).title, "pattern out of scope");
});

test("P0-a: 형제 서빙 표 참조는 막지 않는다 — 거부 목록의 의도된 경계(P0-b 소관)", async () => {
  const env = fullEnv({ ...PATTERN, sql: "SELECT a FROM t JOIN d1_sibling ON 1=1" });
  const res = await handleRunPattern(env, "p", "pat", {}, keyRow, {});
  assert.equal(res.status, 200);
});

test("행수 상한은 문자열로도 못 넘는다 — '999999' → 5000 (#132 리뷰 ②)", async () => {
  const env = fullEnv(PATTERN);
  await handleRunPattern(env, "p", "pat", { gu: "x", n: "999999" }, keyRow, {});
  assert.equal(env.seen.binds[1], 5000);
});

test("행수 파라미터에 숫자 아닌 값은 400", async () => {
  const res = await handleRunPattern(fullEnv(PATTERN), "p", "pat", { gu: "x", n: "abc" }, keyRow, {});
  assert.equal(res.status, 400);
});

// ── 관측 (ASAC-DAG#642 로깅 키) ──────────────────────────────────────────────
test("성공하면 trace 에 pattern_id 가 남는다", async () => {
  const trace = {};
  await handleRunPattern(fullEnv(PATTERN), "p", "top_dong", { gu: "x", n: 10 }, keyRow, trace);
  assert.equal(trace.patternId, "top_dong");
  assert.equal(trace.productId, "p");
});

// 🔴 막힌 요청이야말로 수요 신호다 — "무슨 패턴을 부르다 막혔나"를 못 남기면
// 미검증 패턴(409)이 얼마나 요청되는지 알 수 없어 검증 우선순위를 못 정한다.
test("404·409 로 끝나도 무엇을 부르려 했는지는 남는다", async () => {
  const t404 = {};
  await handleRunPattern(fullEnv(null), "p", "nope", {}, keyRow, t404);
  assert.equal(t404.patternId, "nope");

  const t409 = {};
  await handleRunPattern(fullEnv({ ...PATTERN, verified_at: null }), "p", "unverified", {}, keyRow, t409);
  assert.equal(t409.patternId, "unverified");
});

test("형식이 틀린 pattern_id 는 남기지 않는다 — 아무 문자열이나 로그에 싣지 않는다", async () => {
  const trace = {};
  const res = await handleRunPattern(fullEnv(PATTERN), "p", "DROP TABLE x", {}, keyRow, trace);
  assert.equal(res.status, 400);
  assert.equal(trace.patternId, undefined);
});

// ── 드리프트 500 은 쿼터를 안 태운다 (#217 검토 중 발견) ─────────────────────────
//
// `countUsage` 는 이름과 달리 **증가**라, 실행이 던진 시점에 이미 하루 몫이 깎여 있었다.
// 게시자가 깨뜨린 패턴을 소비자가 지불하고, 재시도하면 매번 깎이는 구조였다.
//
// 응답만 봐서는 되돌렸는지 알 수 없어 **실행한 쿼터 문장**을 본다.

function driftEnv() {
  const env = fullEnv(PATTERN);
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    // 패턴 SQL 실행만 던지게 한다 — 게시본과 어긋난 상황의 재현
    if (sql.includes("SELECT a, b FROM t")) {
      return { bind: () => ({ all: async () => { throw new Error("no such column: b"); } }) };
    }
    return base(sql);
  };
  return env;
}

const refunds = (env) => env.usageSql.filter((s) => /UPDATE _usage/.test(s.sql));
const charges = (env) => env.usageSql.filter((s) => /INSERT INTO _usage/.test(s.sql));

test("드리프트 500 — 깎은 쿼터를 되돌린다", async () => {
  const env = driftEnv();
  const res = await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  assert.equal(res.status, 500);
  assert.equal(charges(env).length, 1, "과금이 한 번 일어나야 이 테스트가 의미가 있다");
  assert.equal(refunds(env).length, 1, "되돌리기가 없다 — 소비자가 서버 잘못을 지불한다");
});

test("되돌리기는 음수를 만들지 않는다 — 무제한 키가 되어 버린다", async () => {
  const env = driftEnv();
  await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  assert.match(refunds(env)[0].sql, /count > 0/,
    "가드가 없으면 두 번 되돌릴 때 음수가 되고, 음수 쿼터는 리셋 전까지 무제한이다");
});

test("되돌리기는 깎은 그 날짜를 가리킨다 — 자정을 걸치면 남의 몫을 깎는다", async () => {
  const env = driftEnv();
  await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  const chargedDay = charges(env)[0].binds[1];
  const refundedDay = refunds(env)[0].binds[1];
  assert.equal(refundedDay, chargedDay);
});

test("드리프트 500 은 안 깎였다고 말한다 — 안 그러면 소비자가 알 길이 없다", async () => {
  const env = driftEnv();
  const res = await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  const body = await res.json();
  assert.equal(body.quota_charged, false);
  assert.match(body.detail, /쿼터를 소모하지 않았다/);
});

test("🔴 되돌리기가 실패하면 안 깎였다고 말하지 않는다", async () => {
  const env = driftEnv();
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/UPDATE _usage/.test(sql)) throw new Error("D1 unavailable");
    return base(sql);
  };
  const res = await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.quota_charged, undefined, "틀린 안내는 안내가 없는 것보다 나쁘다");
  assert.doesNotMatch(body.detail, /쿼터를 소모하지 않았다/);
});

test("성공하면 되돌리지 않는다 — 정상 서빙은 과금 대상이다", async () => {
  const env = fullEnv(PATTERN);
  const res = await handleRunPattern(env, "p", "pat", { gu: "강남구", n: 10 }, keyRow, {});
  assert.equal(res.status, 200);
  assert.equal(charges(env).length, 1);
  assert.equal(refunds(env).length, 0);
});
