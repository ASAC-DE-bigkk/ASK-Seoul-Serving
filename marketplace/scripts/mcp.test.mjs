// MCP 서버 스모크 — 프로토콜(initialize/tools-list)은 D1 불필요, tools/call 은 deps 목킹.
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("tools/list — P0 5개 툴", async () => {
  const res = await handleMcp(rpc("tools/list"), {}, {}, mkDeps());
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_products", "describe_product", "preview_product", "query_product", "check_quota"]);
  for (const t of body.result.tools) assert.ok(t.inputSchema && t.description);
});

test("tools/call list_products — 인증 후 handleCatalog 재사용", async () => {
  const res = await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, {}, mkDeps());
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.products[0].product_id, "citydata_ppltn_daily");
});

test("list_products — 검증 번들과 일반 카탈로그를 구분(verified)", async () => {
  const deps = mkDeps({
    handleCatalog: async () => jsonRes({
      products: [
        { product_id: "citydata_purchasing_power_daily" }, // exact-six(#4)
        { product_id: "citydata_ppltn_daily" },            // 일반 카탈로그
      ],
    }),
  });
  const res = await handleMcp(rpc("tools/call", { name: "list_products", arguments: {} }), {}, {}, deps);
  const payload = JSON.parse((await res.json()).result.content[0].text);
  assert.equal(payload.verified_bundle, "seoul-urban-analytics");
  assert.equal(payload.products[0].verified, true);
  assert.equal(payload.products[1].verified, false);
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
