// MCP 서버 스모크 — 프로토콜(initialize/tools-list)은 D1 불필요, tools/call 은 deps 목킹.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleMcp, TOOLS } from "../src/mcp.js";

const rpc = (method, params, id = 1) =>
  new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// 목 deps: authenticate 성공/실패 + 핸들러
const mkDeps = (over = {}) => ({
  authenticate: async () => ({ keyRow: { key_hash: "h1" } }),
  checkBurst: async () => ({ exceeded: false, retryAfter: 60 }),
  handleCatalog: async () => jsonRes({ products: [{ product_id: "citydata_ppltn_daily" }] }),
  handleMe: async () => jsonRes({ used: 3, quota: 100, exceeded: false }),
  handleProductBundle: async (_e, pid) => jsonRes({ product_id: pid, columns: [], usage_patterns: [] }),
  handlePreview: async (_e, id) => jsonRes({ id, preview: true, rows: [{ a: 1 }] }),
  handleData: async (_e, id) => jsonRes({ id, rows: [] }),
  handleRunPattern: async (_e, pid, pat) => jsonRes({ product_id: pid, pattern_id: pat, rows: [{ a: 1 }], row_count: 1 }),
  ...over,
});

test("initialize — 데이터/인증 없이 서버정보", async () => {
  const res = await handleMcp(rpc("initialize"), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(body.result.protocolVersion);
  assert.equal(body.result.serverInfo.name, "ask-seoul");
  assert.ok(body.result.capabilities.tools);
});

// ── clientInfo → 관측 축 (#111 후속) ─────────────────────────────────────────
// UA 로는 MCP 클라이언트를 못 잡아 prod 호출 95건이 전부 `unknown` 이었다. 이름은
// 프로토콜 규격(`initialize.params.clientInfo`) 안에 이미 있었다.
test("initialize — clientInfo 가 agent_name·agent_mode 로 남는다", async () => {
  const trace = {};
  await handleMcp(
    rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "Claude-AI", version: "0.1.0" } }),
    {}, trace, mkDeps());
  assert.equal(trace.agentName, "claude-ai");
  assert.equal(trace.agentMode, "mcp_client");
});

test("initialize — clientInfo 가 없으면 축을 만들지 않는다", async () => {
  const trace = { agentName: null, agentMode: null };
  await handleMcp(rpc("initialize", { protocolVersion: "2025-06-18" }), {}, trace, mkDeps());
  assert.equal(trace.agentName, null);
  assert.equal(trace.agentMode, null);
});

// 🔴 이게 핵심이다. clientInfo 도 **자기 신고**라 CF 검증 대상이 아니다 — clientAxes 가
// 넣은 NULL 을 그대로 둬야 한다. 0 을 쓰면 스펙이 경고한 "검증 실패" 오독이 된다.
test("initialize — agent_verified 와 ua_class 는 건드리지 않는다", async () => {
  const trace = { agentVerified: null, uaClass: "unknown" };
  await handleMcp(
    rpc("initialize", { clientInfo: { name: "cursor" } }), {}, trace, mkDeps());
  assert.equal(trace.agentVerified, null, "검증 대상이 아닌데 값이 생겼다");
  assert.equal(trace.uaClass, "unknown", "전송 계층 축을 프로토콜 사실로 덮었다");
});

test("tools/list — 6개 툴", async () => {
  const res = await handleMcp(rpc("tools/list"), {}, {}, mkDeps());
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_products", "describe_product", "preview_product", "query_product", "run_pattern", "check_quota"]);
  for (const t of body.result.tools) assert.ok(t.inputSchema && t.description);
});

test("tools/call list_products — 인증 후 handleCatalog 재사용", async () => {
  const res = await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.products[0].product_id, "citydata_ppltn_daily");
});

