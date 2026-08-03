// marketplace — 라우터 + `/api/*` 프로토타입 (ASK-Seoul#58, 로컬 전용)
// 게이트 순서: 키 검증 → 버스트 → 쿼터 → _catalog 게이트 → 조회 (#476 게이트웨이 실물 검증)
//
// 경로가 셋으로 갈린다(ASAC-DAG#642) — `/api/*`(이 파일, 프로토타입) ·
// `/v1/*`(src/v1.js, 마켓플레이스 공용) · `/skill/v1/*`(K-Skill 전용, 별도 담당).
// 공유 층은 src/shared.js 한 곳이다: 키 발급·검증 · 쿼터·버스트 · 오류 형식 · 요청 로깅.
import {
  json, problem, quotaHeaders, sha256hex, kstDay, PUBLIC,
  authenticate, checkBurst, burstProblem, countUsage, classifyClient,
} from "./shared.js";
import { handleProductBundle, handleGlossary } from "./v1.js";

const ISSUE_HOURLY_CAP = 5;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

const newKey = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "ask_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ── 페이지네이션: offset 이 아니라 rowid 키셋 커서 ──────────────────────────────
// offset 을 안 쓰는 이유는 성능이 아니라 **정확성**이다. 제품은 매일 스냅샷으로 통째 재적재되고
// (그리고 append 제품은 계속 늘고), 그 사이 offset 은 같은 행을 두 번 주거나 건너뛴다.
// rowid 는 한 발행 안에서 유일·단조라 "여기서부터 이어서"가 정확하다.
//
// 대신 rowid 는 재적재마다 새로 매겨진다. 그래서 커서에 발행 시각(exported_at)을 함께 실어
// 다른 발행의 커서를 조용히 이어받지 않게 막는다 — 유실을 모르는 것보다 409 가 낫다.
const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeCursor = (stamp, rid) => b64url(`${rid}@${stamp}`);
function decodeCursor(raw) {
  let text;
  try { text = atob(raw.replace(/-/g, "+").replace(/_/g, "/")); } catch { return null; }
  const at = text.indexOf("@");
  if (at < 1) return null;
  const rid = Number(text.slice(0, at));
  if (!Number.isSafeInteger(rid) || rid < 0) return null;
  return { rid, stamp: text.slice(at + 1) };
}

