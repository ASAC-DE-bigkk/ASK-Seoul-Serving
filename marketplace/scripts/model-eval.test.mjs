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

// 🔴 2026-08-08 첫 실행 회귀. 카탈로그는 도메인별로 묶여 있고 commerce 가 22종으로 맨 앞이라,
// 제품 단위로만 돌리면 앞 5문항이 전부 commerce 였다. 그러면 "commerce" 라고만 찍어도
// 제품 도메인이 맞아 무엇을 재는지가 흐려진다.
test("문항은 **도메인**을 먼저 돌린다 — 한 도메인이 앞을 다 먹지 않게", () => {
  // commerce 3종이 앞에 몰려 있는 카탈로그를 흉내낸다
  const skewed = [
    { product_id: "commerce_a", usage_patterns: [{ pattern_id: "p1", question_ko: "q", sql: "SELECT :x", verified_at: "d" }] },
    { product_id: "commerce_b", usage_patterns: [{ pattern_id: "p2", question_ko: "q", sql: "SELECT :x", verified_at: "d" }] },
    { product_id: "commerce_c", usage_patterns: [{ pattern_id: "p3", question_ko: "q", sql: "SELECT :x", verified_at: "d" }] },
    { product_id: "culture_a", usage_patterns: [{ pattern_id: "p4", question_ko: "q", sql: "SELECT :x", verified_at: "d" }] },
    { product_id: "weather_a", usage_patterns: [{ pattern_id: "p5", question_ko: "q", sql: "SELECT :x", verified_at: "d" }] },
  ];
  const doms = buildCases(skewed, 3).map((c) => c.expect.product_id.split("_")[0]);
  assert.deepEqual([...new Set(doms)].sort(), ["commerce", "culture", "weather"],
    `한 도메인에 몰렸다: ${doms.join(", ")}`);
});

test("🔴 툴 응답은 카탈로그로만 만든다 — 실행 툴은 종료 신호만 준다", () => {
  // 여기서 실제 조회를 하면 D1·키·쿼터를 쓰게 된다. 우리가 재는 건 실행이 아니라 선택이다.
  assert.equal(answerTool("run_pattern", { product_id: "x" }, PRODUCTS)._terminal, true);
  assert.equal(answerTool("query_product", {}, PRODUCTS)._terminal, true);
  // ⚠️ `preview_product` 는 여기서 빠졌다 — 아래 전용 테스트 참고. 이 단언이 있던 것이
  //    2026-08-09 실측에서 탐색하던 모델을 실패로 찍은 원인이었다.
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

// 🔴 2026-08-08: `--check` 가 "도구 호출 없음"을 냈는데, 원인이 모델인지 우리 파서인지
// 갈리지 않았다. Workers AI 는 모델·버전에 따라 tool call 을 다른 자리에 싣는다 —
// 한 자리만 보면 **잘 부른 모델이 0점으로 찍히고** 그건 모델 한계가 아니라 우리 결함이다.
test("tool call 은 여러 자리에서 찾는다 — 공급자마다 감싸는 모양이 다르다", async () => {
  const { extractToolCalls, readCall } = await import("./model-eval.mjs");
  const call = { name: "list_products", arguments: {} };
  for (const shape of [
    { tool_calls: [call] },
    { choices: [{ message: { tool_calls: [call] } }] },
    { message: { tool_calls: [call] } },
    { output: { tool_calls: [call] } },
  ]) assert.equal(extractToolCalls(shape).length, 1, `못 찾은 모양: ${JSON.stringify(shape)}`);

  assert.deepEqual(extractToolCalls({ response: "그냥 문장" }), []);
  assert.deepEqual(extractToolCalls(null), []);
});

test("tool call 의 이름·인자를 모양에 관계없이 읽는다", async () => {
  const { readCall } = await import("./model-eval.mjs");
  assert.deepEqual(readCall({ name: "a", arguments: { x: 1 } }), { name: "a", args: { x: 1 } });
  // OpenAI 계열은 function 으로 감싸고 arguments 를 **문자열**로 준다
  assert.deepEqual(readCall({ function: { name: "a", arguments: '{"x":1}' } }), { name: "a", args: { x: 1 } });
  // 깨진 JSON 이 와도 죽지 않는다 — 채점에서 파라미터 불일치로 잡히면 된다
  assert.deepEqual(readCall({ function: { name: "a", arguments: "{oops" } }), { name: "a", args: {} });
});

// 🔴 2026-08-08 실측 회귀. glm 이 준 `{name, arguments}` 를 그대로 되밀었더니 qwen 쪽
// 엔드포인트가 `id`·`function` 누락으로 400 을 냈다. 읽을 때는 관대하게, **되밀 때는
// 표준으로** — 안 그러면 모델 비교가 아니라 "누가 우리 형식 실수를 봐주나"를 재게 된다.
test("툴 왕복은 OpenAI 표준 모양으로 되민다 — id·function·tool_call_id", async () => {
  const { echoMessages } = await import("./model-eval.mjs");
  const [assistant, tool] = echoMessages("call_1", "describe_product", { product_id: "p" }, { ok: 1 });

  assert.equal(assistant.role, "assistant");
  // 🔴 null 이 아니라 빈 문자열 — Workers AI 스키마가 문자열을 요구한다(2026-08-09 실측)
  assert.equal(assistant.content, "", "content 가 null 이면 Workers AI 가 400 을 낸다");
  const tc = assistant.tool_calls[0];
  assert.equal(tc.id, "call_1");
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "describe_product");
  // arguments 는 **문자열**이어야 한다 — 객체로 넣으면 같은 검증에 걸린다
  assert.equal(typeof tc.function.arguments, "string");
  assert.deepEqual(JSON.parse(tc.function.arguments), { product_id: "p" });

  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "call_1", "tool 응답이 어느 호출에 대한 건지 못 잇는다");
  assert.equal(typeof tool.content, "string");
});

