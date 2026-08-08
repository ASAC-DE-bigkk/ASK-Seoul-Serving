#!/usr/bin/env node
/**
 * 모델 실측 하네스 (#159 · `decision/0006` 「확인 절차 ②」).
 *
 * ## 무엇을 재나
 *
 * 채팅의 설계 전제는 **"LLM 이 SQL 을 짓지 않는다"** 이다 — 검증된 패턴을 고르고 파라미터만
 * 채운다. 그래서 재야 할 것은 문장 솜씨가 아니라 셋이다:
 *
 *   ① 57종 중 **맞는 제품**을 고르는가
 *   ② 그 제품의 **맞는 패턴**을 고르는가
 *   ③ `:파라미터` 를 **선언대로** 채우는가
 *
 * ## 🔑 정답을 손으로 안 적는다
 *
 * 질문을 지어내면 채점이 주관이 된다. 대신 **카탈로그의 `usage_patterns[].question_ko` 를
 * 질문으로 쓴다** — 그 질문이 어느 제품·어느 패턴에서 왔는지 우리가 이미 알고 있으므로
 * **정답이 데이터에 들어 있다.** 사람이 라벨을 붙일 자리가 없다.
 *
 * ## 게이트를 지킨다 (`decision/0006`)
 *
 * - **`TOOLS` 를 읽기만 한다** — MCP 담당 조건. 여기서 스키마를 손보면 그 조건이 깨진다.
 * - **`chat.js` 가 아니다** — 모델 선정 전에는 구현하지 않기로 했고, 이건 선정을 위한 측정이다.
 * - **툴을 실제로 실행하지 않는다.** 툴 응답은 **무인증 카탈로그**(`/api/v1/catalog`)에서 만든다.
 *   D1 을 안 건드리고 키도 쿼터도 안 쓴다. 우리가 재려는 건 실행이 아니라 **선택**이다.
 * - 왕복 상한은 `decision/0006` 의 **4회**를 그대로 쓴다 — 그 숫자가 현실적인지도 같이 재진다.
 *
 * ## 자격증명
 *
 * 🔴 **원문을 코드·로그·인자에 넣지 않는다.** 환경변수로만 읽는다.
 *
 *   $env:CF_ACCOUNT_ID = "..."      # Cloudflare 계정 ID
 *   $env:CF_AI_TOKEN   = "..."      # Workers AI 권한 API 토큰
 *   npm run eval:model
 *
 * 모델을 바꾸려면 `--models a,b`, 문항 수는 `--n 5`. 자격증명 문제는 `--check` 가 갈라 준다.
 *
 * 🔑 **팀 공용 계정일 필요가 없다.** 이 측정이 쓰는 건 **무인증 카탈로그 + Workers AI** 뿐이고
 * 우리 D1·워커·키를 하나도 안 건드린다. Cloudflare API 토큰은 계정이 아니라 **사용자**에게
 * 붙어서, 공용 계정의 멤버 역할에 Workers AI 가 없으면 그 권한을 토큰에 못 넣는다(2026-08-08
 * 실사례). 그럴 때는 **개인 계정으로 돌리면 된다** — 무료 할당 10,000 뉴런/일이 이 측정
 * (약 1,800뉴런)을 덮고, 모델이 같으니 결과도 그대로 옮겨진다.
 *
 * ⚠️ 운영은 이 이야기와 무관하다. `chat.js` 는 `[ai]` **바인딩**으로 부르므로 **API 토큰이
 * 아예 필요 없다** — 배포된 워커가 자기 계정의 AI 를 쓴다. 토큰은 측정 단계에만 있는 문제다.
 */
import { pathToFileURL } from "node:url";
import { TOOLS } from "../src/mcp.js";

const API = "https://api.cloudflare.com/client/v4/accounts";
const CATALOG = "https://ask-seoul.kr/api/v1/catalog";
// `decision/0006` 채택값. 여기서 늘리면 그 결정을 코드가 조용히 뒤집는 것이 된다.
const MAX_TURNS = 4;
const DEFAULT_MODELS = ["@cf/zai-org/glm-4.7-flash", "@cf/qwen/qwen3-30b-a3b-fp8"];

