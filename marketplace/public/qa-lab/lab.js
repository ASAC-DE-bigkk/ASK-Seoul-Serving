/* qa-lab/lab.js — 실험 콘솔 로직 (자체 완결, 외부 의존 없음).
 *
 * 하는 일: MCP(/mcp JSON-RPC)·REST(/api/v1) 요청을 그대로 만들어 보내고, 상태·소요시간·
 * 쿼터·본문을 보여준다. 게이트웨이 근간 코드는 건드리지 않는다 — 이 파일은 그 API 를
 * "밖에서 쓰는 소비자"일 뿐이다.
 *
 * 🔴 식별자: 우리 컴퓨터가 남긴 요청임을 로그에서 알아볼 수 있게 max20_fable 를 실어 보낸다.
 *    MCP  → initialize 의 clientInfo.name(agent_name) + 툴 인자 intent
 *    REST → X-ASK-Intent 헤더(intent 컬럼)
 */
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 테마 ─────────────────────────────────────────────
(function theme() {
  const btn = $("themeBtn");
  const stored = localStorage.getItem("qa-lab:theme");
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  btn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark"
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("qa-lab:theme", next);
  });
})();

// ── 상태 ─────────────────────────────────────────────
const state = { transport: "mcp", tool: null, initialized: false, catalog: null, lastResult: null };
const baseUrl = () => ($("baseUrl").value || "").trim().replace(/\/+$/, "");
const clientId = () => ($("intent").value || "max20_fable").trim();
const apiKey = () => ($("apiKey").value || "").trim();

// ── 도구 정의 ────────────────────────────────────────
// f: 폼 필드. as: as-is/to-be 표식(라벨용). needsKey: 키 필요 여부.
const F = {
  product: { name: "product_id", label: "product_id", type: "text", ph: "예: commerce_address_succession" },
  patternId: { name: "pattern_id", label: "pattern_id", type: "text", ph: "예: category_net_flow" },
  filters: { name: "filters", label: "filters (JSON, 등가 필터)", type: "json", ph: '{"gu_code":"11680"}' },
  params: { name: "params", label: "params (JSON, 패턴 :이름 값)", type: "json", ph: '{"n":10}' },
  from: { name: "from", label: "from (시간축 시작)", type: "text", ph: "예: 2024" },
  to: { name: "to", label: "to (시간축 끝)", type: "text", ph: "예: 2025" },
  limit: { name: "limit", label: "limit", type: "text", ph: "기본 500 · 최대 5000" },
  cursor: { name: "cursor", label: "cursor (다음 페이지)", type: "text", ph: "이전 응답 next_cursor" },
  vocab: { name: "vocabulary_id", label: "vocabulary_id (선택)", type: "text", ph: "비우면 전체" },
};
const MCP_TOOLS = [
  { id: "list_products", desc: "제품 57종 목록·대표질문·조인키 — 무차감. 어떤 데이터가 맞는지 고를 때 가장 먼저.", f: [] },
  { id: "describe_product", desc: "컬럼 설명·시간축·질의 패턴(usage_patterns) — 무차감. 조회 전에 스키마 확인.", f: [F.product] },
  { id: "preview_product", desc: "데이터 5행 미리보기 — 무차감. 필터에 넣을 실제 값 확인.", f: [F.product] },
  { id: "query_product", as: "as", desc: "기존형(AS-IS) — 지역·기간·등가 필터 조회. 정렬·집계·조인 불가. 일 1,000회 차감.", f: [F.product, F.filters, F.from, F.to, F.limit, F.cursor], needsKey: true },
  { id: "run_pattern", as: "to", desc: "신설형(TO-BE) — 도메인이 게시·검증한 패턴 SQL 을 서버가 실행(정렬·집계·서브쿼리 포함). insight 동봉. 일 1,000회 차감.", f: [F.product, F.patternId, F.params], needsKey: true },
  { id: "check_quota", desc: "내 키의 오늘 사용량·남은 한도 — 무차감.", f: [], needsKey: true },
];
const REST_EPS = [
  { id: "catalog", desc: "GET /api/v1/catalog — 공개 제품 목록(+usage_patterns) · 무인증.", f: [] },
  { id: "preview", desc: "GET /api/v1/preview/<product_id> — 5행 미리보기 · 무인증.", f: [F.product] },
  { id: "data", as: "as", desc: "기존형(AS-IS) GET /api/v1/data/<product_id> — query_product 와 같은 계약. 필터는 쿼리스트링.", f: [F.product, F.filters, F.from, F.to, F.limit, F.cursor], needsKey: true },
  { id: "me", desc: "GET /api/v1/me — 내 사용량(이메일 포함, 본인 응답).", f: [], needsKey: true },
  { id: "product", desc: "GET /api/v1/products/<product_id> — 제품 번들(describe 계열).", f: [F.product], needsKey: true },
  { id: "glossary", desc: "GET /api/v1/glossary — 용어 사전.", f: [F.vocab], needsKey: true },
];
const toolsFor = (t) => (t === "mcp" ? MCP_TOOLS : REST_EPS);

