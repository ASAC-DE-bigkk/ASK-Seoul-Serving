/* ops-dashboard qa-lab/lab.js — AS-IS/TO-BE 비교 로직 (자체 완결, 외부 의존 없음).
 *
 * 비교 근거는 게이트웨이 /api/v1/catalog 의 usage_patterns 메타다. 각 패턴은 답하는 데
 * 필요한 SQL 능력을 requires 로 선언한다(select_columns·sort·aggregate·group_by·…).
 * 기존형 query_product 는 등가 필터 + 시간축 범위만 지원하므로, 그 밖의 능력을 요구하는
 * 패턴은 신설형 run_pattern 없이는 답이 안 된다 — 그 사실을 지표로 보여준다.
 *
 * 근간(콘솔 src/·ui.css·index.html) 은 건드리지 않는다. 이 파일은 게이트웨이 API 소비자다.
 */
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v); }
  for (const kid of kids) n.append(kid); return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CLIENT_ID = "max20_fable";

// 테마
(function () {
  const stored = localStorage.getItem("qa-lab:theme"); if (stored) document.documentElement.setAttribute("data-theme", stored);
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next); localStorage.setItem("qa-lab:theme", next);
  });
})();

// ── 능력 분류 — 기존형 query_product 가 무엇을 지원하나 ──────────────────────
// full  = 기존형이 그대로 지원          · partial = 시간축(from/to)에 한해서만
// none  = 기존형이 서버에서 지원 안 함 → 신설형 필요
const CAP = {
  select_columns: { ko: "컬럼 선택", lvl: "full" },
  filter: { ko: "등가 필터", lvl: "full" },
  filter_range: { ko: "범위 필터", lvl: "partial", note: "기존형은 시간축(from/to)만" },
  filter_set: { ko: "다중값(IN) 필터", lvl: "none", issue: "#192 P3" },
  filter_null: { ko: "NULL 필터", lvl: "none" },
  sort: { ko: "정렬(ORDER BY)", lvl: "none" },
  aggregate: { ko: "집계(SUM·COUNT·AVG)", lvl: "none" },
  group_by: { ko: "그룹(GROUP BY)", lvl: "none" },
  having: { ko: "그룹 조건(HAVING)", lvl: "none" },
  window: { ko: "윈도우 함수", lvl: "none" },
  subquery: { ko: "서브쿼리", lvl: "none" },
  join: { ko: "조인(JOIN)", lvl: "none", issue: "#192 P7" },
};
const capMeta = (t) => CAP[t] || { ko: t, lvl: "none" };
const hardBlockers = (req) => (req || []).filter((r) => capMeta(r).lvl === "none");
const partials = (req) => (req || []).filter((r) => capMeta(r).lvl === "partial");
const asisAnswerable = (req) => hardBlockers(req).length === 0;

const state = { products: [], base: "https://ask-seoul.kr", live: {} };
const baseUrl = () => ($("baseUrl").value || "").trim().replace(/\/+$/, "");

// ── 카탈로그 로드 ───────────────────────────────────
$("loadBtn").addEventListener("click", async () => {
  $("loadState").textContent = "불러오는 중…";
  try {
    const res = await fetch(baseUrl() + "/api/v1/catalog", { headers: { "x-ask-intent": CLIENT_ID } });
    const json = await res.json();
    state.products = (json.products || []).filter((p) => (p.usage_patterns || []).length);
    $("loadState").innerHTML = `제품 <b>${state.products.length}</b>종 로드됨`;
    renderHeadline();
    fillProducts();
    $("headlineCard").classList.remove("hide");
    $("cmpCard").classList.remove("hide");
  } catch (err) {
    $("loadState").innerHTML = `<span style="color:var(--err)">로드 실패</span> — ${esc(String(err && err.message || err))}`;
    $("corsNote").style.display = ""; $("corsNote").innerHTML = "교차 출처 조회에 실패했습니다. base 주소를 확인하세요. (게이트웨이가 로컬이면 <span class='mono'>http://localhost:8787</span>)";
  }
});

// ── 헤드라인 스코어카드 ─────────────────────────────
function allPatterns() { return state.products.flatMap((p) => (p.usage_patterns || []).map((pat) => ({ p, pat }))); }
function renderHeadline() {
  const all = allPatterns();
  const total = all.length;
  const answerable = all.filter(({ pat }) => asisAnswerable(pat.requires)).length;
  const need = total - answerable;
  $("asisPct").textContent = pct(answerable, total);
  $("tobePct").textContent = pct(need, total);
  $("headlineHint").innerHTML = `도메인이 게시·검증한 질의 패턴 <b>${total}</b>개 기준. 기존형이 그대로 답할 수 있는 것은 <b>${answerable}</b>개, 신설형이 필요한 것은 <b>${need}</b>개.`;

  // 능력별 필요 비율
  const counts = {};
  for (const { pat } of all) for (const r of (pat.requires || [])) counts[r] = (counts[r] || 0) + 1;
  const bars = $("capBars"); bars.innerHTML = "";
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([tok, c]) => {
    const m = capMeta(tok);
    const p = Math.round((100 * c) / total);
    const row = el("div", { class: "bar" + (m.lvl === "none" ? " block" : "") });
    row.append(el("div", { html: `${esc(m.ko)}${m.issue ? ` <span class="kv">(${m.issue})</span>` : ""}${m.lvl === "partial" ? ' <span class="kv">(부분)</span>' : ""}` }));
    const track = el("div", { class: "track" }); track.append(el("div", { class: "fill", style: `width:${p}%` })); row.append(track);
    row.append(el("div", { class: "pct" }, document.createTextNode(`${c}개 · ${p}%`)));
    bars.append(row);
  });
}
const pct = (a, b) => b ? `${Math.round((100 * a) / b)}%` : "–";

