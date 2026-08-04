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
  handleCatalog: async () => jsonRes({ products: [{ product_id: "citydata_ppltn_daily" }] }),
  handleMe: async () => jsonRes({ used: 3, quota: 100, exceeded: false }),
  handleProductBundle: async (_e, pid) => jsonRes({ product_id: pid, columns: [], usage_patterns: [] }),
  handlePreview: async (_e, table) => jsonRes({ table, preview: true, rows: [{ a: 1 }] }),
  handleData: async (_e, table) => jsonRes({ table, rows: [] }),
  ...over,
});
const envStub = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ name: "gold_citydata_ppltn_daily" }) }) }) } };

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

test("tools/call query_product — product_id→table 해석 후 handleData", async () => {
  const res = await handleMcp(
    rpc("tools/call", { name: "query_product", arguments: { product_id: "citydata_ppltn_daily", limit: 10 } }),
    envStub, {}, mkDeps());
  const body = await res.json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.table, "gold_citydata_ppltn_daily");
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
