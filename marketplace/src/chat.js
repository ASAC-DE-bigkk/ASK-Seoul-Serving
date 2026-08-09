// 채팅 어댑터 — 질문 하나를 **검증된 패턴 실행**으로 바꾼다 (#159 ③ · decision/0006).
//
// 이 파일이 하는 일은 대화 루프 하나다: LLM 에 도구를 주고 → 부른 도구를 실행해 되밀고 →
// 답이 나오면 멈춘다. **LLM 이 SQL 을 짓지 않는다** — 고를 수 있는 것은 도메인이 게시·검증한
// 패턴뿐이고, 실행은 `handleRunPattern` 의 게이트 사다리(카탈로그→검증→권리→쿼터)를 그대로
// 탄다. 채팅이라고 문이 넓어지지 않는다.
//
// 경계(#159 kang 조건, PR#244 에서 그은 것):
//   mcp.js        TOOLS 정의(계약 정본) · JSON-RPC 봉투 · trace   ← 재사용 안 함
//   agent-tools   TOOLS → LLM 형식 · AI 용 응답 성형              ← 여기서 쓴다
//   chat.js       대화 루프 · 채팅 전용 도구 실행                  ← 이 파일
//
// 🔴 **여기는 `env.AI` 를 모른다.** LLM 호출은 `ai(payload)` 함수로 주입받는다 — 바인딩을
//    켜는 것은 과금이 켜지는 변경이라 별도 PR 이고(#159 진행 합의), 주입이면 테스트가
//    가짜 AI 로 돈다(이 리포의 deps 주입 방식 그대로). 폴백(외부 API)도 같은 자리에 꽂힌다.
import { agentToolSpecs, slimProductList, buildDataContext } from "./agent-tools.js";

// decision/0006 채택값. **왕복 상한의 "1건"은 사용자 질문 1개**이지 LLM 호출 1회가 아니다 —
// 툴 호출형이라 한 질문이 여러 번 왕복하고, 루프가 돌면 1건이 100건어치 비용을 쓸 수 있다.
export const CHAT_MAX_TURNS = 4;
export const CHAT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
// 🔴 800 은 추론형 모델에 너무 작다 — qwen 실측에서 실패 전건이 `finish_reason:"length"` 에
//    내부 추론만 채우고 끝났다(1/10). 3000 으로 올리자 9/10. **이 값이 모델 선정의 결론을
//    뒤집었다** — 줄이려면 같은 측정을 다시 돌린 뒤에 줄인다.
export const CHAT_MAX_TOKENS = 3000;

// ── LLM 공급자 응답의 관용 파서 3종 ─────────────────────────────────────────────
// scripts/model-eval.mjs(측정 하네스)에서 **이동해 왔다** — 측정이 겪은 공급자별 함정이
// 실제 어댑터가 겪을 함정 그 자체라서다. 하네스는 이쪽을 import 한다(사본 금지).

/** 응답 어디에 tool call 이 실렸는지 **찾아서** 돌려준다.
 *
 * 🔴 한 자리만 보고 "안 불렀다"고 판정하지 않는다. Workers AI 는 모델·버전에 따라
 *    `result.tool_calls` 이기도 하고 OpenAI 호환 `choices[0].message.tool_calls` 이기도
 *    하다. 파서가 엉뚱한 곳을 보면 **모델은 옳게 불렀는데 우리가 못 들은 것**이 된다.
 */
export function extractToolCalls(result) {
  const cands = [result?.tool_calls, result?.choices?.[0]?.message?.tool_calls,
                 result?.message?.tool_calls, result?.output?.tool_calls];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;

  // 🔴 본문에 `<tool_call>` 태그로 실려 오는 경우가 있다(2026-08-09 qwen 실측). 구조화
  //    필드가 비고 `content` 안에 JSON 이 들어 있는데, 안 읽으면 그 호출은 운영에서 사라진다.
  const text = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
  const out = [];
  for (const m of String(text).matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j.name) out.push(j);
    } catch { /* 잘린 JSON — 못 읽으면 없는 것으로 둔다 */ }
  }
  return out;
}

/** tool call 한 건에서 (이름, 인자)를 꺼낸다 — 공급자마다 감싸는 모양이 다르다. */
export function readCall(c) {
  const name = c?.name ?? c?.function?.name;
  let args = c?.arguments ?? c?.function?.arguments ?? c?.input ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  return { name, args };
}

/** 툴 왕복을 **OpenAI 표준 모양으로** 대화에 되민다.
 *
 * 🔴 모델이 돌려준 모양을 그대로 되밀면 안 된다 — glm 의 `{name, arguments}` 를 그대로
 *    넣으면 qwen 쪽이 `'id' Field required` 로 거절한다(실측). **읽을 때는 관대하게,
 *    되밀 때는 표준으로.**
 * ⚠️ `content` 는 **빈 문자열**이다. OpenAI 표준은 null 인데 Workers AI 스키마는 문자열을
 *    요구한다(`'string' not in 'null'` 실측). 빈 문자열은 양쪽 다 받는다.
 */