// ── 폼 렌더 ──────────────────────────────────────────
function fillToolSelect() {
  const sel = $("toolSel");
  sel.innerHTML = "";
  for (const t of toolsFor(state.transport)) {
    const label = t.as === "as" ? `${t.id}  ⟨기존형·AS-IS⟩` : t.as === "to" ? `${t.id}  ⟨신설형·TO-BE⟩` : t.id;
    sel.append(el("option", { value: t.id }, document.createTextNode(label)));
  }
  state.tool = sel.value;
  renderForm();
}
function currentTool() { return toolsFor(state.transport).find((t) => t.id === state.tool); }

function renderForm() {
  const t = currentTool();
  $("toolDesc").textContent = t ? t.desc : "";
  const wrap = $("formFields");
  wrap.innerHTML = "";
  for (const f of (t ? t.f : [])) {
    const id = "f_" + f.name;
    const field = el("div");
    field.append(el("label", { for: id }, document.createTextNode(f.label)));
    const input = f.type === "json"
      ? el("textarea", { id, placeholder: f.ph })
      : el("input", { id, type: "text", placeholder: f.ph });
    field.append(input);
    wrap.append(field);
  }
  // 예시 칩
  renderExamples(t);
  const tag = $("toolTag");
  if (t && t.needsKey && !apiKey()) { tag.style.display = ""; tag.textContent = "이 도구는 API 키가 필요합니다"; }
  else tag.style.display = "none";
}

function renderExamples(t) {
  const box = $("exampleChips");
  box.innerHTML = "";
  const add = (text, apply) => { const c = el("button", { class: "chip", type: "button" }, document.createTextNode(text)); c.addEventListener("click", apply); box.append(c); };
  if (!t) return;
  if (t.id === "query_product" || t.id === "data") {
    add("commerce_churn_yearly · gu 필터", () => { setField("product_id", "commerce_churn_yearly"); setField("filters", '{"gu_code":"11680"}'); setField("limit", "20"); });
    add("citydata_ppltn_dow_hour", () => { setField("product_id", "citydata_ppltn_dow_hour"); setField("limit", "10"); });
  } else if (t.id === "run_pattern") {
    add("승계 순유입 (category_net_flow)", () => { setField("product_id", "commerce_address_succession"); setField("pattern_id", "category_net_flow"); setField("params", "{}"); });
    add("품질 프로파일 (dataset_profile_lookup)", () => { setField("product_id", "commerce_data_quality"); setField("pattern_id", "dataset_profile_lookup"); setField("params", "{}"); });
  } else if (t.f.some((x) => x.name === "product_id")) {
    add("commerce_address_succession", () => setField("product_id", "commerce_address_succession"));
    add("commerce_cohort_survival", () => setField("product_id", "commerce_cohort_survival"));
  }
}
const setField = (name, val) => { const n = $("f_" + name); if (n) n.value = val; };
const getField = (name) => { const n = $("f_" + name); return n ? n.value.trim() : ""; };

// ── 전송 ─────────────────────────────────────────────
$("transportSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (!b) return;
  state.transport = b.dataset.t;
  [...$("transportSeg").children].forEach((x) => x.setAttribute("aria-pressed", x === b));
  fillToolSelect();
  updateCorsNote();
});
$("toolSel").addEventListener("change", (e) => { state.tool = e.target.value; renderForm(); });
$("apiKey").addEventListener("input", () => renderForm());

function parseJsonField(name) {
  const raw = getField(name);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return (v && typeof v === "object") ? v : {}; }
  catch { throw new Error(`${name} 이 올바른 JSON 이 아닙니다: ${raw}`); }
}

// MCP: initialize (식별자 등록) → 필요 시 자동 선행
async function mcpInitialize() {
  const body = { jsonrpc: "2.0", id: Date.now(), method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: clientId(), version: "qa-lab" } } };
  const res = await fetch(baseUrl() + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  state.initialized = res.ok && json && json.result;
  return { body, res, json };
}

