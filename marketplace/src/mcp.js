// src/mcp.js — MCP 서버 (Streamable HTTP · stateless POST /mcp). ASK-Seoul-Serving #26 P0.
//
// PlayMCP/원격 MCP 표면. **내부 HTTP 재호출 없이** marketplace shared 핸들러(handleCatalog 등)를
// deps 주입으로 직접 호출해 인증·쿼터·로그 이중집계를 피한다(#26 masondev). 외부 식별자는
// product_id 로 통일하고 실제 D1 table name(_catalog.name)은 어댑터 안에서만 해석한다.
// stateless — 세션 상태 없음(과거 SSE 재접속 폭주 위험 회피).
//
// P0 툴(5): list_products · describe_product · preview_product · query_product · check_quota.
// run_pattern 은 서버 실행계약 확정 후 P1.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ask-seoul", version: "0.1.0" };

export const TOOLS = [
  {
    name: "list_products",
    description:
      "공개 서빙 제품 목록 — product_id·대표질문(product_question)·조인키·설명. 어느 제품이 사용자 질문에 맞는지 고를 때 먼저 부른다.",
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
async function toToolResult(res) {
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (res.status >= 400) {
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

// product_id → 실제 D1 table name(_catalog.name). 공개(external=1)만.
async function resolveTable(env, productId) {
  const row = await env.DB.prepare("SELECT name FROM _catalog WHERE product_id = ? AND external = 1")
    .bind(productId)
    .first();
  return row ? row.name : null;
}

async function callTool(name, args, ctx) {
  const { env, request, keyRow, trace, deps } = ctx;
  args = args || {};
  if (name === "list_products") return toToolResult(await deps.handleCatalog(env));
  if (name === "check_quota") return toToolResult(await deps.handleMe(env, keyRow));
  if (name === "describe_product") {
    if (!args.product_id) return errText("product_id 가 필요합니다.");
    return toToolResult(await deps.handleProductBundle(env, args.product_id, request, trace));
  }
  if (name === "preview_product" || name === "query_product") {
    if (!args.product_id) return errText("product_id 가 필요합니다.");
    const table = await resolveTable(env, args.product_id);
    if (!table) return errText(`없는 제품: ${args.product_id} — list_products 로 확인하세요.`);
    if (name === "preview_product") return toToolResult(await deps.handlePreview(env, table, trace));
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args.filters || {})) params.set(k, String(v));
    if (args.from) params.set("from", String(args.from));
    if (args.to) params.set("to", String(args.to));
    if (args.limit) params.set("limit", String(args.limit));
    if (args.cursor) params.set("cursor", String(args.cursor));
    return toToolResult(await deps.handleData(env, table, params, keyRow, trace));
  }
  return errText(`알 수 없는 tool: ${name}`);
}

// ── 진입점: POST /mcp (stateless JSON-RPC) ──────────────────────────────────
// deps = { authenticate, handleCatalog, handlePreview, handleData, handleMe, handleProductBundle }
export async function handleMcp(request, env, trace, deps) {
  let msg;
  try {
    msg = await request.json();
  } catch {
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
    if (error)
      return rpcResult(
        id,
        errText("키가 없거나 유효하지 않습니다 — Authorization: Bearer ask_... 필요(POST /api/keys 발급)."),
      );
    trace.keyHash = keyRow.key_hash;
    const result = await callTool(params && params.name, params && params.arguments, {
      env,
      request,
      keyRow,
      trace,
      deps,
    });
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