test("list_products — K-Skill allowlist 와 결합하지 않는다(#172): verified 미노출", async () => {
  // 예전에는 skill.js 의 SKILL_PRODUCT_IDS 로 verified 를 찍었다 — allowlist 가 6→1 로
  // 줄자(PR#161) 실측 ready 인 제품까지 false 로 나갈 뻔했다. 지금은 그 판정 자체를
  // 싣지 않는다. 이 테스트는 **재결합 회귀**를 막는다: K-Skill 상품 수가 몇이 되든
  // MCP 응답 모양이 변하지 않아야 한다(masondev 완료기준 "MCP 테스트는 K-Skill 과 독립").
  const deps = mkDeps({
    handleCatalog: async () => jsonRes({
      products: [
        { product_id: "weather_place_risk_window" }, // K-Skill 번들 소속
        { product_id: "citydata_ppltn_daily" },       // 일반 카탈로그
      ],
    }),
  });
  const res = await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, {}, deps);
  const payload = JSON.parse((await res.json()).result.content[0].text);
  assert.equal("verified_bundle" in payload, false);
  for (const p of payload.products) assert.equal("verified" in p, false);
  // 제품 목록과 순서는 카탈로그 그대로다 — mcp 가 판정을 덧씌우지 않는다
  assert.deepEqual(payload.products.map((p) => p.product_id),
    ["weather_place_risk_window", "citydata_ppltn_daily"]);
});

// ── 목록은 고르기 위한 것이다 (2026-08-08 실측: 510KB · 최대 10초) ──────────────
// AI 가 가장 먼저 부르는 도구가 57종의 질의 패턴 431건 + 컬럼 전량을 싣고 있었다.
// 한 번의 호출로 컨텍스트가 무너지고, 전수 평가에서 AI 가 응답을 파일로 저장해 grep 하는
// 이상행동까지 나왔다. 상세는 describe_product 의 몫이다.

const listPayload = async (products) => {
  const deps = mkDeps({ handleCatalog: async () => jsonRes({ products }) });
  const res = await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, {}, deps);
  return JSON.parse((await res.json()).result.content[0].text);
};

const FAT_PRODUCT = {
  product_id: "p", name: "t", product_question: "대표질문?",
  usage_patterns: [
    { pattern_id: "cohort_survival", question_ko: "창업 후 몇 년을 버티나?",
      sql: "SELECT ".repeat(50), axes: ["a"], requires: ["x"], insight_sample_ko: "해석",
      verified_at: "2026-08-06", verified_rows: 10, allow_empty: 0 },
    { pattern_id: "top_dong", question_ko: "어느 동이 많나?", sql: "SELECT 2" },
  ],
  columns: [
    { name: "gu", type: "TEXT", description: "자치구 이름 — 긴 설명이 여기 붙는다" },
    { name: "event_date", type: "DATE", description: "행사 일자" },
  ],
};

test("list_products — 무거운 필드는 빼되 **검색 신호는 남긴다**", async () => {
  const p = (await listPayload([FAT_PRODUCT])).products[0];
  // 남는 것 — 소비자가 제품을 고르는 데 쓰는 값
  assert.equal(p.product_question, "대표질문?");
  assert.deepEqual(p.usage_patterns, [
    { pattern_id: "cohort_survival", question_ko: "창업 후 몇 년을 버티나?" },
    { pattern_id: "top_dong", question_ko: "어느 동이 많나?" },
  ]);
  assert.deepEqual(p.column_names, ["gu", "event_date"]);
  assert.equal(p.pattern_count, 2);
  assert.equal(p.column_count, 2);
  // 빠지는 것 — 목록 단계에서 안 쓰는데 응답의 대부분을 차지하던 것들
  for (const u of p.usage_patterns) {
    for (const k of ["sql", "axes", "requires", "insight_sample_ko", "verified_at", "verified_rows", "allow_empty"]) {
      assert.equal(k in u, false, `${k} 가 목록에 남았다`);
    }
  }
  assert.equal("columns" in p, false, "컬럼 전문(설명 포함)이 목록에 남았다");
});

test("메타가 없는 제품은 개수 0 · 빈 목록 — 필드를 지어내지 않는다", async () => {
  const p = (await listPayload([{ product_id: "p" }])).products[0];
  assert.equal(p.pattern_count, 0);
  assert.equal(p.column_count, 0);
  assert.deepEqual(p.usage_patterns, []);
  assert.deepEqual(p.column_names, []);
});

