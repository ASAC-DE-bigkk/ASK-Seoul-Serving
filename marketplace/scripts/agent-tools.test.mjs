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
import { agentToolSpecs, slimProductList, buildDataContext } from "../src/agent-tools.js";

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
