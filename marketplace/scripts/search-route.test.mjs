// `GET /api/v1/search` — 랜딩 챗봇의 1단계 문(#159 후속).
//
// 여기서 지키는 것은 검색 품질이 아니라(그건 agent-tools 의 몫) **이 문의 성격**이다:
//   ① 무인증·무과금·LLM 없음 — 랜딩은 방문자 전원이 지나므로 이게 전제다
//   ② 데이터를 조회하지 않는다 — 카탈로그만 읽는다
//   ③ 빈 질의는 400 이다 — 빈 결과로 답하면 "맞는 게 없다"로 읽힌다(모른다 ≠ 없다)
//   ④ 검색기는 MCP `search_products` 와 **같은 함수**다 — 사람 순위와 AI 순위가 갈리면 안 된다
//   ⑤ route 는 `search` 로 남는다(콘솔 계약 0014 에 올라갈 값)
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { searchProducts } from "../src/agent-tools.js";

const PATTERN = {
  product_id: "culture_events", pattern_id: "free_in_gu", question_ko: "이 구에서 무료 행사는?",
  axes: null, sql: "SELECT 1", requires: null, verified_rows: 3, verified_at: "2026-08-05",
  allow_empty: 0, insight_sample_ko: "예시",
};
// ⚠️ 제품이 **둘 이상**이어야 한다. 점수는 IDF 가중이라, 제품이 하나면 모든 낱말의
//    df=N 이 되어 가중치가 0 으로 수렴하고 아무것도 안 걸린다(실측하다 걸렸다).
//    이건 결함이 아니라 "모든 문서에 있는 낱말은 변별력이 없다"는 IDF 의 정의다.
const ROW = {
  name: "culture_events", product_id: "culture_events", external: 1,
  description: "서울 문화행사 일정", product_question: "어디서 무슨 행사가 하나?",
  time_axis: "event_at", columns: '[{"name":"gu","type":"varchar"}]',
  row_count: 10, freshness: "f", publication_id: "pub1", exported_at: "s1",
};
const OTHER = {
  name: "weather_grid", product_id: "weather_grid", external: 1,
  description: "기상청 격자 관측", product_question: "지금 기온은?",
  time_axis: "obs_at", columns: '[{"name":"temp","type":"double"}]',
  row_count: 20, freshness: "f", publication_id: "pub1", exported_at: "s1",
};

function fixtureDb(seen = {}) {
  return {
    prepare(sql) {
      const stmt = (binds) => ({
        async first() { seen.firsts = (seen.firsts || 0) + 1; return null; },
        async all() {
          if (sql.includes("d1_usage_patterns")) return { results: [PATTERN] };
          if (sql.includes("_catalog")) return { results: [ROW, OTHER] };
          if (sql.includes("d1_catalog_sources"))
            return { results: [{ source_id: "seoul", redistribution: "allowed_with_attribution" }] };
          // 🔴 여기 닿으면 제품 데이터를 조회한 것이다 — 이 문은 그러면 안 된다
          seen.dataRead = sql;
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO _gateway_request_log")) seen.logBinds = binds;
          if (sql.includes("INSERT INTO _usage")) seen.usageCharges = (seen.usageCharges || 0) + 1;
          return {};
        },
      });
      return { bind: (...b) => stmt(b), ...stmt([]) };
    },
  };
}

async function call(qs, seen = {}) {
  const pending = [];
  const res = await worker.fetch(
    new Request("https://m.example.test/api/v1/search" + qs),
    { DB: fixtureDb(seen), ASK_ENV: "dev" },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

test("🔴 ① 무인증으로 답한다 — 키 없이 200", async () => {
  const res = await call("?q=" + encodeURIComponent("무료 행사"));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.matched, 1);
  assert.equal(b.products[0].product_id, "culture_events");
});

test("🔴 ① 쿼터를 깎지 않는다 — 랜딩이 방문마다 요금을 만들면 안 된다", async () => {
  const seen = {};
  await call("?q=" + encodeURIComponent("무료 행사"), seen);
  assert.equal(seen.usageCharges, undefined, "_usage INSERT 가 일어났다");
});

test("🔴 ② 제품 데이터를 조회하지 않는다 — 카탈로그만 읽는다", async () => {
  const seen = {};
  await call("?q=" + encodeURIComponent("무료 행사"), seen);
  assert.equal(seen.dataRead, undefined,
    "카탈로그 밖의 조회가 일어났다 — 이 문은 '어느 제품이 답하나'만 답한다");
});

test("③ 빈 질의는 400 — 빈 결과로 답하면 '맞는 게 없다'로 읽힌다", async () => {
  const res = await call("");
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /q 파라미터/);
});

test("③ 너무 긴 질의도 400 — 한 문장이면 된다", async () => {
  const res = await call("?q=" + encodeURIComponent("가".repeat(201)));
  assert.equal(res.status, 400);
});

test("🔴 ④ MCP `search_products` 와 같은 결과다 — 사람 순위와 AI 순위가 갈리면 안 된다", async () => {
  const res = await call("?q=" + encodeURIComponent("무료 행사"));
  const viaRoute = await res.json();
  const viaFn = searchProducts({ products: [
    { ...ROW, usage_patterns: [], columns: [] },
    { ...OTHER, usage_patterns: [], columns: [] },
  ] }, "무료 행사", 3);
  assert.deepEqual(viaRoute.products.map((p) => p.product_id), viaFn.products.map((p) => p.product_id));
});

test("⑤ route 는 'search' 로 남는다 — 콘솔 0014 에 올라갈 값", async () => {
  const seen = {};
  await call("?q=" + encodeURIComponent("무료 행사"), seen);
  assert.ok(seen.logBinds, "요청 로그가 안 남았다");
  assert.equal(seen.logBinds[1], "search");   // LOG_COLUMNS 순서: ts, route, …
});

test("찾아 준 건수를 row_count 로 남긴다 — '0건이 잦은 질문'이 카탈로그의 구멍 신호다", async () => {
  const seen = {};
  await call("?q=" + encodeURIComponent("무료 행사"), seen);
  assert.equal(seen.logBinds[6], 1);   // LOG_COLUMNS: …, filters, row_count, …
});