async function issueKey(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid body", "JSON body { email } 이 필요하다");
  }
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return problem(400, "invalid email", "올바른 이메일 형식이 아니다");

  // 발급 rate limit 의 IP 축은 원문을 저장하지 않는다(#9 §7-①·⑥) — 일 회전 솔트 해시.
  // 같은 날 안에서만 같은 값이라 시간당 카운트는 성립하고, 날이 바뀌면 대응이 끊겨
  // 장기 추적 축이 되지 못한다. 자정 경계에서 카운터가 리셋돼 상한 2배까지 통과
  // 가능하지만 시간당 5회 상한이라 실해가 없다. 컬럼명 ip 는 유지 — 이름 변경은
  // 증분 규약 위반이고 바뀌는 건 내용물뿐이다.
  //
  // 솔트가 없으면 해시가 아니라 인코딩이다 — IPv4 는 43억 조합이라 전수 대입으로 원문이
  // 복원된다. 그래서 미설정이면 **발급만** 닫는다(조회 경로는 영향 없음). 기본값을 안전한
  // 쪽에 두는 게 목적이라, 배포 때 시크릿을 잊으면 열린 채 도는 게 아니라 막힌 채 돈다.
  // 콘솔의 'ops write disabled' 503 과 같은 방식.
  const salt = String(env.ISSUANCE_SALT || "").trim();
  if (!salt)
    return problem(503, "issuance disabled",
      "ISSUANCE_SALT 미설정 — 발급 기록의 IP 해시에 솔트가 없으면 원문 IP 를 복원할 수 있어 발급을 막는다. " +
      "로컬은 marketplace/.dev.vars 에, 배포 환경은 `wrangler secret put ISSUANCE_SALT` 로 설정할 것");
  const rawIp = request.headers.get("cf-connecting-ip") || "local";
  const ip = await sha256hex(`${kstDay()}|${salt}|${rawIp}`);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { results: recent } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM _issuance_log WHERE ip = ? AND created_at > ?"
  ).bind(ip, hourAgo).all();
  if (recent[0].n >= ISSUE_HOURLY_CAP)
    return problem(429, "issuance rate limited", `발급은 IP당 시간당 ${ISSUE_HOURLY_CAP}회까지다`);

  const key = newKey();
  const hash = await sha256hex(key);
  const prefix = key.slice(0, 8);
  const now = new Date().toISOString();

  // 이메일당 1키: 기존 키가 있으면 rotate — 해시 교체 + 오늘 사용량 승계(rotate 로 쿼터 리셋 방지)
  const existing = await env.DB.prepare("SELECT key_hash, key_prefix FROM _keys WHERE email = ?")
    .bind(email).first();

  // rotate 는 기존 키를 즉시 무효화하는 파괴적 동작 — confirm_rotate 없이는 실행하지 않는다
  if (existing && body.confirm_rotate !== true)
    return problem(409, "rotate confirmation required",
      `'${email}' 에는 이미 키(${existing.key_prefix}…)가 있다 — 재발급하면 기존 키가 즉시 만료된다. ` +
      "계속하려면 body 에 confirm_rotate: true 를 추가할 것",
      { email, key_prefix: existing.key_prefix });

  const statements = [];
  let rotated = false;
  if (existing) {
    rotated = true;
    statements.push(
      env.DB.prepare("UPDATE _usage SET key_hash = ? WHERE key_hash = ?").bind(hash, existing.key_hash),
      env.DB.prepare(
        "UPDATE _keys SET key_hash = ?, key_prefix = ?, status = 'active', created_at = ? WHERE email = ?"
      ).bind(hash, prefix, now, email)
    );
  } else {
    statements.push(
      env.DB.prepare(
        "INSERT INTO _keys (key_hash, key_prefix, email, created_at) VALUES (?, ?, ?, ?)"
      ).bind(hash, prefix, email, now)
    );
  }
  statements.push(
    env.DB.prepare("INSERT INTO _issuance_log (ip, created_at) VALUES (?, ?)").bind(ip, now),
    // rate limit 창은 1시간 — 하루 지난 행은 유지할 이유가 없다(24h sweep, #9 §7-⑥)
    env.DB.prepare("DELETE FROM _issuance_log WHERE created_at < ?")
      .bind(new Date(Date.now() - 86400000).toISOString())
  );
  await env.DB.batch(statements);

  return json({ key, key_prefix: prefix, rotated, note: "이 키는 지금 한 번만 표시된다 — 저장해 둘 것" }, 201);
}

// 폐기 — 키를 즉시 무효화한다. purge=true 면 이메일·사용량까지 지운다(처리방침의 삭제 요청
// 셀프 경로). 요청 로그의 key_hash 는 남지만, 해시→이메일 대응이 사라지므로 사람과 연결되지
// 않는다. 30일 뒤 자동 삭제되는 건 그대로다.
async function revokeKey(env, keyRow, purge) {
  if (purge) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM _usage WHERE key_hash = ?").bind(keyRow.key_hash),
      env.DB.prepare("DELETE FROM _burst WHERE bucket = ?").bind("k:" + keyRow.key_hash),
      env.DB.prepare("DELETE FROM _keys WHERE key_hash = ?").bind(keyRow.key_hash),
    ]);
    return json({
      key_prefix: keyRow.key_prefix, purged: true,
      note: "키와 이메일·사용량 기록을 삭제했다. 요청 로그(30일 보존)는 키 해시만 남아 사람과 연결되지 않는다",
    });
  }
  await env.DB.prepare("UPDATE _keys SET status = 'revoked' WHERE key_hash = ?")
    .bind(keyRow.key_hash).run();
  return json({
    key_prefix: keyRow.key_prefix, revoked: true,
    note: "이 키는 즉시 무효다. 같은 이메일로 다시 발급하면 새 키를 받는다",
  });
}


// 도메인 간 공통 조인축(#48) — 서로 다른 제품의 같은 컬럼끼리 그대로 조인된다.
// UI(catalog.html) 의 JOIN 배지와 같은 목록인데, 화면에만 있으면 API 소비자(특히 AI 에이전트)는
// 크로스도메인 분석의 열쇠를 모른 채 추측해야 한다 — 그래서 응답 메타로도 내보낸다.
const JOIN_AXES = ["admin_dong_code", "gu_code", "stat_region_cd"];