async function sendMcp(t) {
  // 식별자 마커(agent_name=max20_fable)를 남기려면 initialize 가 한 번은 나가야 한다
  if (!state.initialized) { try { await mcpInitialize(); } catch { /* 아래에서 함께 실패 처리 */ } }
  const args = {};
  for (const f of t.f) {
    if (f.type === "json") { const o = parseJsonField(f.name); if (Object.keys(o).length) args[f.name] = o; }
    else { const v = getField(f.name); if (v !== "") args[f.name] = f.name === "limit" ? Number(v) : v; }
  }
  // 조회·패턴에는 식별자 intent 를 함께 싣는다
  if (t.id === "query_product" || t.id === "run_pattern") args.intent = clientId();
  const body = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: t.id, arguments: args } };
  const headers = { "content-type": "application/json" };
  if (apiKey()) headers.authorization = "Bearer " + apiKey();
  const res = await fetch(baseUrl() + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  return { req: { url: baseUrl() + "/mcp", method: "POST", headers: redactHeaders(headers), body }, res, json, text };
}

async function sendRest(t) {
  let path = "/api/v1/";
  const pid = getField("product_id");
  const qp = new URLSearchParams();
  if (t.id === "catalog") path += "catalog";
  else if (t.id === "preview") path += "preview/" + encodeURIComponent(pid);
  else if (t.id === "data") path += "data/" + encodeURIComponent(pid);
  else if (t.id === "me") path += "me";
  else if (t.id === "product") path += "products/" + encodeURIComponent(pid);
  else if (t.id === "glossary") { path += "glossary"; const v = getField("vocabulary_id"); if (v) qp.set("vocabulary_id", v); }
  if (t.id === "data") {
    const filters = parseJsonField("filters");
    for (const [k, v] of Object.entries(filters)) qp.set(k, String(v));
    for (const k of ["from", "to", "limit", "cursor"]) { const v = getField(k); if (v) qp.set(k, v); }
  }
  const url = baseUrl() + path + (qp.toString() ? "?" + qp.toString() : "");
  const headers = { "x-ask-intent": clientId() };   // REST 식별자 마커(intent 컬럼)
  if (apiKey()) headers.authorization = "Bearer " + apiKey();
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  return { req: { url, method: "GET", headers: redactHeaders(headers) }, res, json, text };
}

const redactHeaders = (h) => { const o = { ...h }; if (o.authorization) o.authorization = "Bearer ask_…(마스킹)"; return o; };

$("sendBtn").addEventListener("click", async () => {
  const t = currentTool();
  if (!t) return;
  const btn = $("sendBtn"); btn.disabled = true;
  setMeta("wait", "요청 중…", "");
  const t0 = performance.now();
  try {
    const out = state.transport === "mcp" ? await sendMcp(t) : await sendRest(t);
    const ms = Math.round(performance.now() - t0);
    renderResult(t, out, ms);
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const cors = state.transport === "mcp" && !isSameOrigin();
    setMeta("s5", "요청 실패", `${ms}ms`);
    $("resDump").textContent = String(err && err.message || err) + (cors ? "\n\n⚠️ MCP 는 동일 출처에서만 브라우저로 호출됩니다. base 를 비워 현재 출처를 쓰거나, 게이트웨이와 같은 호스트에서 이 페이지를 여세요." : "");
    $("reqDump").textContent = "—";
  } finally { btn.disabled = false; }
});
$("clearBtn").addEventListener("click", () => { setMeta("wait", "대기", ""); $("reqDump").textContent = "—"; $("resDump").textContent = "—"; $("resultTable").innerHTML = ""; $("copyForCompareBtn").disabled = true; $("copyState").textContent = ""; });

// ── 결과 렌더 ────────────────────────────────────────
function setMeta(cls, statusText, extra) {
  const meta = $("resultMeta");
  meta.innerHTML = "";
  meta.append(el("span", { class: "status " + cls }, document.createTextNode(statusText)));
  if (extra) meta.append(el("span", { class: "kv" }, document.createTextNode(extra)));
  return meta;
}

