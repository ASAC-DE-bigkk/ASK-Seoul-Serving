// src/mcp.js — MCP 서버 (Streamable HTTP · stateless POST /mcp). ASK-Seoul-Serving #26 P0.
//
// PlayMCP/원격 MCP 표면. **내부 HTTP 재호출 없이** marketplace shared 핸들러(handleCatalog 등)를
// deps 주입으로 직접 호출해 인증·쿼터·로그 이중집계를 피한다(#26 masondev). 외부 식별자는
// product_id 로 통일하고, 물리 테이블명 해석은 shared 해석기(decision/0003)에 맡긴다.
// stateless — 세션 상태 없음(과거 SSE 재접속 폭주 위험 회피).
//
// P0 툴(5): list_products · describe_product · preview_product · query_product · check_quota.
// run_pattern 은 서버 실행계약 확정 후 P1.

import { SKILL_BUNDLE_ID, SKILL_PRODUCT_IDS } from "./skill.js";
import { burstProblem, normalizeIntent } from "./shared.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ask-seoul", version: "0.1.0" };

export const TOOLS = [
  {
    name: "list_products",
    description:
      "공개 서빙 제품 목록 — product_id·대표질문(product_question)·조인키·설명. 어느 제품이 사용자 질문에 맞는지 고를 때 먼저 부른다. verified=true 는 출처·품질 증거까지 닫힌 검증 번들(seoul-urban-analytics) 제품이고, 나머지는 일반 카탈로그다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_product",
    description:
      "제품 상세 — 컬럼 설명·grain·PK·시간축·usage_patterns·출처/신선도. 데이터 조회 전 스키마와 필터 가능 컬럼을 파악한다.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string", description: "예: citydata_ppltn_dow_hour" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_product",
    description:
      "제품 5행 미리보기(쿼터 무과금) — 실물이 쓸만한지, 등가 필터에 넣을 값 예시(장소명·코드 등)를 확인한다.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_product",
    description:
      "제품 데이터 조회 — 등가 필터·시간범위(from/to)·limit·cursor. sort/join/집계는 불가(서버 결정 순서). 커서로 페이지네이션. 응답의 data_context(freshness=데이터 기준 시점·caution=주의사항·attribution=출처 표시 의무)를 답변에 반영할 것 — 데이터는 실시간이 아니다.",
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
    name: "check_quota",
    description: "내 키의 남은 일일 쿼터 확인(used/quota/exceeded).",
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

// Response(shared 핸들러 결과) → MCP tool result. 4xx/5xx 는 상태별 사용자 안내로.
//
// **실패한 상태를 `trace` 에 옮겨 싣는다**(#62). JSON-RPC 는 오류도 봉투 안에 담아 HTTP 는
// 200 이라, 그대로 두면 로그가 전부 `mcp/200` 이 되고 콘솔의 오류율이 영원히 0 이 된다.
// 요청 하나에 툴 호출은 하나이므로 여기서 정해지는 값도 하나다.
async function toToolResult(res, trace = {}) {
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
    const hint =
      {
        400: "요청이 잘못됐습니다(없는 필터/시간축) — describe_product 로 컬럼을 확인하세요.",
        401: "키가 없거나 유효하지 않습니다 — 키를 발급/교체하세요.",
        403: "이 제품은 비공개입니다.",
        404: "없는 제품입니다 — list_products 로 확인하세요.",
        409: "커서가 만료됐습니다(게시본 갱신) — 처음부터 다시 조회하세요.",
        429: "쿼터/버스트 초과 — 잠시 후 재시도하세요(Retry-After).",
        503: "게시 정합성 일시 불일치 — 잠시 후 재시도하세요.",
      }[res.status] || `요청 실패(${res.status})`;
    return errText(`${hint}\n${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return okJson(body);
}

// 오타·기억 오류로 없는 product_id 를 부르면 비슷한 이름을 제안한다 — AI 가 사용자에게
// 반문하는 대신 스스로 교정해 재시도할 수 있게 한다(왕복 절약). 404 에서만 카탈로그를 읽는다.
// bigram 겹침 비율이면 충분하다 — 제품명은 소문자 스네이크라 형태가 균질하다.
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

async function callTool(name, args, ctx) {
  const { env, request, keyRow, trace, deps } = ctx;
  args = args || {};
  if (name === "list_products") {
    const res = await deps.handleCatalog(env);
    if (res.status >= 400) return toToolResult(res, trace);
    const body = await res.json();
    // 검증 번들(#4 exact-six)과 일반 카탈로그를 구분해 노출한다(#26). 스코프는 전체 공개
    // 제품(팀 결정 2026-08-04) — verified 는 신뢰 표시이지 필터가 아니다.
    const verified = new Set(SKILL_PRODUCT_IDS);
    if (Array.isArray(body.products))
      body.products = body.products.map((p) => ({ ...p, verified: verified.has(p.product_id) }));
    body.verified_bundle = SKILL_BUNDLE_ID;
    return okJson(body);
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
    const res = await deps.handleData(env, args.product_id, params, keyRow, trace);
    if (res.status === 404) return notFoundWithSuggestions(env, deps, args.product_id, trace);
    if (res.status >= 400) return toToolResult(res, trace);
    const body = await res.json();
    // 답변 가드레일 — 신선도·출처·주의를 결과에 동봉한다. AI 가 "언제 기준·어디 출처"를
    // 답변에 실을 수 있어야 오래된 데이터를 현재로 단언하는 환각이 줄어든다. 조회 자체는
    // 성공했으므로 여기서의 실패는 삼킨다(가드레일은 덤이지 조회의 조건이 아니다).
    try {
      const meta = await deps.lookupProduct(env, args.product_id, "description, freshness, serving_status");
      if (meta) {
        body.data_context = {
          freshness: meta.freshness ?? null,          // 이 게시본의 원천 기준 시각 — "지금"이 아니다
          serving_status: meta.serving_status ?? null,
          ...(meta.serving_status && meta.serving_status !== "published"
            ? { warning: `serving_status='${meta.serving_status}' — 원천 수집 지연 등으로 최신성이 보장되지 않는다` }
            : {}),
          attribution: "공공 원천의 2차 가공물 — 답변에 출처 표시 필요, 조건은 /legal#attribution",
          caution: meta.description ?? null,          // 제품 주의사항("공식 특보 아님" 등)이 여기 있다
        };
      }
    } catch { /* 메타 실패가 조회 성공을 가리면 안 된다 */ }
    return okJson(body);
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
  if (method === "initialize")
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
    });
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
        errText("키가 없거나 유효하지 않습니다 — Authorization: Bearer ask_... 필요(POST /api/v1/keys 발급)."),
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
