/**
 * `GET /api/v1/patterns/{product_id}/{pattern_id}` — **문**을 고정한다.
 *
 * 실행 로직(`handleRunPattern`)은 `run-pattern.test.mjs` 가 이미 덮는다. 여기서 지키는 것은
 * 문 쪽 계약 넷이고, 전부 라우터에만 있어서 그쪽 테스트로는 안 잡힌다.
 *
 *   ① 경로가 두 조각(product/pattern)을 정확히 집는가 — 조각이 더/덜이면 안 걸려야 한다
 *   ② **쿼리스트링이 패턴 파라미터로 넘어가는가** — 이 매핑이 이 문의 전부다
 *   ③ 인증이 앞에 있는가 (키 없이 400 이 나오면 미검증 SQL 이 인증 밖에 노출된 것)
 *   ④ route 값이 `run_pattern` 인가 — 콘솔 계약(ops-dashboard decision/0014)이 이 값을 읽는다
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const TEST_API_KEY = `ask_${"0".repeat(32)}`;

const PATTERN = {
  sql: "SELECT gu, cnt FROM t WHERE gu = :gu ORDER BY cnt DESC LIMIT :n",
  question_ko: "전시 많이 하는 동네는?",
  verified_rows: 10,
  verified_at: "2026-08-05",
  allow_empty: 0,
  insight_sample_ko: "강남구가 가장 많았다",
};

// 재배포 권리 증거(#88). `RIGHTS_GATE_STAGE=2` 부터는 **증거가 비면 닫힌다**(fail-closed) —
// 기본값을 채워 두지 않으면 이 파일의 모든 테스트가 503 을 받는다. 빈 경우는 맨 아래에서 본다.
const RIGHTS_OK = [{ source_id: "seoul_open_data", redistribution: "allowed_with_attribution" }];

/** 라우터가 통과하는 문 전부를 흉내낸다 — 키·카탈로그·패턴·권리·쿼터·로그. */
function fixtureDb(seen = {}, rights = RIGHTS_OK) {
  return {
    prepare(sql) {
      return {
        bind(...binds) {
          seen.lastBinds = binds;
          return {
            async first() {
              if (sql.includes("FROM _keys"))
                return { key_hash: "h", key_prefix: "ask_0000", email: "t@e.st",
                         status: "active", daily_quota: 1000 };
              if (sql.includes("d1_usage_patterns")) return PATTERN;
              if (sql.includes("_catalog"))
                return { name: "t", product_id: "p", publication_id: "pub1", exported_at: "s1" };
              if (sql.includes("_usage")) return { count: 1 };
              if (sql.includes("_burst")) return { n: 1 };
              return null;
            },
            async all() {
              if (sql.includes("d1_catalog_sources")) return { results: rights };
              seen.sql = sql;
              seen.dataBinds = binds;
              return { results: [{ gu: "강남구", cnt: 12 }] };
            },
            async run() { return {}; },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return {}; },
      };
    },
  };
}

async function call(path, { key = TEST_API_KEY, method = "GET", rights = RIGHTS_OK } = {}, seen = {}) {
  const pending = [];
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const res = await worker.fetch(
    new Request(`https://marketplace.example.test${path}`, { method, headers }),
    { DB: fixtureDb(seen, rights), ASK_ENV: "dev" },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

test("문이 열렸다 — 검증된 패턴이 실행되고 해석 예시가 함께 온다", async () => {
  const seen = {};
  const res = await call("/api/v1/patterns/p/top_gu?gu=%EA%B0%95%EB%82%A8%EA%B5%AC&n=10", {}, seen);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pattern_id, "top_gu");
  assert.equal(body.question_ko, PATTERN.question_ko);
  // 검증 증거는 현재값이 아니지만 응답에 같이 와야 한다(#118 ④) — 사람이 "이 질의가
  // 이런 답을 낸다"를 보고 고르기 때문이다.
  assert.equal(body.insight_sample_ko, PATTERN.insight_sample_ko);
});

test("② 쿼리스트링이 :파라미터 자리로 그대로 간다 — 이 매핑이 이 문의 전부다", async () => {
  const seen = {};
  await call("/api/v1/patterns/p/top_gu?gu=%EA%B0%95%EB%82%A8%EA%B5%AC&n=10", {}, seen);
  // SQL 의 :gu·:n 순서대로 바인딩된다. 값이 뒤바뀌면 조용히 틀린 답이 나가므로 순서를 고정한다.
  assert.deepEqual(seen.dataBinds, ["강남구", 10]);
});

test("② 선언 안 된 파라미터는 400 이고, 쓸 수 있는 이름을 알려 준다", async () => {
  const res = await call("/api/v1/patterns/p/top_gu?gu=x&n=1&evil=1");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.detail, /evil/);
  assert.match(body.detail, /gu/);   // 회복 경로를 같이 준다
});

test("③ 인증이 문 앞에 있다 — 키 없이는 패턴에 닿지 못한다", async () => {
  const res = await call("/api/v1/patterns/p/top_gu?gu=x&n=1", { key: null });
  assert.equal(res.status, 401);
});

test("① 조각 수가 다르면 이 문이 아니다 — 404 로 떨어진다", async () => {
  assert.equal((await call("/api/v1/patterns/p")).status, 404);
  assert.equal((await call("/api/v1/patterns/p/pat/extra")).status, 404);
});

test("조회 전용 가드가 살아 있다 — POST 는 405", async () => {
  const res = await call("/api/v1/patterns/p/top_gu", { method: "POST" });
  assert.equal(res.status, 405);
});

test("④ route 값은 `run_pattern` 이다 — 콘솔 계약(0014)이 이 문자열을 읽는다", async () => {
  // 로그 INSERT 의 바인딩에서 확인한다. 값이 바뀌면 콘솔의 SERVE_ROUTES 에서 빠져
  // **데이터를 돌려주는 문인데 안 세어진다**(mcp_run_pattern 때 겪은 사고와 같은 자리).
  let logged = null;
  const db = {
    prepare(sql) {
      const base = fixtureDb().prepare(sql);
      if (!sql.includes("INSERT INTO _gateway_request_log")) return base;
      return { bind: (...b) => { logged = b; return { async run() { return {}; } }; } };
    },
  };
  const pending = [];
  await worker.fetch(
    new Request("https://marketplace.example.test/api/v1/patterns/p/top_gu?gu=x&n=1", {
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    }),
    { DB: db, ASK_ENV: "dev" },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  assert.ok(logged, "요청 로그가 기록되지 않았다");
  assert.ok(logged.includes("run_pattern"),
    `route 값이 로그에 없다 — 기록된 값: ${JSON.stringify(logged)}`);
});

test("재배포 권리 게이트가 이 문에도 걸린다 — 증거가 없으면 패턴 SQL 이 돌지 않는다", async () => {
  // 새 문은 실행 로직을 안 만들고 `handleRunPattern` 을 부르므로 게이트가 저절로 따라온다.
  // 하지만 **저절로 따라오는 것이야말로 나중에 조용히 끊긴다** — 라우터가 핸들러를 우회하는
  // 날 아무도 못 알아챈다. 권리는 소비자와 무관한 원천과의 약속이라(shared.js §권리 게이트)
  // 어느 문으로도 안 뚫려야 하고, 그래서 문마다 고정한다.
  const seen = {};
  const res = await call("/api/v1/patterns/p/top_gu?gu=x&n=1", { rights: [] }, seen);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "product_not_ready");
  assert.ok(body.blockers.includes("missing_source_rights_evidence"),
    `blockers: ${JSON.stringify(body.blockers)}`);
  // 막혔으면 질의가 D1 에 안 닿아야 한다 — 응답만 503 이고 SQL 은 돈 상태면 게이트가 아니다.
  assert.equal(seen.dataBinds, undefined);
});