function renderResult(t, out, ms) {
  const { req, res, json, text } = out;
  const http = res.status;
  // MCP: HTTP 200 이라도 툴 봉투가 isError 이거나 JSON-RPC error 면 실패로 본다
  let payload = json, isErr = http >= 400, note = "";
  if (state.transport === "mcp" && json) {
    if (json.error) { isErr = true; note = "JSON-RPC error"; payload = json.error; }
    else if (json.result && Array.isArray(json.result.content)) {
      const textNode = json.result.content.find((c) => c.type === "text");
      let parsed = null; if (textNode) { try { parsed = JSON.parse(textNode.text); } catch { parsed = textNode.text; } }
      if (json.result.isError) { isErr = true; note = "MCP 오류 봉투 (isError)"; }
      payload = parsed;
    } else if (json.result) payload = json.result;
  }
  const cls = isErr ? (http >= 500 ? "s5" : "s4") : "s2";
  const meta = setMeta(cls, `${state.transport === "mcp" ? "MCP" : "HTTP"} ${http}${note ? " · " + note : ""}`, `${ms}ms`);
  // 쿼터
  const q = readQuota(res, payload);
  if (q) meta.append(el("span", { class: "kv", html: `쿼터 <b>${q.used}</b>/<b>${q.quota}</b>` }));
  // 행 수
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : null;
  if (rows) meta.append(el("span", { class: "kv", html: `행 <b>${payload.row_count ?? rows.length}</b>${payload.has_more ? " · 더 있음" : ""}` }));

  // 표
  const tbl = $("resultTable"); tbl.innerHTML = "";
  if (rows && rows.length) tbl.append(buildRowsTable(rows));

  $("reqDump").textContent = JSON.stringify(req, null, 2);
  $("resDump").textContent = payload !== undefined && payload !== null ? JSON.stringify(payload, null, 2) : (text || "(빈 응답)");

  state.lastResult = {
    ts: new Date().toISOString(), source: "marketplace-qa-lab", client_id: clientId(),
    transport: state.transport, tool: t.id, as_to: t.as === "as" ? "as-is" : t.as === "to" ? "to-be" : null,
    http_status: http, is_error: isErr, ms,
    product_id: getField("product_id") || null, pattern_id: getField("pattern_id") || null,
    row_count: payload && payload.row_count != null ? payload.row_count : (rows ? rows.length : null),
    quota: q || null,
    insight_sample_ko: payload && payload.insight_sample_ko || null,
  };
  $("copyForCompareBtn").disabled = false;
  $("copyState").textContent = "";
}

function readQuota(res, payload) {
  const limit = res.headers.get("x-ratelimit-limit");
  if (limit && payload && payload.usage) return { used: payload.usage.used, quota: payload.usage.daily_quota };
  if (payload && payload.usage) return { used: payload.usage.used, quota: payload.usage.daily_quota };
  if (payload && payload.used_today != null) return { used: payload.used_today, quota: payload.daily_quota };
  return null;
}

function buildRowsTable(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
  const box = el("div", { class: "tblbox" });
  const table = el("table", { class: "tbl" });
  const thead = el("tr");
  cols.forEach((c) => thead.append(el("th", {}, document.createTextNode(c))));
  table.append(el("thead", {}, thead));
  const tbody = el("tbody");
  rows.slice(0, 50).forEach((r) => {
    const tr = el("tr");
    cols.forEach((c) => { const v = r[c]; tr.append(el("td", {}, document.createTextNode(v == null ? "" : String(v)))); });
    tbody.append(tr);
  });
  table.append(tbody);
  box.append(table);
  if (rows.length > 50) box.append(el("div", { class: "kv", style: "padding:.4rem" }, document.createTextNode(`상위 50행 표시 / 총 ${rows.length}행`)));
  return box;
}

// ── 비교용 복사 ──────────────────────────────────────
$("copyForCompareBtn").addEventListener("click", async () => {
  if (!state.lastResult) return;
  const txt = JSON.stringify(state.lastResult, null, 2);
  try { await navigator.clipboard.writeText(txt); $("copyState").textContent = "복사됨 — 대시보드 QA-Lab 의 붙여넣기 칸에 넣으세요."; }
  catch { $("copyState").textContent = "클립보드 권한이 없어 복사하지 못했습니다 — 응답 창의 JSON 을 직접 복사하세요."; }
});

