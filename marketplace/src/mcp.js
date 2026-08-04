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
import { burstProblem } from "./shared.js";

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
      "제품 데이터 조회 — 등가 필터·시간범위(from/to)·limit·cursor. sort/join/집계는 불가(서버 결정 순서). 커서로 페이지네이션.",
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
    return toToolResult(await deps.handleProductBundle(env, args.product_id, request, trace), trace);
  }
  if (name === "preview_product" || name === "query_product") {
    if (!args.product_id) return errText("product_id 가 필요합니다.");
    // 식별자 해석은 shared 해석기 한 곳에 맡긴다(decision/0003: product_id 정본, 테이블명은
    // 과도기 별칭). 없는/비공개 제품의 404 는 toToolResult 가 안내 문구로 바꾼다.
    if (name === "preview_product") return toToolResult(await deps.handlePreview(env, args.product_id, trace), trace);
    // intent 는 관측 축(agreement §3-6) — MCP 클라이언트는 헤더를 질의마다 못 바꾸므로 인자로
    // 받아 trace 로 옮겨 싣는다(데이터 질의에는 미포함 — 필터로 새면 400 이 난다). 슬러그
    // 모양이 아니면 'other' 로 뭉갠다 — 자유 문장이 오면 원문(PII 위험)을 로그에 남기지 않는다.
    if (args.intent) trace.intent = /^[a-z0-9_]{1,64}$/.test(args.intent) ? args.intent : "other";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args.filters || {})) params.set(k, String(v));
    if (args.from) params.set("from", String(args.from));
    if (args.to) params.set("to", String(args.to));
    if (args.limit) params.set("limit", String(args.limit));
    if (args.cursor) params.set("cursor", String(args.cursor));
    return toToolResult(await deps.handleData(env, args.product_id, params, keyRow, trace), trace);
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