async function handleCatalog(env) {
  const { results } = await env.DB.prepare(
    "SELECT name, product_id, external, description, product_question, time_axis, columns, " +
    "row_count, freshness, exported_at " +
    `FROM _catalog WHERE ${PUBLIC} ORDER BY name`
  ).all();
  // description 을 반드시 실어야 한다 — 제품의 주의사항("기상청 공식 특보가 아님" 등)이
  // 여기에 있고, 화면을 안 거치는 소비자에게는 이 응답이 그걸 전달할 유일한 경로다.
  return json({
    // 출처·이용조건은 응답에서도 닿아야 한다 — 화면을 거치지 않고 API 만 쓰는 소비자가 있다
    attribution: "공공 원천의 2차 가공물 — 출처·이용조건 /legal#attribution",
    docs: "/llms.txt",
    openapi: "/openapi.json",
    column_docs: "/column-docs.json",
    join_axes: JOIN_AXES,
    products: results.map((r) => {
      const columns = JSON.parse(r.columns);
      return {
        ...r, columns,
        join_keys: columns.map((c) => c.name).filter((n) => JOIN_AXES.includes(n)),
      };
    }),
  });
}

// 무인증 샘플 미리보기 — 고정 5행, 필터 없음, 쿼터 무과금 ("물건을 먼저 보여준다")
const PREVIEW_ROWS = 5;
async function handlePreview(env, table, trace = {}) {
  trace.table = table;
  if (!/^[a-z0-9_]+$/.test(table))
    return problem(400, "invalid table", "테이블 이름 형식이 아니다");
  // 비공개 제품은 404 로 답한다 — 403 이면 "있긴 있다"를 알려주는 셈이다
  const meta = await env.DB.prepare(`SELECT name, time_axis FROM _catalog WHERE name = ? AND ${PUBLIC}`)
    .bind(table).first();
  if (!meta) return problem(404, "unknown table", `'${table}' 은 서빙 카탈로그에 없다 — GET /api/catalog 참조`);
  // 시간축이 있으면 최신 구간을 보여준다 — 미리보기의 존재 이유는 "실물이 쓸만한가"의 판단
  const order = meta.time_axis ? ` ORDER BY "${meta.time_axis}" DESC` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM "${table}"${order} LIMIT ${PREVIEW_ROWS}`
  ).all();
  trace.rows = results.length;
  return json({ table, preview: true, row_count: results.length, rows: results });
}

async function handleData(env, table, params, keyRow, trace = {}) {
  trace.table = table;
  if (!/^[a-z0-9_]+$/.test(table))
    return problem(400, "invalid table", "테이블 이름 형식이 아니다");
  const meta = await env.DB.prepare(`SELECT * FROM _catalog WHERE name = ? AND ${PUBLIC}`)
    .bind(table).first();
  if (!meta) return problem(404, "unknown table", `'${table}' 은 서빙 카탈로그에 없다 — GET /api/catalog 참조`);

  const columns = JSON.parse(meta.columns);
  const colSet = new Set(columns.map((c) => c.name));
  const where = [];
  const binds = [];
  for (const [k, v] of params.entries()) {
    if (k === "limit" || k === "from" || k === "to" || k === "cursor") continue;
    if (!colSet.has(k))
      return problem(400, "unknown filter", `'${k}' 컬럼 없음 — 사용 가능: ${[...colSet].join(", ")}`);
    where.push(`"${k}" = ?`);
    binds.push(v);
    // 필터는 컬럼명만 기록한다 — 어떤 축으로 자르는지가 알고 싶은 것이고, 값은 남길 이유가 없다
    trace.filterCols = (trace.filterCols || []).concat(k);
  }
  if (params.get("from") || params.get("to")) {
    if (!meta.time_axis)
      return problem(400, "no time axis", `'${table}' 은 시간축이 없어 from/to 를 지원하지 않는다`);
    if (params.get("from")) { where.push(`"${meta.time_axis}" >= ?`); binds.push(params.get("from")); }
    if (params.get("to")) { where.push(`"${meta.time_axis}" <= ?`); binds.push(params.get("to")); }
  }
  const limit = Math.min(parseInt(params.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const raw = params.get("cursor");
  if (raw) {
    const cur = decodeCursor(raw);
    if (!cur) return problem(400, "invalid cursor", "cursor 는 이전 응답의 next_cursor 값을 그대로 넣어야 한다");
    // 커서를 발급한 발행이 아니면 rowid 의 의미가 다르다 — 이어받으면 조용히 유실된다
    if (cur.stamp !== String(meta.exported_at))
      return problem(409, "cursor expired",
        `'${table}' 이 그 사이 재발행됐다 — 커서를 버리고 첫 페이지부터 다시 받을 것`,
        { exported_at: meta.exported_at });
    where.push("rowid > ?");
    binds.push(cur.rid);
  }

  // 쿼터는 유효한 요청(실제 서빙 직전)만 소모 — 400/404/409 는 무과금
  const usage = await countUsage(env, keyRow);
  if (usage.exceeded)
    return problem(429, "daily quota exceeded", `일일 쿼터 ${usage.quota}건 소진 — KST 자정에 리셋`);

  // limit+1 을 떠서 다음 페이지 유무를 **실측**한다 — 마지막 페이지가 꽉 찼을 때
  // has_more 를 참으로 두면 소비자가 빈 페이지를 한 번 더 받는다.
  // rowid 정렬은 커서의 전제이자, 페이지를 안 쓰는 소비자에게도 순서를 결정적으로 만든다.
  const sql = `SELECT rowid AS _rid, * FROM "${table}"` +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    ` ORDER BY rowid LIMIT ${limit + 1}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const lastRid = page.length ? page[page.length - 1]._rid : null;
  const rows = page.map(({ _rid, ...rest }) => rest);   // rowid 는 내부 값 — 계약 스키마에 없다

  trace.rows = rows.length;
  return json({
    table,
    row_count: rows.length,
    limit,
    time_axis: meta.time_axis,
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(meta.exported_at, lastRid) : null,
    usage: { used: usage.used, daily_quota: usage.quota },
    rows,
  }, 200, quotaHeaders(usage.used, usage.quota));
}