// ── 연결 확인 / CORS 안내 ───────────────────────────
const isSameOrigin = () => { const b = baseUrl(); if (!b) return true; try { return new URL(b, location.href).origin === location.origin; } catch { return false; } };
function updateCorsNote() {
  const note = $("corsNote");
  if (state.transport === "mcp" && !isSameOrigin()) {
    note.style.display = "";
    note.innerHTML = "⚠️ MCP(<span class='mono'>/mcp</span>) 응답에는 CORS 헤더가 없어 <b>다른 출처</b>에서는 브라우저가 응답을 못 읽습니다. base 를 비워 현재 출처를 쓰거나, 게이트웨이와 같은 호스트에서 이 페이지를 여세요. REST(<span class='mono'>/api/v1</span>)는 교차 출처도 됩니다.";
  } else note.style.display = "none";
  updateCliCmd();
}
function updateCliCmd() {
  const b = baseUrl() || (location.origin + (location.origin.includes("localhost") ? "" : ""));
  const endpoint = (baseUrl() || location.origin) + "/mcp";
  $("cliCmd").textContent = `claude mcp add --transport http ask-seoul ${endpoint} --header "Authorization: Bearer ask_발급받은키"`;
}
["baseUrl", "intent"].forEach((id) => $(id).addEventListener("input", updateCorsNote));

$("connectBtn").addEventListener("click", async () => {
  $("connState").textContent = "연결 확인 중…";
  const t0 = performance.now();
  try {
    const { res, json } = await mcpInitialize();
    const ms = Math.round(performance.now() - t0);
    if (json && json.result) {
      const si = json.result.serverInfo || {};
      $("connState").innerHTML = `<span style="color:var(--ok)">✔ 연결됨</span> — 서버 <b>${escapeHtml(si.name || "?")} v${escapeHtml(si.version || "?")}</b> · protocol ${escapeHtml(json.result.protocolVersion || "?")} · ${ms}ms · 식별자 <span class="mono">${escapeHtml(clientId())}</span> 등록`;
    } else { $("connState").innerHTML = `<span style="color:var(--err)">응답 형식 이상</span> (HTTP ${res.status})`; }
  } catch (err) {
    $("connState").innerHTML = `<span style="color:var(--err)">연결 실패</span> — ${escapeHtml(String(err && err.message || err))}${isSameOrigin() ? "" : " (교차 출처 MCP는 차단됩니다)"}`;
  }
});

// ── 제품 목록 ────────────────────────────────────────
$("loadCatalogBtn").addEventListener("click", async () => {
  $("connState").textContent = "제품 목록 불러오는 중…";
  try {
    const res = await fetch(baseUrl() + "/api/v1/catalog", { headers: { "x-ask-intent": clientId() } });
    const json = await res.json();
    state.catalog = json.products || [];
    $("connState").innerHTML = `제품 <b>${state.catalog.length}</b>종 로드됨`;
    renderBrowser();
  } catch (err) { $("connState").innerHTML = `<span style="color:var(--err)">목록 로드 실패</span> — ${escapeHtml(String(err && err.message || err))}`; }
});

function renderBrowser(filter = "") {
  const card = $("browserCard"); card.style.display = "";
  const rows = (state.catalog || []).filter((p) => {
    if (!filter) return true;
    const hay = (p.product_id + " " + (p.usage_patterns || []).map((x) => x.question_ko).join(" ")).toLowerCase();
    return hay.includes(filter.toLowerCase());
  });
  const patTotal = (state.catalog || []).reduce((a, p) => a + (p.usage_patterns || []).length, 0);
  $("browserCount").textContent = `— 제품 ${(state.catalog || []).length}종 · 패턴 ${patTotal}건`;
  const table = $("browserTbl"); table.innerHTML = "";
  const head = el("tr");
  ["product_id", "time_axis", "cols", "patterns", "대표 질문"].forEach((h) => head.append(el("th", {}, document.createTextNode(h))));
  table.append(el("thead", {}, head));
  const body = el("tbody");
  rows.slice(0, 200).forEach((p) => {
    const pats = p.usage_patterns || [];
    const cols = Array.isArray(p.columns) ? p.columns.length : "?";
    const tr = el("tr");
    const idCell = el("td");
    const idLink = el("span", { class: "linkish" }, document.createTextNode(p.product_id));
    idLink.addEventListener("click", () => { setField("product_id", p.product_id); window.scrollTo({ top: 0, behavior: "smooth" }); });
    idCell.append(idLink);
    tr.append(idCell);
    tr.append(el("td", {}, document.createTextNode(p.time_axis || "—")));
    tr.append(el("td", {}, document.createTextNode(String(cols))));
    const pc = el("td");
    if (pats.length) {
      const pl = el("span", { class: "linkish" }, document.createTextNode(pats.length + "개"));
      pl.addEventListener("click", () => { openPatternPicker(p); });
      pc.append(pl);
    } else pc.append(document.createTextNode("0"));
    tr.append(pc);
    tr.append(el("td", { style: "white-space:normal;max-width:340px" }, document.createTextNode((pats[0] && pats[0].question_ko || "").slice(0, 70))));
    body.append(tr);
  });
  table.append(body);
  if (rows.length > 200) body.append(el("tr", {}, el("td", { colspan: "5", class: "kv" }, document.createTextNode(`상위 200종 표시 / ${rows.length}종 검색됨`))));
}
$("browserFilter").addEventListener("input", (e) => renderBrowser(e.target.value));

