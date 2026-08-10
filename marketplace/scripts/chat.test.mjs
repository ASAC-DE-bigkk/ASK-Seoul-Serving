// 채팅 어댑터의 계약(#159 ③ · decision/0006).
//
// 여기서 지키는 것은 대화가 잘 되는 것이 아니라 **비용·안전의 상한** 넷이다.
//   ① 왕복 4회를 넘지 않는다 — 루프가 돌면 질문 1건이 100건어치 비용을 쓴다
//   ② 상한에 걸려도 얻은 데이터는 준다 — 왕복을 못 했다고 답을 안 주지 않는다
//   ③ AI 가 없거나 죽어도 채팅이 죽지 않는다 — 후보 제시로 내려앉는다 (실행은 안 한다)
//   ④ TOOLS 를 안 만진다 · 되밀 때는 표준 모양이다
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../src/mcp.js";
import {
  runChat, productGivenMessages, matchPatterns, CHAT_MAX_TURNS, CHAT_MAX_TOKENS,
} from "../src/chat.js";

// ── 재료 ──────────────────────────────────────────────────────────────────────

const PRODUCT = {
  product_id: "culture_event_schedule",
  usage_patterns: [
    { pattern_id: "free_in_gu", question_ko: "강남구 무료 행사", verified_at: "2026-08-01" },
    { pattern_id: "crowd_top", question_ko: "혼잡한 행사 상위", verified_at: "2026-08-01" },
    { pattern_id: "draft_one", question_ko: "미검증 패턴", verified_at: null },
  ],
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function ctx(overrides = {}) {
  return {
    env: {}, request: null, keyRow: { key_hash: "h", daily_quota: 100 }, trace: {},
    deps: {
      handleRunPattern: async (env, pid, patid, params) =>
        json({ product_id: pid, pattern_id: patid, rows: [{ n: 1 }], row_count: 1 }),
      handleProductBundle: async () => json({ product_id: "p" }),
      handleCatalog: async () => json({ products: [] }),
      handlePreview: async () => json({ rows: [] }),
      handleData: async () => json({ rows: [], product_meta: { freshness: "f" } }),
      handleMe: async () => json({ email: "x@y.z", used_today: 1 }),
      ...overrides,
    },
  };
}

/** 각 턴에 무엇을 돌려줄지 대본으로 주는 가짜 AI. */
const scripted = (...turns) => {
  let i = 0;
  const fn = async (payload) => { fn.payloads.push(payload); return turns[Math.min(i++, turns.length - 1)]; };
  fn.payloads = [];
  return fn;
};
const toolCallTurn = (name, args) => ({
  tool_calls: [{ id: "c1", function: { name, arguments: JSON.stringify(args) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const textTurn = (text) => ({ response: text, usage: { prompt_tokens: 3, completion_tokens: 2 } });

// ── 정상 흐름 ─────────────────────────────────────────────────────────────────

test("측정된 흐름 그대로 — 패턴 실행 후 텍스트로 끝난다", async () => {
  const ai = scripted(
    toolCallTurn("run_pattern", { product_id: "culture_event_schedule", pattern_id: "free_in_gu", params: {} }),
    textTurn("강남구 무료 행사는 1건입니다."),
  );
  const r = await runChat({ product: PRODUCT, question: "강남구 무료 행사?", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(r.answer, "강남구 무료 행사는 1건입니다.");
  assert.equal(r.turns, 2);
  assert.deepEqual(r.steps.map((s) => s.name), ["run_pattern"]);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.usage.prompt, 13);   // 두 턴 합산
});

test("시작 프롬프트에 runnable 패턴만 실린다 — 고르고 튕기는 409 왕복을 없앤다", () => {
  const [sys] = productGivenMessages(PRODUCT, "q");
  assert.match(sys.content, /free_in_gu/);
  assert.match(sys.content, /crowd_top/);
  assert.doesNotMatch(sys.content, /draft_one/, "미검증 패턴을 실으면 골라도 409 다");
});

test("🔴 매 턴 max_tokens 3000 — 이 값이 모델 선정의 결론을 뒤집었다", async () => {
  const ai = scripted(textTurn("답"));
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(ai.payloads[0].max_tokens, CHAT_MAX_TOKENS);
  assert.equal(CHAT_MAX_TOKENS, 3000);
});

test("🔴 TOOLS 원본이 안 바뀐다 — 어댑터를 몇 번 돌려도", async () => {
  const before = JSON.stringify(TOOLS);
  const ai = scripted(toolCallTurn("run_pattern", { product_id: "p", pattern_id: "x" }), textTurn("답"));
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(JSON.stringify(TOOLS), before);
});

test("되밀 때는 표준 모양이다 — id·function 필수, content 는 빈 문자열(null 아님)", async () => {
  const ai = scripted(toolCallTurn("run_pattern", { product_id: "p", pattern_id: "x" }), textTurn("답"));
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  const echoed = ai.payloads[1].messages;
  const assistant = echoed.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.content, "", "null 이면 Workers AI 가 거절한다(실측)");
  assert.ok(assistant.tool_calls[0].id);
  assert.ok(assistant.tool_calls[0].function);
  assert.equal(echoed.at(-1).role, "tool");
});

// ── 상한 ─────────────────────────────────────────────────────────────────────

test("① 왕복 상한 — AI 가 계속 도구만 불러도 4회에서 멈춘다", async () => {
  const ai = scripted(toolCallTurn("run_pattern", { product_id: "p", pattern_id: "x" }));   // 영원히 도구만
  const r = await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(r.exhausted, true);
  assert.equal(r.turns, CHAT_MAX_TURNS);
  assert.equal(ai.payloads.length, CHAT_MAX_TURNS, "상한을 넘겨 호출했다 — 비용 상한이 뚫렸다");
});

test("② 상한에 걸려도 얻은 데이터는 준다", async () => {
  const ai = scripted(toolCallTurn("run_pattern", { product_id: "p", pattern_id: "x" }));
  const r = await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  assert.ok(r.last_result, "왕복을 못 했다고 답을 안 주면 안 된다");
  assert.equal(r.last_result.row_count, 1);
});

// ── 강등 ─────────────────────────────────────────────────────────────────────

test("③ AI 미주입 — 죽는 대신 후보 제시로 내려앉는다", async () => {
  const r = await runChat({ product: PRODUCT, question: "강남구 무료 행사 알려줘", tools: TOOLS, ctx: ctx() });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, "ai_unavailable");
  assert.equal(r.candidates[0].pattern_id, "free_in_gu", "낱말 겹침 최다가 먼저다");
});

test("③ AI 가 던져도 같다 — 장애가 채팅의 끝이 아니다", async () => {
  const ai = async () => { throw new Error("Workers AI down"); };
  const r = await runChat({ product: PRODUCT, question: "무료 행사", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, "ai_error");
});

test("🔴 강등은 실행하지 않는다 — 지어낸 파라미터로 실행하는 것이 우리가 막아 온 그것이다", async () => {
  let ran = 0;
  const c = ctx({ handleRunPattern: async () => { ran++; return json({}); } });
  await runChat({ product: PRODUCT, question: "무료 행사", tools: TOOLS, ctx: c });
  assert.equal(ran, 0, "강등 경로가 패턴을 실행했다");
});

test("도구 없이 지은 답에는 후보를 같이 싣는다 — 화면이 '데이터 없는 문장'임을 그릴 수 있게", async () => {
  const ai = scripted(textTurn("아마 무료 행사가 많을 겁니다."));
  const r = await runChat({ product: PRODUCT, question: "무료 행사?", ai, tools: TOOLS, ctx: ctx() });
  assert.equal(r.steps.length, 0);
  assert.ok(Array.isArray(r.candidates), "실행 없이 끝난 답은 데이터 없이 지은 문장이다");
});

// ── 도구 실행의 채팅 몫 ────────────────────────────────────────────────────────

test("오류는 본문째 되민다 — detail 이 모델이 다음 턴에 고치는 재료다", async () => {
  const c = ctx({
    handleRunPattern: async () => json({ title: "invalid pattern params", detail: "선언된 파라미터: gu, n" }, 400),
  });
  const ai = scripted(
    toolCallTurn("run_pattern", { product_id: "p", pattern_id: "x", params: { bad: 1 } }),
    textTurn("파라미터를 고쳤습니다."),
  );
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: c });
  const toolMsg = ai.payloads[1].messages.at(-1);
  assert.match(toolMsg.content, /선언된 파라미터: gu, n/, "상태만 주면 같은 실수를 반복한다");
});

test("check_quota 는 이메일을 LLM 컨텍스트로 흘리지 않는다", async () => {
  const ai = scripted(toolCallTurn("check_quota", {}), textTurn("답"));
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  const toolMsg = ai.payloads[1].messages.at(-1);
  assert.doesNotMatch(toolMsg.content, /x@y\.z/);
  assert.match(toolMsg.content, /used_today/);
});

test("query_product 는 가드레일을 동봉한다 — freshness 없이 데이터만 주면 환각의 재료다", async () => {
  const ai = scripted(toolCallTurn("query_product", { product_id: "p" }), textTurn("답"));
  await runChat({ product: PRODUCT, question: "q", ai, tools: TOOLS, ctx: ctx() });
  const toolMsg = ai.payloads[1].messages.at(-1);
  assert.match(toolMsg.content, /data_context/);
  assert.match(toolMsg.content, /freshness/);
});

// ── 강등 매칭 자체 ────────────────────────────────────────────────────────────

test("matchPatterns — 겹친 낱말 수로 정렬하고 0겹침은 버린다", () => {
  const out = matchPatterns("강남구 무료 행사", PRODUCT.usage_patterns);
  assert.equal(out[0].pattern_id, "free_in_gu", "3낱말 겹침이 먼저다");
  // "혼잡한 행사 상위"는 '행사' 1겹침 — 후보가 **맞다**(처음 이 테스트가 이걸 소음으로
  // 단정했다가 틀렸다). 소음은 겹침 0 인 것이고, 그것만 버려진다.
  assert.ok(out.some((c) => c.pattern_id === "crowd_top"), "1겹침도 후보다");
  assert.ok(!out.some((c) => c.pattern_id === "draft_one"), "겹침 0 은 버린다");
});
