// AI 소비자 공용 층의 계약(#159 ②).
//
// 여기서 지키는 것은 함수의 출력이 아니라 **MCP 담당과 합의한 경계** 셋이다.
//   ① `TOOLS` 를 안 바꾼다 — 이름·스키마·설명은 MCP 계약의 정본이다
//   ② 성형이 한 벌이다 — mcp.js 가 자기 사본을 들고 있으면 한쪽만 고쳐진다
//   ③ 가드레일이 빠지지 않는다 — `data_context` 가 환각을 줄이는 유일한 장치다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOLS } from "../src/mcp.js";
import { agentToolSpecs, slimProductList, buildDataContext, searchProducts } from "../src/agent-tools.js";

const read = async (p) =>
  (await readFile(new URL(p, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("🔴 TOOLS 를 만지지 않는다 — 스키마까지 사본이다", () => {
  const before = JSON.stringify(TOOLS);
  const specs = agentToolSpecs(TOOLS);
  // 반환값을 험하게 다뤄도 원본이 그대로여야 한다. 프롬프트 조립 중 한 번의 변형이
  // PlayMCP·외부 클라이언트가 묶여 있는 계약을 조용히 바꾸면 안 된다.
  specs[0].function.description = "오염";
  specs[0].function.parameters.properties = { evil: true };
  assert.equal(JSON.stringify(TOOLS), before, "TOOLS 가 바뀌었다 — MCP 계약을 침범했다");
});

test("여섯 툴이 이름·설명 그대로 LLM 형식으로 나온다", () => {
  const specs = agentToolSpecs(TOOLS);
  assert.equal(specs.length, TOOLS.length);
  for (const [i, s] of specs.entries()) {
    assert.equal(s.type, "function");
    assert.equal(s.function.name, TOOLS[i].name);
    assert.equal(s.function.description, TOOLS[i].description);
    assert.deepEqual(s.function.parameters, TOOLS[i].inputSchema);
  }
});

test("🔴 agent-tools 는 mcp.js 를 가져오지 않는다 — 순환이 되고 계약에 닿는 길이 생긴다", async () => {
  const src = await read("../src/agent-tools.js");
  assert.doesNotMatch(src, /from\s+"\.\/mcp\.js"/,
    "TOOLS 는 인자로 받는다 — 여기서 가져오면 순환이고, 계약을 만질 경로가 생긴다");
});

test("🔴 성형은 한 벌이다 — mcp.js 가 자기 사본을 안 들고 있다", async () => {
  const mcp = await read("../src/mcp.js");
  assert.match(mcp, /from "\.\/agent-tools\.js"/, "mcp.js 가 공용 층을 안 쓴다");
  // 옛 인라인 구현이 남아 있으면 두 벌이다 — 한쪽만 고쳐지는 그 상태.
  assert.doesNotMatch(mcp, /const slimPattern = /, "mcp.js 에 목록 성형 사본이 남았다");
  assert.doesNotMatch(mcp, /body\.data_context = \{/, "mcp.js 에 가드레일 사본이 남았다");
});

// ── 목록 슬리밍 ──────────────────────────────────────────────────────────────

const catalog = () => ({
  products: [{
    product_id: "p1", product_question: "대표질문",
    columns: [{ column_name: "gu_code", description_ko: "긴 설명" }, { name: "event_at" }],
    usage_patterns: [{
      pattern_id: "pat1", question_ko: "이 질문이 검색 신호다",
      sql: "SELECT ...", insight_sample_ko: "해석", requires: ["sort"], verified_at: "2026-08-01",
    }],
  }],
});

test("무게를 만드는 것은 버리고 **고르는 신호**는 남긴다", () => {
  const out = slimProductList(catalog());
  const p = out.products[0];
  assert.deepEqual(p.column_names, ["gu_code", "event_at"]);
  assert.equal(p.usage_patterns[0].question_ko, "이 질문이 검색 신호다", "제품을 고르는 신호다");
  // 목록 단계에서 안 쓰이는 것들 — 이게 200KB 다
  assert.equal(p.usage_patterns[0].sql, undefined, "AI 는 SQL 을 직접 실행하지 않는다");
  assert.equal(p.usage_patterns[0].insight_sample_ko, undefined, "실행 응답에 온다");
  assert.equal(p.usage_patterns[0].requires, undefined, "상세와 400 안내가 말한다");
  assert.equal(p.columns, undefined, "컬럼 설명은 상세의 몫이다");
});

test("개수를 남긴다 — 0 은 '메타가 아직 없는 제품'이라는 신호다", () => {
  const p = slimProductList(catalog()).products[0];
  assert.equal(p.column_count, 2);
  assert.equal(p.pattern_count, 1);
  // 빈 것과 없는 것은 다른 뜻이다
  const empty = slimProductList({ products: [{ product_id: "p2" }] }).products[0];
  assert.equal(empty.column_count, 0);
  assert.deepEqual(empty.column_names, []);
});

test("다음 걸음을 말한다 — 목록만 주면 '그래서 어떻게'가 남는다", () => {
  assert.match(slimProductList(catalog()).detail_hint, /describe_product/);
});

test("모양이 아니면 그대로 돌려준다 — 오류 본문을 성형하다 죽지 않는다", () => {
  for (const bad of [null, undefined, {}, { detail: "문제" }])
    assert.equal(slimProductList(bad), bad);
});

// ── 가드레일 ────────────────────────────────────────────────────────────────

test("🔴 freshness 는 '지금'이 아니다 — 그 구분이 이 객체의 존재 이유다", () => {
  const ctx = buildDataContext({ freshness: "2026-08-01T00:00:00+09:00", serving_status: "published" });
  assert.equal(ctx.freshness, "2026-08-01T00:00:00+09:00");
  assert.ok(ctx.attribution, "출처가 빠지면 답변이 출처를 못 단다");
  assert.equal(ctx.warning, undefined, "published 는 경고 대상이 아니다");
});

test("published 가 아니면 경고를 단다 — 최신성이 보장되지 않는다", () => {
  const ctx = buildDataContext({ serving_status: "stale" });
  assert.match(ctx.warning, /stale/);
});

test("메타가 없으면 없다고 한다 — 빈 객체로 꾸미지 않는다", () => {
  assert.equal(buildDataContext(null), null);
  assert.equal(buildDataContext(undefined), null);
});

test("출처 문구는 shared 정본 한 벌이다 — 두 벌이면 /legal 개정 때 한쪽만 고쳐진다", async () => {
  const src = await read("../src/agent-tools.js");
  assert.match(src, /ATTRIBUTION/);
  assert.doesNotMatch(src, /공공 원천의 2차 가공물/, "문구를 여기 다시 적으면 두 벌이 된다");
});

// ── 무엇을 신호로 삼는가 (운영 실측 2026-08-12) ──────────────────────────────────
// 랜딩에서 *"강남에 내일 하는 축제 알려줘"* 를 물었더니 1등이 `commerce_geo_grid_overview`
// 였다. 근거는 둘뿐이었다 — 남의 패턴에 적힌 `(예: 강남역 vs 홍대)` 의 "강남", 그리고
// "차지**하는**"에 부분 문자열로 걸린 어미 "하는". **질문의 뜻은 하나도 안 들어갔다.**
// 아래 넷은 그 네 갈래를 각각 못 박는다.
const pat = (pattern_id, question_ko) => ({ pattern_id, question_ko, verified_at: "2026-08-01" });

test("🔴 예시 괄호는 신호가 아니다 — 값이지 주제가 아니다", () => {
  // `(예: …)` 는 파라미터를 어떻게 채우는지 보여 주는 견본이다. 그 안의 지명이 검색 신호가
  // 되면 "강남" 한 마디에 **상권 격자 제품이 문화행사를 이긴다**.
  const cat = { products: [
    { product_id: "commerce_geo_grid", usage_patterns: [
      pat("two_zone_compare", "두 상권의 규모·신규율을 나란히 비교하면? (예: 강남역 vs 홍대)")] },
    // 설명과 예시가 **한 괄호에 같이** 있는 것이 더 흔하다 — 괄호를 통째로 버리면 설명까지
    // 사라지므로 `예:` 뒤만 지운다. 그래서 `:gu` 설명은 남고 "강남구" 만 빠져야 한다.
    { product_id: "commerce_area_profile", usage_patterns: [
      pat("dataset_rank_for_gu", "이 구(:gu 자리, 예: 강남구)에서는 어떤 업종의 매장이 큰가?")] },
    { product_id: "weather_grid", usage_patterns: [pat("now", "지금 기온은?")] },
  ] };
  assert.equal(searchProducts(cat, "강남", 5).matched, 0,
    "예시 안의 지명으로 제품이 걸렸다 — 그 제품은 강남을 주제로 담고 있지 않다");
  assert.equal(searchProducts(cat, "업종", 5).products[0].product_id, "commerce_area_profile",
    "예시를 지우다 같은 괄호의 설명까지 지웠다");
});

test("🔴 어미는 낱말이 아니다 — 낱말 경계에서 시작할 때만 걸린다", () => {
  // 예전엔 말뭉치를 한 문자열로 두고 `includes` 했다. 한국어는 어미가 뒤에 붙는 언어라
  // "하는" 이 60제품 중 29개에 걸렸다 — 순위를 만드는 게 아니라 소음만 만든다.
  const cat = { products: [
    { product_id: "commerce_mix", usage_patterns: [pat("share", "상권 구성의 절반을 차지하는 업종은?")] },
    { product_id: "culture_free", usage_patterns: [pat("free", "무료 행사가 있나?")] },
  ] };
  assert.equal(searchProducts(cat, "하는", 5).matched, 0, "'차지하는' 에 어미 '하는' 이 걸렸다");
  // 조사는 여전히 넘는다 — 그게 접두 비교를 고른 이유다
  assert.equal(searchProducts(cat, "업종이", 5).products[0].product_id, "commerce_mix");
});

test("🔴 소개문이 패턴 질문보다 세다 — 주제가 소재를 이긴다", () => {
  // `culture_event_schedule` 은 개별 행사 목록을 주는 제품이라 "축제"의 정답인데, `축제` 를
  // **소개문에만** 갖고 있어 8위였다. 패턴 질문에 축제가 스쳐 간 집계 제품에 밀린 것이다.
  const cat = { products: [
    { product_id: "culture_event_schedule",
      display: { title: "서울 문화행사 통합 일정",
        summary: "서울의 공연·전시·축제·체험 행사를 한곳에 모은 통합 일정표입니다." },
      usage_patterns: [pat("today_in_gu", "오늘 당장 이 구에서 하는 행사는?")] },
    { product_id: "culture_activity_by_dong",
      display: { title: "행정동별 일자 문화활동량",
        summary: "행정동마다 날짜별로 문화 활동이 몇 건 열리는지 집계했습니다." },
      usage_patterns: [pat("festival_occurrences", "축제가 열리는 동네와 날짜는 언제 어디인가?")] },
  ] };
  assert.equal(searchProducts(cat, "축제", 5).products[0].product_id, "culture_event_schedule",
    "제품이 무엇을 담는지(소개문)보다 질문이 무엇을 언급하는지가 이겼다");
});

test("🔴 절반 넘는 제품에 있는 낱말은 지운다 — 다만 다 지우지는 않는다", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    ({ product_id: "generic_" + i, usage_patterns: [pat("p", "이 지역에서 하는 것은?")] }));
  const cat = { products: [...many,
    { product_id: "culture_a", usage_patterns: [pat("p", "전시 많이 열리는 동네는?")] },
    { product_id: "culture_b", usage_patterns: [pat("p", "전시가 몰리는 날은?")] }] };

  const out = searchProducts(cat, "전시 하는", 5);
  assert.match(out.products[0].product_id, /^culture_/, "흔한 낱말이 순위를 지배했다");
  assert.ok(!out.products[0].matched_terms.includes("하는"), "지운 낱말이 근거로 나왔다");

  // ⚠️ 흔한 말만으로 된 질의까지 0건으로 만들면 사용자는 "맞는 데이터가 없다"로 읽는다.
  //    모른다 ≠ 없다 — 그래서 다 지워질 상황이면 하나도 안 지운다.
  assert.ok(searchProducts(cat, "하는", 5).matched > 0, "흔한 말만 물었더니 통째로 0건이 됐다");
});
