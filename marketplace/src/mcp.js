// src/mcp.js — MCP 서버 (Streamable HTTP · stateless POST /mcp). ASK-Seoul-Serving #26 P0.
//
// PlayMCP/원격 MCP 표면. **내부 HTTP 재호출 없이** marketplace shared 핸들러(handleCatalog 등)를
// deps 주입으로 직접 호출해 인증·쿼터·로그 이중집계를 피한다(#26 masondev). 외부 식별자는
// product_id 로 통일하고, 물리 테이블명 해석은 shared 해석기(decision/0003)에 맡긴다.
// stateless — 세션 상태 없음(과거 SSE 재접속 폭주 위험 회피).
//
// 툴(7): search_products · list_products · describe_product · preview_product · query_product · run_pattern ·
// check_quota. run_pattern 은 #118 실행 계약(2026-08-07 확정)으로 P1 에서 승격.

import { burstProblem, normalizeIntent, normalizeMcpClient, ATTRIBUTION } from "./shared.js";
// AI 소비자 공용 성형 — 채팅(#159)과 같은 모양을 보게 한다. `TOOLS` 는 여기가 정본이고
// 저쪽은 인자로 받아 읽기만 한다(순환 없음).
import { slimProductList, buildDataContext, searchProducts } from "./agent-tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ask-seoul", version: "0.1.0" };

// 툴 주석(annotations) — MCP 사양의 선택 필드지만 **PlayMCP 심사는 필수로 본다**
// (2026-08-09 반려 사유 ①: "툴 annotations 가 정의되지 않았습니다").
// 모든 툴이 성격이 같다: 저장된 데이터를 **읽기만** 하고(readOnly), 아무것도 지우지
// 않으며(destructive 아님), 같은 인자로 다시 부르면 같은 결과다(idempotent — 게시본이
// 바뀌기 전까지). `openWorldHint: false` 는 **닫힌 데이터셋**이라는 뜻이다 — 웹 검색처럼
// 예측 불가한 외부를 훑지 않고 우리가 게시한 57종 안에서만 답한다.
// 값을 툴마다 손으로 적지 않는 이유: 전부 같은 성격인데 따로 적으면 하나만 어긋난다.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const annotate = (title) => ({ title, ...READ_ONLY });