async function handleMe(env, keyRow) {
  const day = kstDay();
  const row = await env.DB.prepare(
    "SELECT count FROM _usage WHERE key_hash = ? AND day = ?"
  ).bind(keyRow.key_hash, day).first();
  const used = row ? row.count : 0;
  return json({
    key_prefix: keyRow.key_prefix,
    email: keyRow.email,
    day,
    used_today: used,
    daily_quota: keyRow.daily_quota,
  }, 200, quotaHeaders(used, keyRow.daily_quota));
}

// 요청 로그 — 무엇이 실제로 쓰이는지 재는 유일한 근거. 실패해도 서빙을 깨뜨리지 않는다.
const LOG_RETENTION_DAYS = 30;
const LOG_SWEEP_RATE = 0.02;  // 크론 없이, 로그 100건당 ~2회 낡은 행 청소

async function logRequest(env, trace) {
  try {
    await env.DB.prepare(
      "INSERT INTO _request_log (ts, route, table_name, status, key_hash, filters, row_count, ms, request_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      new Date().toISOString(), trace.route, trace.table ?? null, trace.status,
      trace.keyHash ?? null, trace.filterCols ? trace.filterCols.join(",") : null,
      trace.rows ?? null, trace.ms, trace.requestId ?? null
    ).run();
    if (Math.random() < LOG_SWEEP_RATE) {
      const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
      await env.DB.prepare("DELETE FROM _request_log WHERE ts < ?").bind(cutoff).run();
      // 익명 IP 버킷은 주소 수만큼 생긴다 — 창이 지난 행은 남겨 둘 이유가 없다
      const stale = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 16);
      await env.DB.prepare("DELETE FROM _burst WHERE window_start < ?").bind(stale).run();
    }
  } catch {
    // 관측 실패가 응답에 영향을 주면 안 된다 — 조용히 버린다
  }
}