/** MCP 의 `TOOLS` 를 OpenAI 계열 tool 스키마로 옮긴다. **원본을 수정하지 않는다.** */
export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** 패턴 SQL 의 `:이름` 자리를 뽑는다. 주석은 먼저 벗긴다 — 예시값이 주석에 적히는 관례라
 *  안 벗기면 주석 속 이름까지 파라미터로 센다(서버 `handleRunPattern` 과 같은 순서). */
export function declaredParams(sql) {
  const body = String(sql || "").replace(/--[^\n]*/g, "");
  return [...new Set(body.match(/:([a-z_][a-z0-9_]*)/g) || [])].map((s) => s.slice(1)).sort();
}

/** 카탈로그에서 (제품·패턴·질문) 삼중항을 뽑는다 — 이게 곧 정답표다. */
export function buildCases(products, n) {
  const cases = [];
  for (const p of products || []) {
    for (const up of p.usage_patterns || []) {
      if (!up.question_ko || !up.pattern_id || !up.verified_at) continue;
      cases.push({
        question: up.question_ko,
        expect: { product_id: p.product_id, pattern_id: up.pattern_id },
        params: declaredParams(up.sql),
      });
    }
  }
  // 🔴 **도메인을 먼저 돌린다.** 카탈로그는 도메인별로 묶여 있고 commerce 가 22종으로 맨
  //    앞이라, 제품 단위로만 돌리면 앞 5개가 전부 commerce 다(2026-08-08 첫 실행에서 그랬다).
  //    한 도메인 5문항이면 **"commerce" 라고만 찍어도 제품 도메인이 맞아** 무엇을 재는지가
  //    흐려진다. 도메인 → 제품 순으로 돌려 6개 도메인이 고루 섞이게 한다.
  const byDomain = new Map();
  for (const c of cases) {
    const dom = c.expect.product_id.split("_")[0];
    if (!byDomain.has(dom)) byDomain.set(dom, new Map());
    const byProduct = byDomain.get(dom);
    if (!byProduct.has(c.expect.product_id)) byProduct.set(c.expect.product_id, []);
    byProduct.get(c.expect.product_id).push(c);
  }
  // 도메인마다 "제품을 돌아가며" 뽑은 대기열을 만든다
  const queues = [...byDomain.values()].map((products) => {
    const lists = [...products.values()];
    const q = [];
    for (let i = 0; i < 50; i++) for (const l of lists) if (l[i]) q.push(l[i]);
    return q;
  });
  const picked = [];
  for (let i = 0; picked.length < n && i < 50; i++) {
    for (const q of queues) {
      if (q[i]) picked.push(q[i]);
      if (picked.length >= n) break;
    }
  }
  return picked;
}

/** 툴 호출에 **카탈로그만으로** 답한다. D1·키·쿼터를 쓰지 않는다. */
export function answerTool(name, args, products, opts = {}) {
  const find = (id) => (products || []).find((p) => p.product_id === id);
  if (name === "list_products") {
    return { products: products.map((p) => ({
      product_id: p.product_id, product_question: p.product_question,
      description: (p.description || "").slice(0, 200), join_keys: p.join_keys,
    })) };
  }
  if (name === "describe_product") {
    const p = find(args?.product_id);
    if (!p) return { error: `'${args?.product_id}' 은 카탈로그에 없다` };
    const out = {
      product_id: p.product_id, grain: p.grain, time_axis: p.time_axis,
      columns: (p.columns || []).map((c) => c.name || c),
      usage_patterns: (p.usage_patterns || []).map((u) => ({
        pattern_id: u.pattern_id, question_ko: u.question_ko,
        runnable: Boolean(u.verified_at), params: declaredParams(u.sql),
      })),
    };
    // `--hint` 실험(2026-08-09). 두 모델 다 여기까지 와서 **실행 대신 설명으로 끝냈다**
    // (10회 중 5회). 응답이 다음 행동을 말하지 않아 완결로 읽힌 것이라는 가설을 시험한다.
    // 🔑 이건 `TOOLS`(MCP 계약)가 아니라 **어댑터가 조립하는 응답 본문**이다 — chat.js 가
    //    자기 몫으로 얹는 자리이고, MCP 담당 조건("TOOLS 읽기 전용") 안쪽이다.
    if (opts.hint) {
      out.next_action = "이 목록에서 runnable=true 인 pattern_id 를 하나 골라 " +
        "run_pattern(product_id, pattern_id, params) 를 지금 호출하세요. " +
        "설명만 하고 끝내지 마세요 — 실행해야 사용자가 답을 받습니다.";
    }
    return out;
  }
  // run_pattern·query_product·preview_product 는 **실행하지 않는다.** 여기까지 왔다는 것이
  // 곧 측정하려던 결과이므로, 도달 사실만 남기고 대화를 끝낸다.
  return { _terminal: true };
}