// 🔴 설명에는 **서비스명을 글자 그대로 넣는다** (PlayMCP 반려 사유 ②).
// ⚠️ 1차 수리에서 "서울시 데이터"만 넣었다가 **또 반려됐다**(2026-08-10). 검사기 문구
// *"서비스명(서울시 데이터 패턴)"* 의 괄호 안이 **찾는 문자열 그 자체**였다 — "패턴"을
// 수식어(= 정규식·패턴)로 읽은 것이 틀렸다. 지금은 `서울시 데이터 패턴` 전체를 넣는다.
// 이 문자열은 "서울시 데이터"를 부분으로 포함하므로 두 해석을 동시에 만족한다.
// 🔴 **줄이거나 바꾸지 말 것** — 한 글자만 달라도 전 툴이 한꺼번에 반려된다.
// 기존 문장의 AI 지시(호출 순서·runnable 조건·data_context 안내)는 그대로 둔다.
export const SERVICE_NAME = "서울시 데이터 패턴";
export const TOOLS = [
  // 🔴 **목록보다 앞에 둔다.** AI 는 위에서부터 읽고 첫 도구를 먼저 부르는 경향이 있는데,
  // 실측(2026-08-08)에서 `list_products` 142KB 를 다 못 읽고 없는 제품 이름을 9분에 13번
  // 지어냈다. 질문으로 바로 찾게 하면 그 왕복이 통째로 없어진다.
  {
    name: "search_products",
    title: "질문으로 제품 찾기",
    annotations: annotate("질문으로 제품 찾기"),
    description:
      "사용자 질문 문장을 그대로 넣어 서울시 데이터 패턴 서비스에서 맞는 제품을 찾습니다. 어떤 데이터를 써야 할지 모를 때 목록 전체를 훑는 대신 이 도구를 먼저 부르세요. 제품마다 왜 걸렸는지(matched_terms)와 바로 실행할 수 있는 질의 패턴(matched_patterns)이 함께 옵니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "사용자 질문 그대로. 예: 토요일 낮에 20대 많은 장소" },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "돌려받을 제품 수(기본 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_products",
    title: "서울시 데이터 제품 목록",
    annotations: annotate("서울시 데이터 제품 목록"),
    description:
      "서울시 데이터 패턴 서비스에서 조회 가능한 제품 전체의 목록과 대표 질문·조인키를 보여줍니다. 전체를 훑어야 할 때 쓰고, 질문에 맞는 제품을 고르는 것이 목적이면 search_products 가 빠릅니다. 목록에는 컬럼 이름과 질의 패턴의 질문만 담기므로, 제품을 고른 뒤 describe_product 로 상세를 확인하세요.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_product",
    title: "제품 상세 — 컬럼·질의 패턴",
    annotations: annotate("제품 상세 — 컬럼·질의 패턴"),
    description:
      "서울시 데이터 패턴 서비스의 제품 하나를 골라 컬럼 설명·기준(grain)·시간축·질의 패턴(usage_patterns)을 보여줍니다. 조회 전에 스키마와 필터 가능한 컬럼을 확인하세요. usage_patterns 중 runnable=true 인 것만 run_pattern 으로 실행할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string", description: "예: citydata_ppltn_dow_hour" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_product",
    title: "5행 미리보기",
    annotations: annotate("5행 미리보기"),
    description:
      "서울시 데이터 패턴 서비스의 제품 데이터 5행을 미리 봅니다(일일 한도 무차감). 필터에 넣을 실제 값(장소명·코드 등)을 확인할 때 사용하세요.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_product",
    title: "서울시 데이터 조회",
    annotations: annotate("서울시 데이터 조회"),
    description:
      "서울시 데이터 패턴 서비스의 데이터를 지역·기간·등가 필터로 조회합니다(sort/join/집계 불가, 커서로 페이지네이션). 응답의 data_context 에 집계 기준 시점(freshness)·출처(attribution)·주의사항(caution)이 함께 담깁니다.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        filters: {
          type: "object",
          description: "{컬럼: 값} 등가 필터. 유효 값은 preview_product 로 먼저 확인.",
          additionalProperties: { type: ["string", "number"] },
        },
        from: { type: "string", description: "시간축 시작(포함)" },
        to: { type: "string", description: "시간축 끝(포함)" },
        limit: { type: "integer", minimum: 1, maximum: 5000 },
        cursor: { type: "string", description: "다음 페이지 커서(이전 응답의 next_cursor)" },
        intent: {
          type: "string",
          description:
            "질문 의도 슬러그(선택, 관측용 — 조회 결과에 영향 없음). describe_product 의 usage_patterns pattern_id 를 쓰고, 맞는 게 없으면 'other'.",
        },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_pattern",
    title: "검증된 질의 패턴 실행",
    annotations: annotate("검증된 질의 패턴 실행"),
    description:
      "서울시 데이터 패턴 서비스에서 실제 데이터에 실행해 동작이 확인된 질의 패턴을 실행합니다. 질문에 맞는 패턴이 있으면 필터를 직접 조립하기보다 이 도구를 우선 사용하세요. describe_product 의 usage_patterns 에서 runnable=true 인 pattern_id 를 고르고 :파라미터 값을 params 로 전달하세요. 응답에는 insight_sample_ko(해석 예시)가 함께 제공됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        pattern_id: { type: "string", description: "describe_product 응답 usage_patterns 의 pattern_id" },
        params: {
          type: "object",
          description: "패턴 SQL 의 :이름 파라미터 값 — 선언된 이름만 받는다(모자라면/넘치면 400 에 목록 안내)",
          additionalProperties: { type: ["string", "number"] },
        },
      },
      required: ["product_id", "pattern_id"],
      additionalProperties: false,
    },
  },
  {
    name: "check_quota",
    title: "사용량·남은 한도 확인",
    annotations: annotate("사용량·남은 한도 확인"),
    description: "서울시 데이터 패턴 서비스 조회에 쓰는 내 API 키의 오늘 사용량과 남은 일일 한도를 확인합니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ── JSON-RPC 2.0 응답 헬퍼 (stateless: 단일 application/json) ────────────────
const rpcJson = (obj) =>
  new Response(JSON.stringify(obj), { headers: { "content-type": "application/json; charset=utf-8" } });
const rpcResult = (id, result) => rpcJson({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => rpcJson({ jsonrpc: "2.0", id, error: { code, message } });

const errText = (text) => ({ content: [{ type: "text", text }], isError: true });
const okJson = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

// 상태별 안내 기본값 — `/api/v1` 의 데이터 질의(preview·query)를 기준으로 쓴 문장이다.
// 같은 상태 코드라도 툴에 따라 **뜻이 다르면** 아래 툴별 표로 덮는다.
const BASE_HINTS = {
  400: "요청이 잘못됐습니다(없는 필터/시간축) — describe_product 로 컬럼을 확인하세요.",
  401: "키가 없거나 유효하지 않습니다 — 키를 발급/교체하세요.",
  403: "이 제품은 비공개입니다.",
  404: "없는 제품입니다 — list_products 로 확인하세요.",
  409: "커서가 만료됐습니다(게시본 갱신) — 처음부터 다시 조회하세요.",
  429: "쿼터/버스트 초과 — 잠시 후 재시도하세요(Retry-After).",
  503: "게시 정합성 일시 불일치 — 잠시 후 재시도하세요.",
};

// `run_pattern` 은 같은 코드가 다른 사건을 뜻한다 — 400 은 필터가 아니라 pattern_id·파라미터
// 문제이고, 409 는 커서 만료가 아니라 **미검증 패턴**이다(handleRunPattern). 기본 문장을 그대로
// 쓰면 안내가 본문 detail 과 정반대를 말한다 — 실측(2026-08-08 전수 평가)에서 AI 가 그 안내를
// 믿고 list_products 로 되돌아가 왕복을 낭비했다. 안내가 틀리면 없느니만 못하다.
const RUN_PATTERN_HINTS = {
  400: "패턴 요청이 잘못됐습니다 — describe_product 의 usage_patterns 에서 pattern_id 와 필요한 파라미터를 확인하세요.",
  409: "아직 검증되지 않아 실행할 수 없는 패턴입니다 — describe_product 에서 runnable 이 true 인 패턴을 고르세요.",
};

// Response(shared 핸들러 결과) → MCP tool result. 4xx/5xx 는 상태별 사용자 안내로.
//
// **실패한 상태를 `trace` 에 옮겨 싣는다**(#62). JSON-RPC 는 오류도 봉투 안에 담아 HTTP 는
// 200 이라, 그대로 두면 로그가 전부 `mcp/200` 이 되고 콘솔의 오류율이 영원히 0 이 된다.
// 요청 하나에 툴 호출은 하나이므로 여기서 정해지는 값도 하나다.
async function toToolResult(res, trace = {}, hintOverrides = null) {
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (res.status >= 400) {
    trace.status = res.status;
    // 권리 차단(#88)은 게시 정합성 503 과 달리 재시도해도 동일하다 — 일반 "재시도" 문구로
    // 오도하지 않고 권리 사유로 안내한다. handleData(rightsBlockedProblem)가 blockers 로 표식한다.
    const rightsBlockers = (body && typeof body === "object" && Array.isArray(body.blockers)) ? body.blockers : [];
    if (res.status === 503 && rightsBlockers.some((b) => b === "source_redistribution_not_allowed" || b === "missing_source_rights_evidence")) {
      return errText("이 제품은 원천이 재배포를 허용한 근거가 아직 확인되지 않아 제공할 수 없습니다(권리 사유 — 재시도해도 동일). describe_product 로 원천·라이선스를 확인하세요.");
    }
    const hint = { ...BASE_HINTS, ...(hintOverrides || {}) }[res.status] || `요청 실패(${res.status})`;
    return errText(`${hint}\n${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return okJson(body);
}

// 오타·기억 오류로 없는 product_id 를 부르면 비슷한 이름을 제안한다 — AI 가 사용자에게
// 반문하는 대신 스스로 교정해 재시도할 수 있게 한다(왕복 절약). 404 에서만 카탈로그를 읽는다.
// bigram 겹침 비율이면 충분하다 — 제품명은 소문자 스네이크라 형태가 균질하다.
// 임계 0.3: 오타 한두 글자(예: pplnt→ppltn)는 0.5 안팎, 무관한 이름은 0.2 아래로 갈리는
// 경계 실측값. 상위 3: 안내 문장이 읽히는 상한 — 더 주면 AI 가 고르다 또 헤맨다.
function similarIds(target, ids, n = 3) {
  const bigrams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
  const t = bigrams(String(target));
  return ids
    .map((id) => { const b = bigrams(id); let hit = 0; for (const g of t) if (b.has(g)) hit += 1; return { id, score: hit / Math.max(t.size, b.size) }; })
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, n).map((x) => x.id);
}

async function notFoundWithSuggestions(env, deps, productId, trace) {
  trace.status = 404;
  let hint = "";
  try {
    const cat = await deps.handleCatalog(env);
    if (cat.status < 400) {
      const { products = [] } = await cat.json();
      const near = similarIds(productId, products.map((p) => p.product_id));
      if (near.length) hint = ` 비슷한 제품이 있습니다: ${near.join(" · ")} — 이 중 하나를 의도했다면 그 이름으로 다시 시도하세요.`;
    }
  } catch { /* 제안은 덤이다 — 실패해도 404 안내는 나간다 */ }
  return errText(`없는 제품입니다: ${productId} — list_products 로 확인하세요.${hint}`);
}

// 제품은 있는데 그 패턴이 없을 때. 위 유사 제품 제안과 **같은 취지**다 — 다음 시도가 또
// 추측이면 왕복만 는다. 다른 점은 이쪽은 짐작할 필요조차 없다는 것이다: 제품이 가진
// pattern_id 는 확정 목록이라 그대로 실어 준다.
// 실측(2026-08-08 전수 평가)에서 AI 가 `hotspot-top-grids` 처럼 **없는 이름을 지어내** 400·404 를
// 오간 사례가 나왔다. 목록이 응답 안에 있으면 그 루프가 한 번에 끝난다.
// 🔴 실행 가능(runnable)만 싣는다 — 미검증 패턴을 권하면 다음 호출이 409 로 끝난다.
// 상한 12: 안내 문장이 읽히는 선. 넘으면 개수만 알린다(제품당 최대 16개 — prod 실측).
const MAX_PATTERN_HINT = 12;

async function unknownPatternWithList(env, deps, request, productId, patternId, trace) {
  trace.status = 404;
  let hint = " describe_product 의 usage_patterns 에서 pattern_id 를 확인하세요.";
  try {
    // trace 를 넘기지 않는다 — 메타 조회가 위에서 정한 404 를 200 으로 덮으면 로그가 거짓말한다.
    const res = await deps.handleProductBundle(env, productId, request, {});
    if (res.status < 400) {
      const body = await res.json();
      const list = body.patterns || body.usage_patterns || [];
      const ids = list.filter((p) => p && p.runnable !== false && p.pattern_id).map((p) => p.pattern_id);
      const shown = ids.slice(0, MAX_PATTERN_HINT);
      if (shown.length)
        hint = ` 이 제품에서 실행 가능한 pattern_id: ${shown.join(" · ")}` +
          (ids.length > shown.length ? ` 외 ${ids.length - shown.length}개` : "") +
          " — 이 중 하나를 그대로 쓰세요(이름을 지어내지 마세요).";
    }
  } catch { /* 목록은 덤이다 — 실패해도 404 안내는 나간다 */ }
  return errText(`'${patternId}' 는 '${productId}' 의 패턴이 아닙니다.${hint}`);
}

async function callTool(name, args, ctx) {
  const { env, request, keyRow, trace, deps } = ctx;
  args = args || {};
  if (name === "search_products") {
    if (!args.query) return errText("query 가 필요합니다 — 사용자 질문 문장을 그대로 넣으세요.");
    // 목록과 **같은 카탈로그**를 읽는다(SWR 캐시) — 검색 전용 색인을 따로 만들면 카탈로그가
    // 바뀔 때 둘이 갈린다. 무과금: 데이터가 아니라 고르기 위한 판단 재료다(list_products 와 같은 규칙).
    const res = await deps.handleCatalog(env);
    if (res.status >= 400) return toToolResult(res, trace);
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    return okJson(searchProducts(await res.json(), args.query, limit));
  }
  if (name === "list_products") {
    const res = await deps.handleCatalog(env);
    if (res.status >= 400) return toToolResult(res, trace);
    const body = await res.json();
    // `verified`·`verified_bundle` 은 뺐다(#172, 2026-08-08). 그 값의 출처가
    // **K-Skill 경로 allowlist**(skill.js SKILL_PRODUCT_IDS)였는데, 설명은 "출처·품질
    // 증거까지 검증"이라 **말과 실체가 달랐다** — PR#161 이 allowlist 를 6→1 로 줄이자
    // 실측 ready 인 제품 10종까지 verified:false 로 나갈 뻔했다(kang 실측, #172).
    // 합의(#172 masondev·kang): mcp 는 skill.js 상수를 직접 참조하지 않는다. K-Skill
    // 소속은 /skill/v1 번들이 말하고, 증거 신호는 별도 `evidence_ready` 로 **추후** 온다 —
    // 그때까지 없는 판정을 싣지 않는다(없는 필드가 틀린 필드보다 낫다).
    //
    // 🔴 **목록은 고르기 위한 것이지 읽기 위한 것이 아니다.** 카탈로그 본문을 그대로
    // 흘려보내면 57종의 질의 패턴 431건과 컬럼 전량이 함께 나가 응답이 **510KB**가 된다
    // (실측 2026-08-08: usage_patterns 75.5% · columns 17.2% = 93%). 이건 AI 가 **가장 먼저**
    // 부르는 도구라, 한 번의 호출로 컨텍스트가 무너지고 응답도 2.7~10초가 걸린다.
    // 실제로 전수 평가에서 AI 가 이 응답을 파일로 저장한 뒤 grep 으로 뒤지는 이상행동을 했다.
    // 둘 다 `describe_product` 가 제품별로 이미 주는 것이므로, 여기서는 **개수만** 남긴다.
    // 개수를 남기는 이유: 0 이면 "아직 메타가 없는 제품"이라 고르는 판단에 쓰인다.
    // ⚠️ `/api/v1/catalog`(REST)는 건드리지 않는다 — 웹 카탈로그 화면이 상세를 쓴다.
    // 🔴 다만 **전부 빼면 안 된다.** 패턴의 `question_ko` 431건은 소비자가 제품을 고르는
    // **검색 신호**다 — "창업 후 오래 살아남는 업종"이 어느 제품인지 대표질문 57개로는
    // 흐릿한데, 패턴 질문까지 있으면 정확히 걸린다(전수 평가에서 AI 가 이 텍스트를
    // 키워드로 훑어 제품을 찾아냈다). 그 신호는 27KB 뿐이고, 버리는 200KB 는 목록 단계에서
    // 쓰이지 않는 것들이다: `sql` 54.2%(AI 는 SQL 을 직접 실행하지 않는다 — run_pattern 이
    // pattern_id 로 돌린다) · `insight_sample_ko`(실행 응답에 온다) · `requires`·`axes`
    // (describe_product 와 400 안내가 말해 준다) · `verified_*`.
    // 컬럼도 같다 — 이름은 "이 축으로 필터되나"를 목록에서 판단하게 하고, 설명은 상세의 몫이다.
    // 성형은 **AI 소비자 공용 층**이 한다(agent-tools.js) — 채팅도 같은 모양을 봐야 하고,
    // 두 벌이 되면 한쪽만 고쳐진다(#159 ②, MCP 담당 조건).
    return okJson(slimProductList(body));
  }
  if (name === "check_quota") {
    // /api/v1/me 는 본인에게 주는 응답이라 이메일을 담지만, MCP 결과는 LLM 컨텍스트·제3자
    // 클라이언트로 흘러간다 — 이메일 미노출(#26 완료기준). 키는 원래 prefix 만 나간다.
    const res = await deps.handleMe(env, keyRow);
    if (res.status >= 400) return toToolResult(res, trace);
    const { email, ...body } = await res.json();
    return okJson(body);
  }
  if (name === "describe_product") {
    if (!args.product_id) return errText("product_id 가 필요합니다.");
    const res = await deps.handleProductBundle(env, args.product_id, request, trace);
    if (res.status === 404) return notFoundWithSuggestions(env, deps, args.product_id, trace);
    return toToolResult(res, trace);
  }
  if (name === "preview_product" || name === "query_product") {
    if (!args.product_id) return errText("product_id 가 필요합니다.");
    // 식별자 해석은 shared 해석기 한 곳에 맡긴다(decision/0003: product_id 정본, 테이블명은
    // 과도기 별칭). 없는/비공개 제품의 404 는 toToolResult 가 안내 문구로 바꾼다.
    if (name === "preview_product") {
      const res = await deps.handlePreview(env, args.product_id, trace);
      if (res.status === 404) return notFoundWithSuggestions(env, deps, args.product_id, trace);
      return toToolResult(res, trace);
    }
    // intent 는 관측 축(agreement §3-6) — MCP 클라이언트는 헤더를 질의마다 못 바꾸므로 인자로
    // 받아 trace 로 옮겨 싣는다(데이터 질의에는 미포함 — 필터로 새면 400 이 난다). 슬러그
    // 모양이 아니면 'other' 로 뭉갠다 — 자유 문장이 오면 원문(PII 위험)을 로그에 남기지 않는다.
    // 판정은 헤더 경로와 **같은 함수**를 쓴다(shared) — 두 경로가 한 컬럼에 들어가므로
    // 규칙이 갈리면 같은 값이 경로에 따라 다르게 기록된다.
    if (args.intent) trace.intent = normalizeIntent(args.intent) ?? trace.intent ?? null;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args.filters || {})) params.set(k, String(v));
    if (args.from) params.set("from", String(args.from));
    if (args.to) params.set("to", String(args.to));
    if (args.limit) params.set("limit", String(args.limit));
    if (args.cursor) params.set("cursor", String(args.cursor));
    const res = await deps.handleData(env, args.product_id, params, keyRow, trace, { includeMeta: true });
    if (res.status === 404) return notFoundWithSuggestions(env, deps, args.product_id, trace);
    if (res.status >= 400) return toToolResult(res, trace);
    const body = await res.json();
    // 답변 가드레일 — 신선도·출처·주의를 결과에 동봉한다. AI 가 "언제 기준·어디 출처"를
    // 답변에 실을 수 있어야 오래된 데이터를 현재로 단언하는 환각이 줄어든다.
    // 메타는 handleData 가 같은 행에서 이미 읽은 것을 재사용한다(#118 리뷰 ② — 핫패스에
    // D1 왕복을 안 늘린다). product_meta 는 운반용이라 밖으로는 data_context 로만 나간다.
    const meta = body.product_meta;
    delete body.product_meta;
    const ctx = buildDataContext(meta);
    if (ctx) body.data_context = ctx;
    return okJson(body);
  }
  if (name === "run_pattern") {
    if (!args.product_id || !args.pattern_id) return errText("product_id 와 pattern_id 가 필요합니다.");
    if (args.intent) trace.intent = normalizeIntent(args.intent) ?? trace.intent ?? null;
    const res = await deps.handleRunPattern(env, args.product_id, args.pattern_id, args.params || {}, keyRow, trace);
    if (res.status === 404) {
      // 제품 오타일 수도, 패턴 오타일 수도 있다 — 본문 detail 이 둘을 가른다. 어느 쪽이든
      // "다음에 무엇을 쓰면 되는지"를 함께 준다: 제품이면 유사 이름, 패턴이면 실제 목록.
      const body = await res.clone().json().catch(() => null);
      if (body && /서빙 카탈로그에 없다/.test(body.detail || "")) return notFoundWithSuggestions(env, deps, args.product_id, trace);
      return unknownPatternWithList(env, deps, request, args.product_id, args.pattern_id, trace);
    }
    return toToolResult(res, trace, RUN_PATTERN_HINTS);
  }
  return errText(`알 수 없는 tool: ${name}`);
}

// ── 진입점: POST /mcp (stateless JSON-RPC) ──────────────────────────────────
// deps = { authenticate, checkBurst, handleCatalog, handlePreview, handleData, handleMe,
//          handleProductBundle }
export async function handleMcp(request, env, trace, deps) {
  let msg;
  try {
    msg = await request.json();
  } catch {
    // 봉투를 못 읽었으니 요청 형식 오류다(#62). 404 로 적지 않는 이유 — 콘솔은 404 를
    // "없는 데이터"로 읽어서, 파싱 실패가 없는 제품을 부른 것처럼 보인다.
    trace.status = 400;
    return rpcError(null, -32700, "parse error");
  }
  const { id = null, method, params } = msg || {};

  // 발견 단계 — 데이터·쿼터 미소모(masondev 완료기준). 로드용이라 인증 요구 안 함.
  if (method === "initialize") {
    // 🔑 `clientInfo` 는 **MCP 판 User-Agent** 다(#111 후속). UA 로는 MCP 클라이언트를 못
    // 잡아 prod 호출 95건이 전부 `ua_class='unknown'` 이었는데, 그 이름이 프로토콜 규격
    // 안에 이미 있었다. `intent` 가 만든 선례와 같은 방식으로 trace 를 덮어쓴다.
    //
    // ⚠️ `agent_verified` 는 **건드리지 않는다.** clientInfo 도 자기 신고라 Cloudflare
    //    검증 대상이 아니고, `clientAxes` 가 이미 넣은 NULL 이 맞는 값이다("검증할 것이
    //    없다"). 여기서 0 을 쓰면 스펙이 경고한 "검증 실패" 오독이 된다.
    //
    // ⚠️ `ua_class` 도 그대로 둔다 — 그건 **전송 계층 자기 신고**의 분류이고, UA 를 진짜
    //    못 알아본 것은 사실이다. 프로토콜 사실로 덮으면 #112 가 갈라 놓은 축이 도로 뭉개진다.
    const client = normalizeMcpClient(params?.clientInfo?.name);
    if (client) {
      trace.agentName = client;
      // 출처를 이 값이 말한다 — UA 에서 온 이름(crawler·on_demand)과 섞이지 않게.
      trace.agentMode = "mcp_client";
    }
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled")
    return new Response(null, { status: 202 });
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    // 데이터 대면 — 여기서만 BYOK 인증(쿼터·로그는 각 shared 핸들러가 1회 반영).
    const { keyRow, error } = await deps.authenticate(env, request);
    if (error) {
      trace.status = error.status;
      return rpcResult(
        id,
        // 발급 방법은 배포마다 갈린다(#110 ②) — 여기서 한쪽을 단정하면 403 인 문을 가리키게 된다.
        // MCP 클라이언트는 브라우저를 못 여니 **사람이 받아 설정에 넣는다**는 것까지 말해 준다.
        errText("키가 없거나 유효하지 않습니다 — Authorization: Bearer ask_... 가 필요합니다. " +
          "키는 사람이 받아 클라이언트 설정에 넣어야 합니다: GET /api/v1/catalog 의 key_issuance 가 " +
          "이 서버의 발급 방법(google_oauth 이면 브라우저로 /api/v1/auth/google)을 알려 줍니다."),
      );
    }
    trace.keyHash = keyRow.key_hash;

    // 관측 route 세분화(#63 A)는 **버스트 앞**에서 정한다 — REST 는 라우터가 버스트 앞에서
    // route 를 정해 429 도 'data' 로 남는데, 이 줄이 callTool 안(버스트 뒤)에 있으면 MCP 만
    // 거부분이 'mcp' 로 남아 SERVE 집계에서 통째로 빠진다(성진 실측: 통과 60 / 거부 4).
    // 모르는 툴 이름은 세분화하지 않는다 — route 값 집합을 오염시키지 않기 위해서다.
    const toolName = params && params.name;
    if (TOOLS.some((t) => t.name === toolName)) trace.route = `mcp_${toolName}`;

    // 버스트는 다른 네 표면과 **같은 자리·같은 버킷**에서 본다(agreement §7 — 쿼터보다 먼저).
    // 여기만 비어 있으면 루프를 도는 에이전트가 상한 없이 들어온다(#61). 인증 뒤에 두는 것도
    // 같은 이유다 — 키 없는 요청이 남의 버킷을 밀어 올리면 안 된다.
    //
    // 응답은 JSON-RPC 봉투가 아니라 **HTTP 429** 다. `Retry-After` 를 실어야 클라이언트가
    // 언제 다시 올지 알고(§7 의 헤더 3종), 그래야 로그의 상태도 다른 문과 같은 뜻이 된다.
    // Streamable HTTP 는 전송 계층 오류를 HTTP 상태로 돌려주는 것을 허용한다.
    const burst = await deps.checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);

    const result = await callTool(params && params.name, params && params.arguments, {
      env,
      request,
      keyRow,
      trace,
      deps,
    });
    return rpcResult(id, result);
  }

  // 없는 **메서드**이지 없는 제품이 아니다 — 파싱 실패와 같은 이유로 400 이다(#62).
  trace.status = 400;
  return rpcError(id, -32601, `method not found: ${method}`);
}