test("목록이 상세로 가는 길을 알려 준다", async () => {
  const payload = await listPayload([FAT_PRODUCT]);
  assert.match(payload.detail_hint, /describe_product/);
  assert.match(payload.detail_hint, /runnable/);   // 실행 가능 여부는 목록이 말하지 않는다
});

test("mcp.js 는 skill.js 를 import 하지 않는다(#172 구조 회귀 방지)", async () => {
  const src = await readFile(new URL("../src/mcp.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']\.\/skill\.js["']/);
});

test("check_quota — 이메일 미노출(#26 완료기준), 나머지는 유지", async () => {
  const deps = mkDeps({
    handleMe: async () => jsonRes({ key_prefix: "ask_0000", email: "user@example.com", used_today: 3, daily_quota: 100 }),
  });
  const res = await handleMcp(rpc("tools/call", { name: "check_quota", arguments: {} }), {}, {}, deps);
  const payload = JSON.parse((await res.json()).result.content[0].text);
  assert.equal(payload.email, undefined);
  assert.equal(payload.used_today, 3);
  assert.equal(payload.key_prefix, "ask_0000");
});

test("tools/call query_product — product_id 를 shared 해석기에 그대로 전달", async () => {
  let got = null;
  const deps = mkDeps({ handleData: async (_e, id, params) => { got = { id, limit: params.get("limit") }; return jsonRes({ id, rows: [] }); } });
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "citydata_ppltn_daily", limit: 10 } }),
    {}, {}, deps);
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(got, { id: "citydata_ppltn_daily", limit: "10" });
});

test("query_product intent 인자 — trace 로 옮겨 싣고, 슬러그 아니면 other", async () => {
  const trace = {};
  let params = null;
  const deps = mkDeps({ handleData: async (_e, id, p) => { params = p; return jsonRes({ id, rows: [] }); } });
  await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p", intent: "vital_dongs_top" } }),
    {}, trace, deps);
  assert.equal(trace.intent, "vital_dongs_top");
  assert.equal(params.has("intent"), false); // 데이터 질의로 새면 없는 필터라 400 이 난다
  const trace2 = {};
  await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p", intent: "어느 동이 제일 붐비나요?" } }),
    {}, trace2, mkDeps());
  assert.equal(trace2.intent, "other");
});

test("tools/call 인증 실패 → 키 안내(isError)", async () => {
  const deps = mkDeps({ authenticate: async () => ({ error: jsonRes({ type: "unauthorized" }, 401) }) });
  const res = await handleMcp(rpc("tools/call", { name: "check_quota", arguments: {} }), {}, {}, deps);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /키가 없거나/);
});

test("initialize/tools-list 는 핸들러(데이터) 미호출", async () => {
  let called = 0;
  const deps = mkDeps({ handleCatalog: async () => { called++; return jsonRes({}); } });
  await handleMcp(rpc("initialize"), {}, {}, deps);
  await handleMcp(rpc("tools/list"), {}, {}, deps);
  assert.equal(called, 0);
});

test("알 수 없는 method → JSON-RPC 에러", async () => {
  const res = await handleMcp(rpc("bogus/x"), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.error.code, -32601);
});

// ── 버스트 (#61) ─────────────────────────────────────────────────────────────
// 다른 네 표면은 라우터에서 `checkBurst("k:"+key_hash)` 를 거치는데 MCP 만 비어 있었다.
// 상한 없는 표면 하나가 있으면 §7 의 "쿼터보다 먼저"가 그 문에서만 무효가 된다.

test("tools/call — 버스트는 키 버킷으로, 인증 **뒤에** 본다", async () => {
  const seen = [];
  const deps = mkDeps({ checkBurst: async (_e, b) => { seen.push(b); return { exceeded: false, retryAfter: 60 }; } });
  await handleMcp(rpc("tools/call", { name: "check_quota", arguments: {} }), {}, {}, deps);
  assert.deepEqual(seen, ["k:h1"]);
});

