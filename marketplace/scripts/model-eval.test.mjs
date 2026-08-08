// 모델 실측 하네스(#159)의 **채점이 옳은지**를 고정한다.
//
// 이 스크립트가 조용히 틀리는 방식은 둘이다: ① 정답표를 잘못 만들어 아무 모델이나 통과시키거나
// ② 툴 응답을 만들다 실제로 실행해 버리는 것. 전자는 결정을 잘못 내리게 하고, 후자는 D1·쿼터를
// 건드린다. 모델 호출 없이 도는 순수 함수만 본다 — 네트워크는 이 파일의 관심사가 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAITools, declaredParams, buildCases, answerTool, score } from "./model-eval.mjs";
import { TOOLS } from "../src/mcp.js";

const PRODUCTS = [
  { product_id: "culture_event_schedule", grain: "행사×일", time_axis: "event_date",
    columns: [{ name: "gu" }], usage_patterns: [
      { pattern_id: "free_in_gu", question_ko: "이 구에서 하는 무료 행사가 있나?",
        sql: "-- :n=10\nSELECT * FROM t WHERE gu = :gu AND d >= :from LIMIT :n", verified_at: "2026-07-31" },
      { pattern_id: "unverified_one", question_ko: "미검증 질문", sql: "SELECT 1", verified_at: null },
    ] },
  { product_id: "citydata_ppltn_hourly", grain: "장소×시간", usage_patterns: [
      { pattern_id: "peak_hours", question_ko: "이 장소가 붐비는 시간대는?",
        sql: "SELECT * FROM t WHERE area = :area", verified_at: "2026-08-01" },
    ] },
];

test("TOOLS 를 OpenAI 스키마로 옮기되 원본을 건드리지 않는다", () => {
  const before = JSON.stringify(TOOLS);
  const out = toOpenAITools(TOOLS);
  assert.equal(JSON.stringify(TOOLS), before, "TOOLS 가 변형됐다 — MCP 담당 조건 위반");
  assert.equal(out.length, TOOLS.length);
  assert.equal(out[0].type, "function");
  assert.equal(out[0].function.name, TOOLS[0].name);
  assert.deepEqual(out[0].function.parameters, TOOLS[0].inputSchema);
});

test("파라미터는 주석을 벗기고 뽑는다 — 서버와 같은 순서", () => {
  // 안 벗기면 주석의 `:n` 을 세어 정답표가 틀리고, 맞게 채운 모델이 오답 처리된다.
  assert.deepEqual(declaredParams("-- :n=10\nSELECT a WHERE gu = :gu LIMIT :n"), ["gu", "n"]);
  assert.deepEqual(declaredParams("SELECT 1"), []);
  assert.deepEqual(declaredParams(null), []);
});

test("정답표는 검증된 패턴만 담는다 — 미검증은 409 라 문항이 될 수 없다", () => {
  const cases = buildCases(PRODUCTS, 10);
  assert.ok(cases.every((c) => c.expect.pattern_id !== "unverified_one"));
  assert.equal(cases.length, 2);
  const one = cases.find((c) => c.expect.pattern_id === "free_in_gu");
  assert.equal(one.question, "이 구에서 하는 무료 행사가 있나?");
  assert.deepEqual(one.params, ["from", "gu", "n"]);
});

test("문항은 제품을 돌아가며 고른다 — 한 제품에 몰리면 '고르는 능력'을 안 잰다", () => {
  const cases = buildCases(PRODUCTS, 2);
  assert.deepEqual([...new Set(cases.map((c) => c.expect.product_id))].sort(),
    ["citydata_ppltn_hourly", "culture_event_schedule"]);
});

test("🔴 툴 응답은 카탈로그로만 만든다 — 실행 툴은 종료 신호만 준다", () => {
  // 여기서 실제 조회를 하면 D1·키·쿼터를 쓰게 된다. 우리가 재는 건 실행이 아니라 선택이다.
  assert.equal(answerTool("run_pattern", { product_id: "x" }, PRODUCTS)._terminal, true);
  assert.equal(answerTool("query_product", {}, PRODUCTS)._terminal, true);
  assert.equal(answerTool("preview_product", {}, PRODUCTS)._terminal, true);
});

test("describe_product 는 runnable 을 verified_at 에서 만든다", () => {
  const out = answerTool("describe_product", { product_id: "culture_event_schedule" }, PRODUCTS);
  const ups = out.usage_patterns;
  assert.equal(ups.find((u) => u.pattern_id === "free_in_gu").runnable, true);
  assert.equal(ups.find((u) => u.pattern_id === "unverified_one").runnable, false);
  assert.deepEqual(ups.find((u) => u.pattern_id === "free_in_gu").params, ["from", "gu", "n"]);
});

test("없는 제품을 describe 하면 오류를 돌려준다 — 모델이 회복할 수 있게", () => {
  assert.match(answerTool("describe_product", { product_id: "nope" }, PRODUCTS).error, /nope/);
});

test("채점 — run_pattern 에 도달 못 하면 전부 실패다", () => {
  const cse = { expect: { product_id: "p", pattern_id: "q" }, params: ["a"] };
  assert.deepEqual(score({ trace: [{ name: "list_products", args: {} }] }, cse),
    { reached: false, product: false, pattern: false, params: false });
});

test("채점 — 제품·패턴·파라미터를 따로 센다", () => {
  const cse = { expect: { product_id: "p", pattern_id: "q" }, params: ["a", "b"] };
  const hit = { trace: [{ name: "run_pattern", args: { product_id: "p", pattern_id: "q", params: { b: 1, a: 2 } } }] };
  assert.deepEqual(score(hit, cse), { reached: true, product: true, pattern: true, params: true });

  // 제품은 맞췄는데 패턴이 틀린 경우가 실제로 갈리는 지점이다 — 뭉뚱그리면 원인이 안 보인다.
  const wrongPattern = { trace: [{ name: "run_pattern", args: { product_id: "p", pattern_id: "zzz", params: { a: 1, b: 2 } } }] };
  assert.deepEqual(score(wrongPattern, cse), { reached: true, product: true, pattern: false, params: true });

  const missingParam = { trace: [{ name: "run_pattern", args: { product_id: "p", pattern_id: "q", params: { a: 1 } } }] };
  assert.equal(score(missingParam, cse).params, false);
});