// ── 제품/패턴 선택 ──────────────────────────────────
function fillProducts() {
  const sel = $("prodSel"); sel.innerHTML = "";
  state.products.forEach((p) => sel.append(el("option", { value: p.product_id }, document.createTextNode(`${p.product_id} (${(p.usage_patterns || []).length}패턴)`))));
  sel.onchange = fillPatterns; fillPatterns();
}
function fillPatterns() {
  const p = curProduct(); const sel = $("patSel"); sel.innerHTML = "";
  (p.usage_patterns || []).forEach((pat) => sel.append(el("option", { value: pat.pattern_id }, document.createTextNode(`${pat.pattern_id} — ${(pat.question_ko || "").slice(0, 42)}`))));
  sel.onchange = renderCompare; renderCompare();
}
const curProduct = () => state.products.find((p) => p.product_id === $("prodSel").value) || state.products[0];
const curPattern = () => { const p = curProduct(); return (p.usage_patterns || []).find((x) => x.pattern_id === $("patSel").value) || (p.usage_patterns || [])[0]; };

// ── 비교 렌더 ───────────────────────────────────────
function renderCompare() {
  const p = curProduct(), pat = curPattern();
  if (!p || !pat) return;
  $("qLine").innerHTML = `<b>질문</b> — ${esc(pat.question_ko || "(없음)")} &nbsp; <span class="kv">축: ${esc(pat.axes || "—")}</span>`;
  const req = pat.requires || [];
  const blockers = hardBlockers(req), parts = partials(req);
  const answerable = blockers.length === 0;

  // AS-IS 쪽
  const asis = $("asisBody"); asis.innerHTML = "";
  const capChips = el("div", { class: "chips" });
  req.forEach((r) => { const m = capMeta(r); const cls = m.lvl === "full" ? "ok" : m.lvl === "partial" ? "part" : "no"; capChips.append(el("span", { class: "cap " + cls, title: m.note || "" }, document.createTextNode(m.ko))); });
  asis.append(el("div", { class: "kv", text: "이 질문이 요구하는 능력 (빨강 = 기존형 미지원):" }), capChips);
  const live = state.live[key(p, pat)];
  const asisDl = el("dl");
  dlAdd(asisDl, "요청 방식", "컬럼별 등가 필터 + 시간축 from/to");
  dlAdd(asisDl, "답변 형태", "원시 행(정렬·집계 없음) — AI 가 직접 후처리");
  dlAdd(asisDl, "라이브 결과", live && live.asis ? `${live.asis.row_count}행 · ${live.asis.ms}ms (원시)` : "‘기존형 라이브 조회’ 버튼으로 확인");
  dlAdd(asisDl, "검증", "없음 (클라이언트 집계는 검증 불가)");
  asis.append(asisDl);
  asis.append(el("div", { class: "verdict " + (answerable ? "yes" : parts.length && !blockers.length ? "partial" : "no") },
    document.createTextNode(answerable ? "이 질문은 기존형으로도 답 가능" : `기존형으로 답 불가 — 미지원 능력 ${blockers.length}종: ${blockers.map((b) => capMeta(b).ko).join(", ")}`)));

  // TO-BE 쪽
  const tobe = $("tobeBody"); tobe.innerHTML = "";
  const tobeDl = el("dl");
  dlAdd(tobeDl, "요청 방식", `pattern_id 1개 선택 (${esc(pat.pattern_id)})`);
  dlAdd(tobeDl, "답변 형태", "서버가 계산한 결과 + 해석(insight_sample_ko)");
  const liveTobe = live && live.tobe;
  dlAdd(tobeDl, "결과 규모", liveTobe ? `${liveTobe.row_count}행 (라이브)` : (pat.verified_rows != null ? `${pat.verified_rows}행 (검증 기록)` : "—"));
  dlAdd(tobeDl, "검증", pat.verified_at ? `verified_at ${esc(String(pat.verified_at).slice(0, 10))}` : "미검증");
  tobe.append(tobeDl);
  if (pat.insight_sample_ko) tobe.append(el("div", { class: "verdict yes", style: "font-weight:600", html: "해석 예시 — " + esc(pat.insight_sample_ko) }));
  else tobe.append(el("div", { class: "verdict yes" }, document.createTextNode("이 질문에 맞춰 검증된 패턴")));

  renderMetricTable(p, pat, { answerable, blockers, parts, live });
}
function dlAdd(dl, k, v) { dl.append(el("dt", {}, document.createTextNode(k))); dl.append(el("dd", { html: v })); }
const key = (p, pat) => p.product_id + "::" + pat.pattern_id;

