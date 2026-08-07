// run_pattern 실행 계약(#118)의 위험 지점을 고정한다 — SQL 문자열을 만지는 함수라
// 테스트 없이는 다음 사람이 주석 제거·바인딩 순서를 깨도 신호가 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRunPattern } from "../src/index.js";

// d1_usage_patterns 한 행 + 데이터 질의를 흉내내는 최소 DB.
// prepare 된 SQL 에 무엇이 왔는지(converted/binds)를 기록해 검증에 쓴다.
function fakeEnv(patternRow, dataRows = [{ x: 1 }]) {
  const seen = { sql: null, binds: null };
  return {
    seen,
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              async first() { return sql.includes("d1_usage_patterns") ? patternRow : null; },
              async all() { seen.sql = sql; seen.binds = binds; return { results: dataRows }; },
            };
          },
        };
      },
    },
  };
}
const keyRow = { key_hash: "h", daily_quota: 1000 };

// countUsage·권리 게이트가 이 테스트의 관심사가 아니므로, 권리 증거는 허용 1행을 준다 —
// 게이트가 2단계(증거 누락 차단)라 0행이면 모든 케이스가 503 에서 끝나 버린다. 누락 차단
// 자체는 아래 전용 테스트가 본다. _usage 는 all/first 를 안 쓰는 경로가 없어 — countUsage 는
// INSERT/SELECT 를 쓴다. 그래서 여기서는 run() 이 필요하다: 위 fake 에 없으면 실패한다.
function fullEnv(patternRow, dataRows) {
  const env = fakeEnv(patternRow, dataRows);
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
    if (sql.includes("_usage")) {
      return { bind: () => ({ run: async () => ({}), first: async () => ({ count: 1 }) }) };
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

test("카탈로그 통과 시 trace 에 table·publication_id 가 남는다 (#132 리뷰 ①-d)", async () => {
  const env = fullEnv(PATTERN);
  const trace = {};
  await handleRunPattern(env, "p", "pat", { gu: "x", n: 1 }, keyRow, trace);
  assert.equal(trace.table, "t");
  assert.equal(trace.publicationId, "pub1");
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