const SYSTEM = "당신은 서울 공공데이터 API 안내자입니다. 데이터를 직접 조회하지 말고 반드시 도구를 사용하세요. " +
  "SQL 을 작성하지 마세요 — 검증된 질의 패턴(run_pattern)을 고르고 파라미터만 채웁니다. " +
  "먼저 list_products 로 제품을 고르고, describe_product 로 패턴을 확인한 뒤, runnable=true 인 패턴을 run_pattern 으로 실행하세요.";

/** 응답 어디에 tool call 이 실렸는지 **찾아서** 돌려준다.
 *
 * 🔴 한 자리만 보고 "안 불렀다"고 판정하지 않는다. Workers AI 는 모델·버전에 따라
 *    `result.tool_calls` 이기도 하고 OpenAI 호환 `result.choices[0].message.tool_calls`
 *    이기도 하다. **파서가 엉뚱한 곳을 보면 잘 부른 모델이 0점으로 찍힌다** — 그건 모델
 *    한계가 아니라 우리 결함이고, 그 차이가 이 측정의 결론을 통째로 뒤집는다.
 */
export function extractToolCalls(result) {
  const cands = [result?.tool_calls, result?.choices?.[0]?.message?.tool_calls,
                 result?.message?.tool_calls, result?.output?.tool_calls];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

/** 툴 왕복을 **OpenAI 표준 모양으로** 대화에 되민다.
 *
 * 🔴 모델이 돌려준 모양을 **그대로 되밀면 안 된다.** glm 은 `{name, arguments}` 로 주는데
 *    그걸 그대로 넣으면 qwen 쪽 엔드포인트가 거절한다(2026-08-08 실측):
 *
 *      'ChatCompletionMessageFunctionToolCallParam' 'id'       Field required
 *      'ChatCompletionMessageFunctionToolCallParam' 'function' Field required
 *
 *    **읽을 때는 관대하게, 되밀 때는 표준으로.** 안 그러면 모델 비교가 아니라
 *    "누가 우리 형식 실수를 봐주나"를 재게 된다.
 */
export function echoMessages(id, name, args, out) {
  return [
    // ⚠️ `content` 는 **빈 문자열**이다. OpenAI 표준은 tool call 을 실은 assistant 메시지에
    //    `null` 을 쓰지만 Workers AI 스키마는 문자열을 요구한다(2026-08-09 실측):
    //      Type mismatch of '/messages/2/content', 'string' not in 'null'
    //    빈 문자열은 양쪽 다 받는다.
    { role: "assistant", content: "",
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, name, content: JSON.stringify(out).slice(0, 6000) },
  ];
}

/** tool call 한 건에서 (이름, 인자)를 꺼낸다 — 공급자마다 감싸는 모양이 다르다. */
export function readCall(c) {
  const name = c?.name ?? c?.function?.name;
  let args = c?.arguments ?? c?.function?.arguments ?? c?.input ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  return { name, args };
}

async function runModel(model, cse, products, env, opts = {}) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: cse.question },
  ];
  const trace = [];
  let usage = { prompt: 0, completion: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(`${API}/${env.account}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages, tools: toOpenAITools(TOOLS), max_tokens: 800 }),
    });
    if (!res.ok) {
      // 🔴 **본문을 버리지 않는다.** `HTTP 400` 만 남기면 모델이 거절한 건지 우리가 보낸
      //    메시지 모양이 틀린 건지 알 수 없다 — 그 둘은 다음 행동이 완전히 다르다.
      const why = await res.text().catch(() => "");
      return { trace, error: `HTTP ${res.status}`, errorBody: why.slice(0, 400), usage, turns: turn + 1 };
    }
    const body = await res.json();
    const r = body.result || {};
    usage = { prompt: usage.prompt + (r.usage?.prompt_tokens || 0),
              completion: usage.completion + (r.usage?.completion_tokens || 0) };

    const calls = extractToolCalls(r);
    if (!calls.length) return { trace, answer: (r.response || "").slice(0, 200), usage, turns: turn + 1 };

    for (const [i, c] of calls.entries()) {
      const { name, args } = readCall(c);
      trace.push({ name, args });
      const out = answerTool(name, args, products, opts);
      if (out._terminal) return { trace, usage, turns: turn + 1 };
      messages.push(...echoMessages(c.id ?? `call_${turn}_${i}`, name, args, out));
    }
  }
  return { trace, usage, turns: MAX_TURNS, exhausted: true };
}

/** 도달한 도구 호출에서 정답 여부를 채점한다. */
export function score(result, cse) {
  const call = (result.trace || []).find((t) => t.name === "run_pattern");
  if (!call) return { reached: false, product: false, pattern: false, params: false };
  const got = Object.keys(call.args?.params || {}).sort();
  return {
    reached: true,
    product: call.args?.product_id === cse.expect.product_id,
    pattern: call.args?.pattern_id === cse.expect.pattern_id,
    params: JSON.stringify(got) === JSON.stringify(cse.params),
  };
}

function parseArgs(argv) {
  const out = { models: DEFAULT_MODELS, n: 5, check: false, hint: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models") out.models = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--n") out.n = Number(argv[++i]);
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--hint") out.hint = true;
  }
  return out;
}

/**
 * `--check` — 자격증명을 **필요한 동작 그대로** 확인한다.
 *
 * 🔑 권한 목록을 조회해 "있어 보인다"로 판정하지 않는다. Cloudflare 의 토큰 정책은 템플릿·
 * 범위 조합이 많아 **목록으로는 실제 허용 여부를 못 맞힌다.** 마지막 단계에서 `max_tokens: 1`
 * 짜리 **진짜 추론**을 한 번 돌린다 — 그게 우리가 쓸 동작 자체다. 비용은 뉴런 몇 개다.
 *
 * 단계를 나누는 이유: 401 하나로는 **토큰이 죽었나 · 계정이 다른가 · 권한이 없나**를 못 가른다.
 */
async function check(models, env) {
  const line = (ok, label, hint) =>
    process.stderr.write(`${ok ? "✅" : "🔴"} ${label}\n${ok || !hint ? "" : `      → ${hint}\n`}`);
  const json = async (url, init) => {
    try {
      const r = await fetch(url, init);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) { return { status: 0, body: { _err: String(e) } }; }
  };
  const auth = { authorization: `Bearer ${env.token}` };

  const v = await json("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: auth });
  const active = v.body?.result?.status === "active";
  line(active, `토큰 유효성 — ${active ? "active" : `HTTP ${v.status}`}`,
    "토큰이 죽었거나 잘못 복사됐다. 대시보드에서 새로 만든다");
  if (!active) return 3;

  // ⚠️ **이 단계로 중단하지 않는다.** `GET /accounts/{id}` 는 `Account Settings · Read` 를
  //    요구하는데 **우리는 그 권한이 필요 없다** — Workers AI 만 있으면 된다. 최소 권한으로
  //    만든 토큰은 여기서 403 이 정상이고, 그걸 게이트로 두면 **필요 없는 권한을 요구해
  //    진짜 검사를 가로막는다**(2026-08-08 실사례). 계정이 맞는지는 아래 추론이 판정한다.
  const a = await json(`${API}/${env.account}`, { headers: auth });
  const known = a.status === 200;
  line(true, `계정 이름 — ${known ? a.body?.result?.name : `확인 못 함(HTTP ${a.status})`}` +
    (known ? "" : " · 이 토큰엔 계정 조회 권한이 없다. 필요 없는 권한이라 그대로 진행한다"));

  // 🔴 여기가 진짜 판정이다 — 우리가 실제로 부를 엔드포인트를 그대로 부른다.
  const model = models[0];
  const r = await json(`${API}/${env.account}/ai/run/${model}`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
  });
  const ok = r.status === 200;
  // 🔴 여기가 유일한 판정이다. 401/403 이면 원인이 둘인데 응답 본문이 갈라 준다 —
  //    권한 부족이면 Workers AI 를 지목하고, 계정이 틀렸으면 대개 "not found" 계열이 온다.
  line(ok, `Workers AI 추론 (${model}) — ${ok ? "통과" : `HTTP ${r.status}`}`,
    r.status === 403 || r.status === 401
      ? "둘 중 하나다 — ① 토큰에 **Account · Workers AI** 권한이 없다(`Edit Cloudflare Workers` " +
        "템플릿엔 안 붙는다) ② `CF_ACCOUNT_ID` 가 이 토큰의 계정이 아니다.\n" +
        `        응답: ${JSON.stringify(r.body?.errors ?? r.body).slice(0, 300)}`
      : `응답: ${JSON.stringify(r.body).slice(0, 300)}`);
  if (!ok) return 3;

  // 도구 호출까지 되는지 — 여기서 막히면 모델은 살아 있어도 이 설계엔 못 쓴다.
  // 본 측정과 **같은 시스템 프롬프트**를 쓴다 — 여기서만 약하게 물으면 "이 모델은 툴을
  // 안 부른다"는 결론이 프롬프트 차이에서 나온 것인지 알 수 없다.
  const t = await json(`${API}/${env.account}/ai/run/${model}`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM },
                                      { role: "user", content: "서울 데이터 제품 목록 보여줘" }],
                           tools: toOpenAITools(TOOLS), max_tokens: 400 }),
  });
  line(t.status === 200, `tools 파라미터 수용 — ${t.status === 200 ? "통과" : `HTTP ${t.status}`}`,
    `이 모델·API 가 tools 를 안 받는다: ${JSON.stringify(t.body).slice(0, 200)}`);
  if (t.status !== 200) return 3;

  const calls = extractToolCalls(t.body?.result);
  line(calls.length, `도구 호출 실제 발생 — ${calls.length ? calls.map((c) => readCall(c).name).join(", ") : "없음"}`);
  if (!calls.length) {
    // 🔴 **추측하지 말고 보여 준다.** "안 불렀다"의 원인은 둘인데(모델이 안 부른 것 vs
    //    우리 파서가 엉뚱한 곳을 본 것) 응답 모양을 봐야 갈린다. 응답에 tool 흔적이
    //    보이는데 위가 "없음"이면 그건 모델 한계가 아니라 우리 결함이다.
    const res = t.body?.result ?? {};
    process.stderr.write(
      `\n      응답 최상위 키: ${JSON.stringify(Object.keys(res))}\n` +
      `      응답 본문(600자): ${JSON.stringify(res).slice(0, 600)}\n\n` +
      "      위에 tool_calls·function·name 같은 흔적이 보이면 **파서 문제**다(찾는 자리를 늘린다).\n" +
      "      순수 문장만 있으면 모델이 정말 안 부른 것이다 — 다른 모델로 --models 를 바꿔 본다.\n");
    return 3;
  }

  process.stderr.write("\n준비됐다. `npm run eval:model` 로 본 측정을 돌린다.\n");
  return 0;
}

async function main(argv) {
  const account = process.env.CF_ACCOUNT_ID, token = process.env.CF_AI_TOKEN;
  if (!account || !token) {
    process.stderr.write("CF_ACCOUNT_ID · CF_AI_TOKEN 환경변수가 필요하다 (원문을 인자로 넘기지 않는다)\n");
    return 2;
  }
  const { models, n, check: checkOnly, hint } = parseArgs(argv);
  if (checkOnly) return check(models, { account, token });

  const products = (await (await fetch(`${CATALOG}?cb=eval`)).json()).products;
  const cases = buildCases(products, n);
  process.stderr.write(`카탈로그 ${products.length}종 · 문항 ${cases.length}개 · 모델 ${models.length}개\n\n`);

  const rows = [];
  for (const model of models) {
    for (const cse of cases) {
      const r = await runModel(model, cse, products, { account, token }, { hint });
      // 🔴 인증 실패는 **즉시 멈춘다.** 재시도해도 같고, 계속 돌면 0/5 표가 나와서
      //    "모델이 못 한다"로 읽힌다 — 실제로는 한 번도 물어본 적이 없는 것이다.
      if (/^HTTP 40[13]$/.test(r.error || "")) {
        process.stderr.write(
          `\n🔴 ${r.error} — 자격증명이 거절됐다. 어디가 막혔는지 이 명령이 갈라 준다:\n\n` +
          "      npm run eval:model -- --check\n\n" +
          "   토큰 유효성 · 계정 접근 · Workers AI 추론 · 도구 호출을 순서대로 짚는다.\n");
        return 3;
      }
      const s = score(r, cse);
      rows.push({ model, cse, r, s });
      const mark = (b) => (b ? "O" : "X");
      process.stderr.write(
        `${model.split("/").pop().padEnd(22)} ${cse.expect.product_id.padEnd(30)} ` +
        `도달 ${mark(s.reached)} 제품 ${mark(s.product)} 패턴 ${mark(s.pattern)} 파라미터 ${mark(s.params)} ` +
        `· ${r.turns}턴${r.exhausted ? "(소진)" : ""}${r.error ? " · " + r.error : ""}\n`);
      // 🔑 **어디까지 갔는지**를 같이 남긴다. "도달 X" 만으로는 제품을 못 고른 건지,
      //    고르고 나서 멈춘 건지, 애초에 툴을 안 부른 건지가 안 갈린다 — 대응이 전부 다르다.
      const path = (r.trace || []).map((t) =>
        t.name === "describe_product" ? `describe(${t.args?.product_id ?? "?"})`
        : t.name === "run_pattern" ? `run(${t.args?.product_id ?? "?"}/${t.args?.pattern_id ?? "?"} ${JSON.stringify(Object.keys(t.args?.params || {}))})`
        : t.name).join(" → ");
      if (path) process.stderr.write(`${" ".repeat(23)}↳ ${path}\n`);
      if (r.answer) process.stderr.write(`${" ".repeat(23)}↳ [툴 대신 문장] ${r.answer.slice(0, 90)}\n`);
      if (r.errorBody) process.stderr.write(`${" ".repeat(23)}↳ ${r.errorBody}\n`);
    }
    process.stderr.write("\n");
  }

  // 요약은 stdout — 파일로 받아 결정 문서에 붙일 수 있게 한다
  const out = ["| 모델 | 도달 | 제품 | 패턴 | 파라미터 | 평균 턴 | 입력토큰 | 출력토큰 |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const model of models) {
    const mine = rows.filter((x) => x.model === model);
    const pct = (f) => `${mine.filter(f).length}/${mine.length}`;
    const avg = (f) => (mine.reduce((a, x) => a + f(x), 0) / mine.length).toFixed(1);
    out.push(`| \`${model}\` | ${pct((x) => x.s.reached)} | ${pct((x) => x.s.product)} | ` +
      `${pct((x) => x.s.pattern)} | ${pct((x) => x.s.params)} | ${avg((x) => x.r.turns)} | ` +
      `${avg((x) => x.r.usage.prompt)} | ${avg((x) => x.r.usage.completion)} |`);
  }
  process.stdout.write(out.join("\n") + "\n");

  // 🔑 **쓴 값을 눈에 보이게 한다.** "무료 안쪽이다"를 말로만 하면 다음 사람이 다시 걱정한다.
  //    단가는 `decision/0006` 확인절차 ③ 과 같은 출처(Workers AI pricing, 2026-08-08).
  const NEURONS_PER_MTOK = { in: 5500, out: 36400 };   // glm-4.7-flash 기준
  const FREE_PER_DAY = 10000;
  const tok = rows.reduce((a, x) => ({ in: a.in + x.r.usage.prompt, out: a.out + x.r.usage.completion }),
    { in: 0, out: 0 });
  const neurons = Math.round(tok.in / 1e6 * NEURONS_PER_MTOK.in + tok.out / 1e6 * NEURONS_PER_MTOK.out);
  process.stderr.write(
    `\n이번 실행: 입력 ${tok.in.toLocaleString()} · 출력 ${tok.out.toLocaleString()} 토큰 ` +
    `≈ **${neurons.toLocaleString()} 뉴런**\n` +
    `무료 할당 ${FREE_PER_DAY.toLocaleString()} 뉴런/일 기준 하루 약 ${Math.floor(FREE_PER_DAY / Math.max(neurons, 1))}회까지 무료다.\n`);
  return 0;
}

// `pathToFileURL` — Windows 경로를 손으로 `file://` 에 붙이면 안 맞아, 테스트가 import 하는
// 순간 CLI 가 도는 사고가 난다(`issue-service-key.mjs` 와 같은 이유).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 🔴 `process.exit()` 을 쓰지 않는다. `fetch` 가 keep-alive 소켓을 쥔 채로 즉시 죽이면
  //    Windows 에서 libuv 가 어서션으로 넘어진다(`UV_HANDLE_CLOSING`, 종료코드 127) —
  //    **검사가 통과했는지 실패했는지가 그 크래시에 묻힌다.** 종료코드만 정해 두고
  //    Node 가 핸들을 정리한 뒤 스스로 끝내게 한다.
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