function openPatternPicker(p) {
  // run_pattern 폼으로 전환하고 첫 패턴을 채운다
  state.transport = "mcp"; [...$("transportSeg").children].forEach((x) => x.setAttribute("aria-pressed", x.dataset.t === "mcp"));
  fillToolSelect();
  $("toolSel").value = "run_pattern"; state.tool = "run_pattern"; renderForm();
  const pats = p.usage_patterns || [];
  setField("product_id", p.product_id);
  if (pats[0]) { setField("pattern_id", pats[0].pattern_id); setField("params", "{}"); }
  // 패턴 목록을 예시 칩으로
  const box = $("exampleChips"); box.innerHTML = "";
  pats.slice(0, 12).forEach((pat) => {
    const c = el("button", { class: "chip", type: "button", title: pat.question_ko || "" }, document.createTextNode(pat.pattern_id));
    c.addEventListener("click", () => { setField("pattern_id", pat.pattern_id); setField("params", "{}"); });
    box.append(c);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── 승격 후보 미리보기 (P1·P3, pattern-plus.js) ─────────────────────────────
function findPatternSql(pid, patId) {
  const p = (state.catalog || []).find((x) => x.product_id === pid);
  if (!p) return null;
  const pat = (p.usage_patterns || []).find((x) => x.pattern_id === patId) || (p.usage_patterns || [])[0];
  return pat ? { sql: pat.sql, pattern_id: pat.pattern_id, question: pat.question_ko } : null;
}
function autofillPpSql() {
  const pid = $("pp_product").value.trim(), patId = $("pp_pattern").value.trim();
  if (!pid) return;
  const hit = findPatternSql(pid, patId);
  if (hit) { if (!patId) $("pp_pattern").value = hit.pattern_id; if (hit.sql) { $("pp_sql").value = hit.sql; $("ppState").textContent = `SQL 채움: ${hit.pattern_id}`; } }
}
$("pp_product").addEventListener("change", autofillPpSql);
$("pp_pattern").addEventListener("change", autofillPpSql);
$("ppRun").addEventListener("click", () => {
  const sql = $("pp_sql").value;
  if (!sql.trim()) { $("ppState").innerHTML = '<span style="color:var(--warn)">패턴 SQL 이 비어 있습니다.</span>'; return; }
  let params = {}, defaults = {};
  try { const r = $("pp_params").value.trim(); params = r ? JSON.parse(r) : {}; } catch { $("ppState").innerHTML = '<span style="color:var(--err)">params JSON 오류</span>'; return; }
  try { const r = $("pp_defaults").value.trim(); defaults = r ? JSON.parse(r) : {}; } catch { $("ppState").innerHTML = '<span style="color:var(--err)">param_defaults JSON 오류</span>'; return; }
  const out = PatternPlus.convert(sql, params, { defaults });
  if (out.ok) {
    $("ppSql").textContent = out.converted;
    $("ppVals").textContent = JSON.stringify(out.values, null, 2) + `\n\n// 선언 파라미터: [${out.declared.join(", ")}]`;
    $("ppState").innerHTML = `<span style="color:var(--ok)">변환 OK</span> — bind ${out.values.length}개`;
  } else {
    $("ppSql").textContent = "(변환 거부)";
    $("ppVals").textContent = JSON.stringify(out.problem, null, 2);
    $("ppState").innerHTML = `<span style="color:var(--err)">problem+json ${out.problem.status}</span> — ${escapeHtml(out.problem.title)}`;
  }
});

// ── 초기화 ───────────────────────────────────────────
fillToolSelect();
updateCorsNote();
$("clientTag").textContent = clientId();
$("intent").addEventListener("input", () => { $("clientTag").textContent = clientId(); state.initialized = false; });