export function echoMessages(id, name, args, out) {
  return [
    { role: "assistant", content: "",
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, name, content: JSON.stringify(out).slice(0, 6000) },
  ];
}

// ── 대화의 시작 모양 ────────────────────────────────────────────────────────────

/** 제품이 **이미 정해진** 대화를 만든다 — 채택된 유일한 시작 모양이다.
 *
 * 🔑 57종 중 고르게 하면 3턴·9,914토큰·정답 0/5, 제품을 먼저 골라 주면 1턴·1,638토큰·9/10
 * (decision/0006 실측). 그래서 화면이 제품을 먼저 고르게 하고, 어댑터는 그 이후만 맡는다.
 * 이 프롬프트는 **측정에 쓴 문구 그대로다** — 바꾸면 9/10 이라는 근거가 사라지므로,
 * 다듬고 싶으면 하네스로 다시 재고 나서 바꾼다.
 *
 * 패턴 목록을 대화에 미리 싣는다 — 화면이 이미 카탈로그에서 갖고 있는 정보라 툴 왕복이
 * 필요 없고, `runnable` 인 것만 실어서 고르고 튕기는 왕복(409)도 없앤다.
 */
export function productGivenMessages(product, question) {
  const pats = (product.usage_patterns || [])
    .filter((u) => u.verified_at || u.runnable)
    .map((u) => ({ pattern_id: u.pattern_id, question_ko: u.question_ko,
                   ...(u.params ? { params: u.params } : {}) }));
  return [
    { role: "system", content:
      "사용자가 데이터 제품을 이미 골랐습니다. 아래 실행 가능한 질의 패턴 중 질문에 맞는 것을 " +
      "하나 골라 run_pattern 을 **지금 호출**하세요. SQL 을 작성하지 말고 파라미터만 채웁니다. " +
      "설명만 하고 끝내지 마세요 — 실행해야 사용자가 답을 받습니다.\n\n" +
      `product_id: ${product.product_id}\n` +
      "실행 가능한 패턴:\n" + JSON.stringify(pats).slice(0, 6000) },
    { role: "user", content: String(question) },
  ];
}

// ── 채팅 전용 도구 실행 ─────────────────────────────────────────────────────────
// `callTool`(mcp.js)을 재사용하지 않는다 — JSON-RPC 봉투·MCP hint 표가 섞여 있고, 그걸
// 벗겨 쓰면 결국 두 벌이 된다(#159 kang 조건). 여기는 **shared 핸들러 + agent-tools 성형**
// 만으로 조립한 채팅 몫의 어댑터다. 성형이 공용이라 두 표면의 응답 모양은 같다.

async function runTool(name, args, ctx) {
  const { env, request, keyRow, trace, deps } = ctx;
  args = args || {};
  const asJson = async (res) => {
    const body = await res.json().catch(() => null);
    // 오류도 **본문째** 되민다 — problem+json 의 detail(예: 400 의 선언 파라미터 목록)이
    // 모델이 다음 턴에 스스로 고치는 재료다. 상태만 주면 같은 실수를 반복한다.
    return res.status >= 400 ? { error: body?.detail || body?.title || `HTTP ${res.status}`, status: res.status } : body;
  };
  if (name === "run_pattern") {
    if (!args.product_id || !args.pattern_id) return { error: "product_id 와 pattern_id 가 필요합니다." };
    return asJson(await deps.handleRunPattern(env, args.product_id, args.pattern_id, args.params || {}, keyRow, trace));
  }
  if (name === "describe_product") {
    if (!args.product_id) return { error: "product_id 가 필요합니다." };
    return asJson(await deps.handleProductBundle(env, args.product_id, request, trace));
  }
  if (name === "list_products") {
    const body = await asJson(await deps.handleCatalog(env));
    return body?.error ? body : slimProductList(body);
  }
  if (name === "query_product" || name === "preview_product") {
    if (!args.product_id) return { error: "product_id 가 필요합니다." };
    if (name === "preview_product") return asJson(await deps.handlePreview(env, args.product_id, trace));
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args.filters || {})) params.set(k, String(v));
    for (const k of ["from", "to", "limit", "cursor"]) if (args[k]) params.set(k, String(args[k]));
    const body = await asJson(await deps.handleData(env, args.product_id, params, keyRow, trace, { includeMeta: true }));
    if (body?.error) return body;
    const meta = body.product_meta;
    delete body.product_meta;
    const dataCtx = buildDataContext(meta);
    return dataCtx ? { ...body, data_context: dataCtx } : body;
  }
  if (name === "check_quota") {
    const body = await asJson(await deps.handleMe(env, keyRow));
    if (body?.error) return body;
    const { email, ...rest } = body;   // MCP 와 같은 이유 — LLM 컨텍스트로 이메일을 안 흘린다
    return rest;
  }
  return { error: `알 수 없는 tool: ${name}` };
}