test("버스트 초과 → HTTP 429 + Retry-After (JSON-RPC 봉투에 숨기지 않는다)", async () => {
  const trace = {};
  const deps = mkDeps({ checkBurst: async () => ({ exceeded: true, retryAfter: 17 }) });
  const res = await handleMcp(rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, trace, deps);
  // 봉투에 싸면 Retry-After 가 사라져 클라이언트가 즉시 재시도한다 — 상황을 더 나쁘게 만든다.
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "17");
});

test("버스트에 걸리면 툴을 아예 안 부른다 — 쿼터도 안 깎인다", async () => {
  let called = 0;
  const deps = mkDeps({
    checkBurst: async () => ({ exceeded: true, retryAfter: 5 }),
    handleData: async () => { called++; return jsonRes({}); },
  });
  await handleMcp(rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, {}, deps);
  assert.equal(called, 0);
});

test("인증 실패면 버스트를 보지 않는다 — 키 없는 요청이 남의 버킷을 밀지 못한다", async () => {
  let called = 0;
  const deps = mkDeps({
    authenticate: async () => ({ error: jsonRes({}, 401) }),
    checkBurst: async () => { called++; return { exceeded: false, retryAfter: 60 }; },
  });
  await handleMcp(rpc("tools/call", { name: "check_quota", arguments: {} }), {}, {}, deps);
  assert.equal(called, 0);
});

test("발견 단계(initialize·tools/list)는 버스트 대상이 아니다 — D1 을 안 만진다", async () => {
  let called = 0;
  const deps = mkDeps({ checkBurst: async () => { called++; return { exceeded: false, retryAfter: 60 }; } });
  await handleMcp(rpc("initialize"), {}, {}, deps);
  await handleMcp(rpc("tools/list"), {}, {}, deps);
  assert.equal(called, 0);
});

// ── 실패 상태 기록 (#62) ─────────────────────────────────────────────────────
// JSON-RPC 는 오류도 봉투에 담아 HTTP 는 200 이다. 응답 상태만 로그에 쓰면 MCP 는 무슨 일이
// 나든 `mcp/200` 이고, 콘솔의 오류율(`SUM(status >= 400)`)이 영원히 0 이 된다.

test("툴 실패 상태가 trace 에 남는다 — 봉투는 200 이어도 로그는 404", async () => {
  const trace = {};
  const deps = mkDeps({ handleData: async () => jsonRes({ title: "unknown product" }, 404) });
  const res = await handleMcp(rpc("tools/call", { name: "query_product", arguments: { product_id: "nope" } }), {}, trace, deps);
  assert.equal(res.status, 200);          // 프로토콜은 그대로 — 클라이언트 호환을 깨지 않는다
  assert.equal(trace.status, 404);        // 기록은 실제 결과를 말한다
});

test("쿼터 초과(429)도 그대로 기록된다", async () => {
  const trace = {};
  const deps = mkDeps({ handleData: async () => jsonRes({ title: "daily quota exceeded" }, 429) });
  await handleMcp(rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, trace, deps);
  assert.equal(trace.status, 429);
});

test("인증 실패는 401/403 을 구분해 기록한다 — 폐기된 키와 없는 키는 다른 사건이다", async () => {
  for (const status of [401, 403]) {
    const trace = {};
    const deps = mkDeps({ authenticate: async () => ({ error: jsonRes({}, status) }) });
    await handleMcp(rpc("tools/call", { name: "check_quota", arguments: {} }), {}, trace, deps);
    assert.equal(trace.status, status);
  }
});

test("봉투 자체가 깨졌거나 없는 method 면 400 — 404 로 적으면 '없는 데이터'로 읽힌다", async () => {
  const bad = new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  const t1 = {};
  await handleMcp(bad, {}, t1, mkDeps());
  assert.equal(t1.status, 400);

  const t2 = {};
  await handleMcp(rpc("bogus/x"), {}, t2, mkDeps());
  assert.equal(t2.status, 400);
});

test("성공한 호출은 상태를 정하지 않는다 — HTTP 200 이 그대로 결과다", async () => {
  const trace = {};
  await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, trace, mkDeps());
  assert.equal(trace.status, undefined);
});