// `--hint` A/B (2026-08-09). 두 모델 다 describe 까지 가고 실행 대신 설명으로 끝내는 것이
// 응답 탓인지 시험하는 스위치다. **기본은 꺼져 있어야** 대조군이 남는다.
test("--hint 는 describe 응답에만 next_action 을 얹고, 기본은 없다", () => {
  const plain = answerTool("describe_product", { product_id: "culture_event_schedule" }, PRODUCTS);
  assert.equal(plain.next_action, undefined, "기본에 힌트가 붙으면 대조군이 사라진다");

  const hinted = answerTool("describe_product", { product_id: "culture_event_schedule" }, PRODUCTS, { hint: true });
  assert.match(hinted.next_action, /run_pattern/);
  // 힌트는 덧붙이는 것이지 원래 내용을 바꾸지 않는다
  assert.deepEqual(hinted.usage_patterns, plain.usage_patterns);
});

// `--product-given` (2026-08-09). 플레이그라운드는 사용자가 제품을 먼저 고른다 — 그러면
// AI 가 할 일에서 **가장 자주 틀리던 단계(제품 선택)** 가 빠진다. 그 축을 뺀 좁은 과제가
// 성립하는지 재는 스위치다.
test("--product-given 은 제품과 패턴 목록을 대화에 미리 싣는다", async () => {
  const m = await import("./model-eval.mjs");
  const products = [{ product_id: "culture_event_schedule", usage_patterns: [
    { pattern_id: "free_in_gu", question_ko: "무료 행사?", sql: "SELECT :gu, :n", verified_at: "d" },
    { pattern_id: "unverified", question_ko: "미검증", sql: "SELECT 1", verified_at: null },
  ] }];
  const cse = { question: "무료 행사?", expect: { product_id: "culture_event_schedule", pattern_id: "free_in_gu" }, params: ["gu", "n"] };

  // 내부 함수라 export 하지 않았다 — 대신 대화가 실제로 그렇게 만들어지는지 소스로 고정한다.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./model-eval.mjs", import.meta.url), "utf8");
  assert.match(src, /opts\.productGiven[\s\S]{0,80}givenProductMessages/, "플래그가 대화 구성을 안 가른다");
  // 🔴 미검증 패턴은 목록에 없어야 한다 — 권하면 다음 호출이 409 다
  assert.match(src, /filter\(\(u\) => u\.verified_at\)/, "미검증 패턴이 목록에 섞인다");
  // list_products 를 안 부르는 것이 이 모드의 요점이다
  assert.doesNotMatch(src.slice(src.indexOf("function givenProductMessages"), src.indexOf("async function runModel")),
    /list_products/, "제품이 주어졌는데 목록 도구를 여전히 권한다");
});

// 🔴 2026-08-09 실측 회귀. glm 이 `preview_product` 를 부른 문항이 실패로 찍혔는데,
// 값을 보고 파라미터를 정하려는 **합리적인 탐색**이었고 끊은 건 우리 하네스였다.
// 재려던 것은 `run_pattern` 도달이지 툴 호출 일반이 아니다.
test("미리보기는 대화를 끊지 않는다 — 실행 툴만 종료다", () => {
  assert.equal(answerTool("preview_product", { product_id: "p" }, PRODUCTS)._terminal, undefined,
    "미리보기가 대화를 끊으면 탐색하는 모델이 실패로 찍힌다");
  assert.match(answerTool("preview_product", {}, PRODUCTS).note, /run_pattern/);
  // 실행 툴은 여전히 종료다 — 거기 도달한 것이 곧 측정 결과다
  assert.equal(answerTool("run_pattern", {}, PRODUCTS)._terminal, true);
  assert.equal(answerTool("query_product", {}, PRODUCTS)._terminal, true);
});

// 🔴 2026-08-09 qwen 실측. 구조화 필드는 비어 있고 `content` 안에 `<tool_call>{…}` 이
// 들어 있었다. 안 읽으면 **모델은 옳게 불렀는데 우리가 못 들은 것**이 된다 — 실제 어댑터도
// 같은 문제를 겪으므로(못 읽으면 운영에서도 그 호출이 사라진다) 여기서 재는 것이 맞다.
test("본문의 <tool_call> 태그도 읽는다 — 못 읽으면 옳은 호출이 사라진다", async () => {
  const { extractToolCalls, readCall } = await import("./model-eval.mjs");
  const body = '<tool_call>\n{"name": "run_pattern", "arguments": {"product_id": "p", "pattern_id": "q"}}\n</tool_call>';

  for (const shape of [{ response: body }, { choices: [{ message: { content: body } }] }]) {
    const calls = extractToolCalls(shape);
    assert.equal(calls.length, 1, `못 읽은 모양: ${JSON.stringify(shape).slice(0, 60)}`);
    assert.deepEqual(readCall(calls[0]), { name: "run_pattern", args: { product_id: "p", pattern_id: "q" } });
  }

  // 구조화 필드가 있으면 그쪽이 우선 — 본문을 뒤질 이유가 없다
  assert.equal(extractToolCalls({ tool_calls: [{ name: "a" }], response: body })[0].name, "a");
  // 잘린 JSON 은 조용히 버린다. 반쪽 호출을 지어내는 것보다 없는 게 낫다
  assert.deepEqual(extractToolCalls({ response: '<tool_call>{"name": "run_' }), []);
  assert.deepEqual(extractToolCalls({ response: "그냥 문장" }), []);
});