// ── 강등 — AI 없이도 죽지 않는다 (decision/0006 §C) ─────────────────────────────

/** 질문과 패턴 질문의 낱말 겹침으로 후보를 고른다.
 *
 * 이건 답이 아니라 **강등**이다 — LLM 이 없을 때(비용 초과·장애) 채팅이 죽는 대신
 * "이 질문에는 이 패턴들이 맞아 보입니다"로 내려앉는다. 그래서 실행하지 않고 후보만 준다 —
 * 낱말 겹침은 파라미터를 채울 수 없고, **지어낸 파라미터로 실행하는 것**이 이 시스템이
 * 일관되게 막아 온 바로 그것이다.
 */
export function matchPatterns(question, patterns, limit = 3) {
  const words = String(question).toLowerCase().split(/[\s,.?!·]+/).filter((w) => w.length >= 2);
  return (patterns || [])
    .map((p) => ({ p, hit: words.filter((w) => (p.question_ko || "").toLowerCase().includes(w)).length }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, limit)
    .map((x) => ({ pattern_id: x.p.pattern_id, question_ko: x.p.question_ko }));
}

// ── 대화 루프 ──────────────────────────────────────────────────────────────────

/**
 * 질문 하나를 처리한다. `ai` 가 없거나 던지면 패턴 매칭으로 강등한다.
 *
 * @param {object} p
 * @param {object} p.product   화면이 고른 제품(카탈로그 응답의 한 항목 — usage_patterns 포함)
 * @param {string} p.question  사용자 질문
 * @param {function} p.ai      `async (payload) => result` — Workers AI/외부 API 를 감싼 주입점
 * @param {Array}  p.tools     TOOLS (mcp.js 정본 — 부르는 쪽이 넘긴다, agent-tools 규약)
 * @param {object} p.ctx       { env, request, keyRow, trace, deps } — 도구 실행 재료
 */
export async function runChat({ product, question, ai, tools, ctx }) {
  const messages = productGivenMessages(product, question);
  const steps = [];
  let usage = { prompt: 0, completion: 0 };

  const degrade = (reason) => ({
    degraded: true, reason, steps, usage,
    candidates: matchPatterns(question, product.usage_patterns),
    answer: null,
  });

  if (typeof ai !== "function") return degrade("ai_unavailable");

  for (let turn = 0; turn < CHAT_MAX_TURNS; turn++) {
    let r;
    try {
      r = await ai({ messages, tools: agentToolSpecs(tools), max_tokens: CHAT_MAX_TOKENS });
    } catch (e) {
      // LLM 장애는 채팅의 끝이 아니다 — 이미 실행한 도구 결과가 있으면 그것대로,
      // 없으면 후보 제시로 내려앉는다(§5 부분 실패 강등과 같은 모양).
      return degrade("ai_error");
    }
    usage = { prompt: usage.prompt + (r?.usage?.prompt_tokens || 0),
              completion: usage.completion + (r?.usage?.completion_tokens || 0) };

    const calls = extractToolCalls(r);
    if (!calls.length) {
      // 도구 없이 끝난 텍스트가 곧 답이다 — 단 **아무것도 실행 안 했으면** 그 답은 데이터
      // 없이 지은 문장이므로, 후보를 같이 실어 화면이 구분해 그리게 한다.
      const answer = r?.response ?? r?.choices?.[0]?.message?.content ?? "";
      return steps.length
        ? { answer, steps, usage, turns: turn + 1 }
        : { answer, steps, usage, turns: turn + 1, candidates: matchPatterns(question, product.usage_patterns) };
    }

    for (const [i, c] of calls.entries()) {
      const { name, args } = readCall(c);
      const out = await runTool(name, args, ctx);
      steps.push({ name, args, ok: !out?.error, ...(out?.error ? { error: out.error } : {}) });
      messages.push(...echoMessages(c.id ?? `call_${turn}_${i}`, name, args, out));
      // 마지막 도구 결과를 들고 있는다 — 왕복 상한에 걸려도 데이터는 이미 손에 있다.
      ctx.lastResult = out;
    }
  }

  // 🔴 상한에 걸리면 **지금까지 얻은 것으로 답하고 멈춘다**(decision/0006) — 왕복을 더 못
  //    했다고 답을 안 주지는 않는다. 해석 문장은 없지만 데이터·insight 는 화면이 그릴 수 있다.
  return { answer: null, steps, usage, turns: CHAT_MAX_TURNS, exhausted: true,
           last_result: ctx.lastResult ?? null };
}