test("route 세분화(#63 A) — tools/call 은 mcp_<툴명>, 프로토콜 단계·모르는 툴은 그대로", async () => {
  const t1 = {};
  await handleMcp(rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, t1, mkDeps());
  assert.equal(t1.route, "mcp_query_product");
  const t2 = {};
  await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, t2, mkDeps());
  assert.equal(t2.route, "mcp_list_products");
  const t3 = { route: "mcp" };
  await handleMcp(rpc("initialize"), {}, t3, mkDeps());
  assert.equal(t3.route, "mcp");                       // 발견 단계는 세분화하지 않는다
  const t4 = { route: "mcp" };
  await handleMcp(rpc("tools/call", { name: "bogus_tool", arguments: {} }), {}, t4, mkDeps());
  assert.equal(t4.route, "mcp");                       // 모르는 이름이 값 집합을 오염시키지 않는다
});

test("버스트로 거부돼도 route 는 mcp_<툴명> — 거부분이 SERVE 집계에서 빠지지 않는다", async () => {
  const trace = {};
  const deps = mkDeps({ checkBurst: async () => ({ exceeded: true, retryAfter: 30 }) });
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, trace, deps);
  assert.equal(res.status, 429);                       // #61: HTTP 429 + Retry-After
  assert.equal(trace.route, "mcp_query_product");      // #63 A: REST 와 같이 거부도 제 이름으로
});

test("query_product 성공 응답에 data_context 동봉 — 신선도·경고·출처·주의", async () => {
  const deps = mkDeps({
    handleData: async (_e, id, _p, _k, _t, opts) => jsonRes({
      id, rows: [],
      ...(opts?.includeMeta ? { product_meta: { description: "공식 특보 아님", freshness: "2026-08-04T00:00:00Z", serving_status: "degraded" } } : {}),
    }),
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, {}, deps);
  const payload = JSON.parse((await res.json()).result.content[0].text);
  assert.equal(payload.data_context.freshness, "2026-08-04T00:00:00Z");
  assert.match(payload.data_context.warning, /degraded/);           // published 아니면 경고
  assert.match(payload.data_context.attribution, /공공 원천/);   // 정본 상수(shared.ATTRIBUTION)와 동일 문구
  assert.equal(payload.data_context.caution, "공식 특보 아님");
});

test("product_meta 가 없으면 data_context 없이 데이터만 나간다 — 가드레일은 덤", async () => {
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.data_context, undefined);
  assert.equal(payload.product_meta, undefined);   // 운반용 필드가 밖으로 새지 않는다
});

test("없는 제품 404 — 카탈로그에서 비슷한 이름을 제안한다", async () => {
  const deps = mkDeps({
    handleData: async () => jsonRes({ type: "not found" }, 404),
    handleCatalog: async () => jsonRes({ products: [
      { product_id: "citydata_ppltn_daily" }, { product_id: "citydata_ppltn_hourly" }, { product_id: "commerce_flow_monthly" },
    ] }),
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "citydata_pplnt_daily" } }), {}, {}, deps);
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /citydata_ppltn_daily/);                       // 오타 교정 제안
  assert.doesNotMatch(text, /commerce_flow_monthly/);               // 안 비슷한 건 안 끼움
});

test("제안 계산이 실패해도 404 안내는 나간다", async () => {
  const deps = mkDeps({
    handleData: async () => jsonRes({ type: "not found" }, 404),
    handleCatalog: async () => { throw new Error("boom"); },
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "nope" } }), {}, {}, deps);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /없는 제품/);
});

test("describe_product 404 도 유사 제품을 제안한다 — 세 경로 공통 회귀 방지", async () => {
  const deps = mkDeps({
    handleProductBundle: async () => jsonRes({ type: "not found" }, 404),
    handleCatalog: async () => jsonRes({ products: [{ product_id: "culture_activity_by_dong" }] }),
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "describe_product", arguments: { product_id: "culture_activity_dong" } }), {}, {}, deps);
  assert.match((await res.json()).result.content[0].text, /culture_activity_by_dong/);
});