function renderMetricTable(p, pat, ctx) {
  const t = $("metricTbl"); t.innerHTML = "";
  const head = el("tr");
  ["지표", "기존형 · query_product (AS-IS)", "신설형 · run_pattern (TO-BE)"].forEach((h) => head.append(el("th", {}, document.createTextNode(h))));
  t.append(el("thead", {}, head));
  const body = el("tbody");
  const need = (pat.requires || []).length;
  const covered = need;
  const rows = [
    ["요청 범위(필요 능력)", `등가 필터·시간축만 지원 — 미지원 ${ctx.blockers.length}종`, `${covered}종 모두 커버(정렬·집계·그룹 등)`],
    ["답변 범위", "원시 행 반환 → 클라이언트 후처리 필요", "계산된 답 + 해석(insight) 동봉"],
    ["AI 질의 접근성", "컬럼 파악 → 필터 조립 → 후처리(서버 미지원)", "pattern_id 1개 선택 = 1회 호출"],
    ["정보 제공 정확성", "미검증(클라 집계 = 환각 위험)", pat.verified_at ? `검증됨 · ${pat.verified_rows ?? "?"}행 확인(${String(pat.verified_at).slice(0, 10)})` : "패턴 게시(검증 대기)"],
    ["이 질문 답 가능?", ctx.answerable ? "가능(단순 조회)" : (ctx.parts.length && !ctx.blockers.length ? "부분" : "불가"), "가능"],
  ];
  for (const [dim, a, b] of rows) {
    const tr = el("tr");
    tr.append(el("td", { class: "dim" }, document.createTextNode(dim)));
    tr.append(el("td", { class: "asis" }, document.createTextNode(a)));
    tr.append(el("td", { class: "tobe" }, document.createTextNode(b)));
    body.append(tr);
  }
  t.append(body);
}

// ── 기존형 라이브 조회 (/api/v1/data, 교차 출처 OK) ─────────────────────────
$("runAsisBtn").addEventListener("click", async () => {
  const p = curProduct(), pat = curPattern();
  const kkey = key(p, pat);
  const apiKey = ($("apiKey").value || "").trim();
  if (!apiKey) { $("asisLiveState").innerHTML = '<span style="color:var(--warn)">API 키가 필요합니다(선택 입력칸).</span>'; return; }
  $("asisLiveState").textContent = "조회 중…";
  const t0 = performance.now();
  try {
    const res = await fetch(baseUrl() + `/api/v1/data/${encodeURIComponent(p.product_id)}?limit=50`, { headers: { authorization: "Bearer " + apiKey, "x-ask-intent": CLIENT_ID } });
    const ms = Math.round(performance.now() - t0);
    const json = await res.json();
    if (res.ok) {
      state.live[kkey] = Object.assign(state.live[kkey] || {}, { asis: { row_count: json.row_count, ms, cols: json.rows && json.rows[0] ? Object.keys(json.rows[0]).length : 0 } });
      $("asisLiveState").innerHTML = `기존형 원시 조회: <b>${json.row_count}</b>행 · ${ms}ms — 정렬·집계 없이 그대로 받은 값(질문의 답이 아니라 재료)`;
    } else {
      $("asisLiveState").innerHTML = `<span style="color:var(--err)">HTTP ${res.status}</span> — ${esc(json.detail || json.title || "")}`;
    }
    renderCompare();
  } catch (err) { $("asisLiveState").innerHTML = `<span style="color:var(--err)">실패</span> — ${esc(String(err && err.message || err))}`; }
});

// ── 신설형 라이브 결과 붙여넣기 ─────────────────────
$("applyPasteBtn").addEventListener("click", () => {
  try {
    const o = JSON.parse($("pasteBox").value);
    if (o.tool !== "run_pattern" && o.tool !== "query_product") { $("pasteState").innerHTML = '<span style="color:var(--warn)">run_pattern/query_product 결과 JSON 이 아닙니다.</span>'; return; }
    const p = state.products.find((x) => x.product_id === o.product_id);
    const pat = p && (p.usage_patterns || []).find((x) => x.pattern_id === o.pattern_id);
    if (!pat) { $("pasteState").innerHTML = '<span style="color:var(--warn)">해당 제품·패턴을 카탈로그에서 못 찾음 — 먼저 카탈로그를 불러오세요.</span>'; return; }
    const kkey = key(p, pat);
    const slot = o.tool === "run_pattern" ? "tobe" : "asis";
    state.live[kkey] = Object.assign(state.live[kkey] || {}, { [slot]: { row_count: o.row_count, ms: o.ms } });
    $("prodSel").value = p.product_id; fillPatterns(); $("patSel").value = pat.pattern_id; renderCompare();
    $("pasteState").innerHTML = `반영됨 — ${esc(o.product_id)} / ${esc(o.pattern_id)} · ${o.row_count}행`;
  } catch (err) { $("pasteState").innerHTML = `<span style="color:var(--err)">JSON 파싱 실패</span> — ${esc(String(err && err.message || err))}`; }
});