async function route(request, env, url, trace) {
  const path = url.pathname;

  if (path === "/api/keys" && request.method === "POST") {
    trace.route = "keys";
    return issueKey(env, request);
  }
  if (path === "/api/keys" && request.method === "DELETE") {
    trace.route = "revoke";
    const { keyRow, error } = await authenticate(env, request, { allowRevoked: true });
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    return revokeKey(env, keyRow, url.searchParams.get("purge") === "true");
  }
  if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용 API (폐기는 DELETE /api/keys)");
  if (path === "/api/catalog") { trace.route = "catalog"; return handleCatalog(env); }

  const previewMatch = path.match(/^\/api\/preview\/([^/]+)$/);
  if (previewMatch) {
    trace.route = "preview";
    // 익명 경로라 셀 식별자가 IP 밖에 없다 — 키 버킷과 같은 상한을 쓴다
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const burst = await checkBurst(env, "ip:" + ip);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    return handlePreview(env, decodeURIComponent(previewMatch[1]), trace);
  }

  const dataMatch = path.match(/^\/api\/data\/([^/]+)$/);
  if (dataMatch || path === "/api/me") {
    trace.route = dataMatch ? "data" : "me";
    const { keyRow, error } = await authenticate(env, request);
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    // 버스트는 쿼터보다 **앞**에서 본다 — 400·404 로 끝날 요청도 서버를 미는 건 같다
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    if (path === "/api/me") return handleMe(env, keyRow);
    return handleData(env, decodeURIComponent(dataMatch[1]), url.searchParams, keyRow, trace);
  }

  // ── /v1 — 마켓플레이스 공용 API (ASAC-DAG#642) ────────────────────────────────
  // #638 결정대로 **전 경로 인증**이다. `/api/*` 의 무인증 미리보기는 프로토타입의
  // 제품 결정이라 유지하되, 신규 계약에서는 예외를 만들지 않는다.
  // 메타 조회는 버스트만 적용하고 일일 쿼터를 소모하지 않는다 — 데이터가 아니라 판단
  // 재료이고, 소비 순서상 데이터 호출 앞에 반드시 오는 단계라 여기서 깎으면 쓸 몫이 준다.
  if (path.startsWith("/v1/")) {
    const productMatch = path.match(/^\/v1\/products\/([^/]+)$/);
    if (!productMatch && path !== "/v1/glossary")
      return problem(404, "not found",
        "GET /v1/products/<product_id> · /v1/glossary?vocabulary_id=<id>");

    trace.route = productMatch ? "v1_product" : "v1_glossary";
    const { keyRow, error } = await authenticate(env, request);
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);

    return productMatch
      ? handleProductBundle(env, decodeURIComponent(productMatch[1]), request, trace)
      : handleGlossary(env, url.searchParams.get("vocabulary_id"), trace);
  }

  return problem(404, "not found",
    "GET /api/catalog · /api/preview/<table> · /api/data/<table> · /api/me, POST·DELETE /api/keys · " +
    "GET /v1/products/<product_id> · /v1/glossary — 문법·한도 안내는 GET /llms.txt (사람용 문서 /docs)");
}

// 요청 ID — 문의가 들어왔을 때 그 요청 하나를 로그에서 집어내는 열쇠다.
// 이게 없으면 지원 대화가 "언제쯤 어떤 걸 부르셨나요"로 시작한다.
const newRequestId = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "req_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        },
      });

    const started = Date.now();
    const trace = { route: null, requestId: newRequestId() };
    let res = await route(request, env, url, trace);

    // 오류는 본문에도 요청 ID 를 넣는다 — 사람이 복사해 오는 건 헤더가 아니라 JSON 이다
    if (res.status >= 400 && (res.headers.get("content-type") || "").includes("problem+json")) {
      const body = await res.json();
      res = new Response(JSON.stringify({ ...body, request_id: trace.requestId }),
        { status: res.status, headers: res.headers });
    }
    res = new Response(res.body, res);
    res.headers.set("x-request-id", trace.requestId);

    // 라우트가 정해진 API 요청만 기록한다 (정적 자산·404 잡음 제외)
    if (trace.route) {
      trace.status = res.status;
      trace.ms = Date.now() - started;
      const write = logRequest(env, trace);
      if (ctx && ctx.waitUntil) ctx.waitUntil(write);  // 응답을 붙잡지 않는다
    }
    return res;
  },
};
