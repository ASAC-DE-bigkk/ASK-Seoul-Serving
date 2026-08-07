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

// countUsage·권리 게이트가 이 테스트의 관심사가 아니므로, 실제 shared 구현이 fakeEnv 의
// DB 를 통과하도록 패턴 행 조회 외의 first()는 null(권리 미선언=1단계 통과), _usage 는
// all/first 를 안 쓰는 경로가 없어 — countUsage 는 INSERT/SELECT 를 쓴다. 그래서 여기서는
// run() 이 필요하다: 위 fake 에 없으면 실패한다. countUsage 경로까지 감당하도록 보강한다.
function fullEnv(patternRow, dataRows) {
  const env = fakeEnv(patternRow, dataRows);
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes("d1_usage_patterns")) return base(sql);   // "_usage" 부분일치 함정 회피
    if (sql.includes("_usage")) {
      return { bind: () => ({ run: async () => ({}), first: async () => ({ count: 1 }) }) };
    }
    if (sql.includes("d1_catalog_sources")) {
      return { bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) };
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