test("run_pattern — deps 로 위임, route 는 mcp_run_pattern", async () => {
  const trace = {};
  const res = await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "top", params: { n: 5 } } }),
    {}, trace, mkDeps());
  const payload = JSON.parse((await res.json()).result.content[0].text);
  assert.equal(payload.pattern_id, "top");
  assert.equal(trace.route, "mcp_run_pattern");
});

test("run_pattern — 필수 인자 없으면 안내", async () => {
  const res = await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p" } }), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /pattern_id/);
});

// ── 안내 문구가 사건과 맞는가 (2026-08-08 전수 평가에서 드러난 결함) ──────────────
// 상태 코드만 보고 문구를 고르면 `run_pattern` 에서 안내가 본문 detail 과 반대를 말한다.
// 실측에서 AI 가 없는 pattern_id 를 지어냈는데 "없는 제품입니다 — list_products" 안내를 받고
// 제품 목록으로 되돌아가 왕복을 낭비했다. 안내가 틀리면 없느니만 못하다.

test("없는 패턴 404 — 제품이 아니라 패턴 문제라고 말하고, 실행 가능한 pattern_id 를 준다", async () => {
  const deps = mkDeps({
    handleRunPattern: async () => jsonRes({ title: "unknown pattern", detail: "'nope' 는 'p' 의 패턴에 없다" }, 404),
    handleProductBundle: async (_e, pid) => jsonRes({
      product_id: pid,
      patterns: [
        { pattern_id: "top_dong", runnable: true },
        { pattern_id: "hourly_peak", runnable: true },
        { pattern_id: "미검증", runnable: false },   // 권하면 다음 호출이 409 로 끝난다
      ],
    }),
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "hotspot-top-grids" } }),
    {}, {}, deps);
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /패턴이 아닙니다/);
  assert.doesNotMatch(text, /없는 제품입니다/, "제품은 멀쩡한데 제품 탓을 했다");
  assert.match(text, /top_dong · hourly_peak/);
  assert.doesNotMatch(text, /미검증/, "실행 못 하는 패턴을 권했다");
});

test("패턴 목록 조회가 실패해도 404 안내는 나간다", async () => {
  const deps = mkDeps({
    handleRunPattern: async () => jsonRes({ title: "unknown pattern" }, 404),
    handleProductBundle: async () => { throw new Error("boom"); },
  });
  const res = await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "nope" } }), {}, {}, deps);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /usage_patterns/);
});

test("없는 패턴 404 는 로그에도 404 로 남는다 — 목록 조회(200)가 덮지 않는다", async () => {
  const trace = {};
  const deps = mkDeps({ handleRunPattern: async () => jsonRes({ title: "unknown pattern" }, 404) });
  await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "nope" } }), {}, trace, deps);
  assert.equal(trace.status, 404);
});

test("run_pattern 의 400·409 는 제 사건으로 안내한다 — 컬럼·커서 문구를 쓰지 않는다", async () => {
  const bad = mkDeps({ handleRunPattern: async () => jsonRes({ detail: "파라미터 :n 값이 필요하다" }, 400) });
  const t1 = (await (await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "x" } }), {}, {}, bad)).json())
    .result.content[0].text;
  assert.match(t1, /pattern_id 와 필요한 파라미터/);
  assert.doesNotMatch(t1, /없는 필터/);

  const unverified = mkDeps({ handleRunPattern: async () => jsonRes({ title: "pattern not verified" }, 409) });
  const t2 = (await (await handleMcp(
    rpc("tools/call", { name: "run_pattern", arguments: { product_id: "p", pattern_id: "x" } }), {}, {}, unverified)).json())
    .result.content[0].text;
  assert.match(t2, /검증되지 않아/);
  assert.doesNotMatch(t2, /커서/);
});

test("다른 툴의 400·409 안내는 그대로다 — 덮어쓰기가 새지 않는다", async () => {
  const deps = mkDeps({ handleData: async () => jsonRes({ title: "cursor expired" }, 409) });
  const text = (await (await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "p" } }), {}, {}, deps)).json())
    .result.content[0].text;
  assert.match(text, /커서가 만료/);
});
