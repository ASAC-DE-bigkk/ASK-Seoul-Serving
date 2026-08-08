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
 * 모델을 바꾸려면 `--models a,b`, 문항 수는 `--n 5`.
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
export function answerTool(name, args, products) {
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
    return {
      product_id: p.product_id, grain: p.grain, time_axis: p.time_axis,
      columns: (p.columns || []).map((c) => c.name || c),
      usage_patterns: (p.usage_patterns || []).map((u) => ({
        pattern_id: u.pattern_id, question_ko: u.question_ko,
        runnable: Boolean(u.verified_at), params: declaredParams(u.sql),
      })),
    };
  }
  // run_pattern·query_product·preview_product 는 **실행하지 않는다.** 여기까지 왔다는 것이
  // 곧 측정하려던 결과이므로, 도달 사실만 남기고 대화를 끝낸다.
  return { _terminal: true };
}

async function runModel(model, cse, products, env) {
  const messages = [
    { role: "system", content:
      "당신은 서울 공공데이터 API 안내자입니다. 데이터를 직접 조회하지 말고 반드시 도구를 사용하세요. " +
      "SQL 을 작성하지 마세요 — 검증된 질의 패턴(run_pattern)을 고르고 파라미터만 채웁니다. " +
      "먼저 list_products 로 제품을 고르고, describe_product 로 패턴을 확인한 뒤, runnable=true 인 패턴을 run_pattern 으로 실행하세요." },
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
    if (!res.ok) return { trace, error: `HTTP ${res.status}`, usage, turns: turn + 1 };
    const body = await res.json();
    const r = body.result || {};
    usage = { prompt: usage.prompt + (r.usage?.prompt_tokens || 0),
              completion: usage.completion + (r.usage?.completion_tokens || 0) };

    const calls = r.tool_calls || [];
    if (!calls.length) return { trace, answer: (r.response || "").slice(0, 200), usage, turns: turn + 1 };

    for (const c of calls) {
      const name = c.name || c.function?.name;
      let args = c.arguments ?? c.function?.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      trace.push({ name, args });
      const out = answerTool(name, args, products);
      if (out._terminal) return { trace, usage, turns: turn + 1 };
      messages.push({ role: "assistant", content: "", tool_calls: [c] });
      messages.push({ role: "tool", name, content: JSON.stringify(out).slice(0, 6000) });
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
  const out = { models: DEFAULT_MODELS, n: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models") out.models = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--n") out.n = Number(argv[++i]);
  }
  return out;
}

async function main(argv) {
  const account = process.env.CF_ACCOUNT_ID, token = process.env.CF_AI_TOKEN;
  if (!account || !token) {
    process.stderr.write("CF_ACCOUNT_ID · CF_AI_TOKEN 환경변수가 필요하다 (원문을 인자로 넘기지 않는다)\n");
    return 2;
  }
  const { models, n } = parseArgs(argv);
  const products = (await (await fetch(`${CATALOG}?cb=eval`)).json()).products;
  const cases = buildCases(products, n);
  process.stderr.write(`카탈로그 ${products.length}종 · 문항 ${cases.length}개 · 모델 ${models.length}개\n\n`);

  const rows = [];
  for (const model of models) {
    for (const cse of cases) {
      const r = await runModel(model, cse, products, { account, token });
      // 🔴 인증 실패는 **즉시 멈춘다.** 재시도해도 같고, 계속 돌면 0/5 표가 나와서
      //    "모델이 못 한다"로 읽힌다 — 실제로는 한 번도 물어본 적이 없는 것이다.
      if (/^HTTP 40[13]$/.test(r.error || "")) {
        process.stderr.write(
          `\n🔴 ${r.error} — 자격증명이 거절됐다. 모델을 재기 전에 이것부터 푼다.\n` +
          "   ① 토큰 자체가 유효한가\n" +
          "        curl.exe -s https://api.cloudflare.com/client/v4/user/tokens/verify \\\n" +
          '          -H "authorization: Bearer $env:CF_AI_TOKEN"\n' +
          "   ② 토큰에 Workers AI 권한(Account · Workers AI · Read)이 있는가\n" +
          "   ③ CF_ACCOUNT_ID 가 그 토큰의 계정인가 — `npx wrangler whoami`\n");
        return 3;
      }
      const s = score(r, cse);
      rows.push({ model, cse, r, s });
      const mark = (b) => (b ? "O" : "X");
      process.stderr.write(
        `${model.split("/").pop().padEnd(22)} ${cse.expect.product_id.padEnd(30)} ` +
        `도달 ${mark(s.reached)} 제품 ${mark(s.product)} 패턴 ${mark(s.pattern)} 파라미터 ${mark(s.params)} ` +
        `· ${r.turns}턴${r.exhausted ? "(소진)" : ""}${r.error ? " · " + r.error : ""}\n`);
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
  return 0;
}

// `pathToFileURL` — Windows 경로를 손으로 `file://` 에 붙이면 안 맞아, 테스트가 import 하는
// 순간 CLI 가 도는 사고가 난다(`issue-service-key.mjs` 와 같은 이유).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
