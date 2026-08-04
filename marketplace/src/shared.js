// marketplace 공유 층 — 경로가 갈려도 여기는 한 벌이다.
//
// `/api/*`(프로토타입) · `/v1/*`(마켓플레이스 공용) · `/skill/v1/*`(K-Skill 전용)이
// 각자 다른 응답 계약을 갖되, **키 발급·검증 · 쿼터·버스트 · 오류 형식 · 요청 로깅**은
// 공유한다(ASAC-DAG#642 경로 분리 합의). 발급 창구가 둘이면 키가 두 벌이 되고,
// 쿼터를 각자 세면 상한이 곱해진다 — #476 을 연 논거가 그것이다.
// 파일을 나눈 이유도 같다: 협업자가 생겨 한 파일을 동시에 고치면 충돌이 잦다.

export const BURST_PER_MIN = 60;

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });

export const problem = (status, title, detail, extras = {}, headers = {}) =>
  new Response(JSON.stringify({ type: "about:blank", title, status, detail, ...extras }), {
    status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });

// 남은 한도를 응답 헤더로 알린다 — 본문을 파싱해야만 알 수 있으면 클라이언트는 한도를
// 못 지킨다(429 를 맞고 나서야 안다). 헤더면 미들웨어·SDK 층에서 자동으로 감속할 수 있다.
// 이름은 사실상 표준인 X-RateLimit-* 을 따른다. Reset 은 KST 자정의 epoch 초.
export function quotaHeaders(used, quota) {
  const kstMidnight = new Date(Date.now() + 9 * 3600 * 1000);
  kstMidnight.setUTCHours(24, 0, 0, 0);
  return {
    "x-ratelimit-limit": String(quota),
    "x-ratelimit-remaining": String(Math.max(0, quota - used)),
    "x-ratelimit-reset": String(Math.floor((kstMidnight.getTime() - 9 * 3600 * 1000) / 1000)),
  };
}

// 쿼터 소진 429 — **헤더를 붙이는 논거가 가장 강한 응답이 여기다.** 위 주석이
// "429 를 맞고 나서야 안다"를 문제로 들었는데, 정작 그 429 에 기계가 읽을 값이 하나도
// 없으면 클라이언트는 언제 다시 걸어야 하는지를 한국어 문장에서 읽어내야 한다.
// `Retry-After` 는 KST 자정까지 남은 초 — `x-ratelimit-reset` 과 같은 순간을 가리킨다.
export function quotaExceededProblem(used, quota) {
  const headers = quotaHeaders(used, quota);
  const retryAfter = Math.max(1, Number(headers["x-ratelimit-reset"]) - Math.floor(Date.now() / 1000));
  return problem(429, "daily quota exceeded",
    `일일 쿼터 ${quota}건 소진 — KST 자정에 리셋`,
    { retry_after: retryAfter },
    { ...headers, "retry-after": String(retryAfter) });
}

export const sha256hex = async (text) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// 쿼터의 하루 경계는 KST — 파이프라인 시간축과 동일 규약
export const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 공개 게이트 — `external = 1` 로 **명시 선언된** 제품만 외부에 나간다.
// `_catalog` 등록과 외부 공개는 다른 결정이다. NULL(미선언)은 공개하지 않는다.
export const PUBLIC = "external = 1";

// allowRevoked: 폐기 경로 전용. 이미 폐기한 키로도 자기 정보를 지울 수 있어야 한다 —
// 폐기가 삭제 요청의 문을 닫아버리면 "지울 권리"가 폐기 순서에 걸려 사라진다.
export async function authenticate(env, request, { allowRevoked = false } = {}) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(ask_[0-9a-f]{32})$/i);
  if (!m) return { error: problem(401, "missing api key", "Authorization: Bearer ask_… 헤더가 필요하다 — POST /api/v1/keys 로 발급") };
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    "SELECT key_hash, key_prefix, email, status, daily_quota FROM _keys WHERE key_hash = ?"
  ).bind(hash).first();
  if (!row) return { error: problem(401, "unknown api key", "등록되지 않은 키다") };
  if (row.status !== "active" && !allowRevoked)
    return { error: problem(403, "revoked api key", "폐기된 키다") };
  return { keyRow: row };
}

// 분 단위 고정 창 — 슬라이딩 창이면 요청마다 타임스탬프 로그가 필요하고, 그건 이 규모에
// 과하다. 대신 창 경계에서 최대 2배까지 통과할 수 있다는 걸 알고 쓴다(가용성 보호가 목적이라
// 그 정도 오차는 견딘다). UPSERT 한 방으로 "창이 같으면 +1, 바뀌었으면 1로 리셋"을 처리한다.
export async function checkBurst(env, bucket) {
  const now = new Date();
  const window = now.toISOString().slice(0, 16);          // 'YYYY-MM-DDTHH:MM' (UTC 분)
  await env.DB.prepare(
    "INSERT INTO _burst (bucket, window_start, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(bucket) DO UPDATE SET " +
    "count = CASE WHEN _burst.window_start = excluded.window_start THEN _burst.count + 1 ELSE 1 END, " +
    "window_start = excluded.window_start"
  ).bind(bucket, window).run();
  const row = await env.DB.prepare("SELECT count FROM _burst WHERE bucket = ?").bind(bucket).first();
  const used = row ? row.count : 1;
  return { exceeded: used > BURST_PER_MIN, retryAfter: 60 - now.getUTCSeconds() };
}

// 초과 시 응답 — Retry-After 를 함께 준다. "언제 다시 오라"를 안 알려주면 클라이언트가
// 곧바로 재시도해서 상황을 더 나쁘게 만든다.
export const burstProblem = (retryAfter) =>
  problem(429, "burst rate limited",
    `분당 ${BURST_PER_MIN}건을 넘었다 — ${retryAfter}초 뒤 다시 시도할 것`,
    { retry_after: retryAfter }, { "retry-after": String(retryAfter) });

export async function countUsage(env, keyRow) {
  const day = kstDay();
  await env.DB.prepare(
    "INSERT INTO _usage (key_hash, day, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(key_hash, day) DO UPDATE SET count = count + 1"
  ).bind(keyRow.key_hash, day).run();
  const row = await env.DB.prepare(
    "SELECT count FROM _usage WHERE key_hash = ? AND day = ?"
  ).bind(keyRow.key_hash, day).first();
  return { used: row.count, quota: keyRow.daily_quota, exceeded: row.count > keyRow.daily_quota };
}

// 표가 아직 없어도 응답을 죽이지 않는다 — 그 조각만 비우고 부른 쪽이 "없음"을 표시한다.
// 서빙 메타 4종(#638)은 파이프라인이 게시하는데 도메인별 진도가 달라서(culture 는 미게시),
// 없는 걸 500 으로 돌려주면 멀쩡한 제품이 통째로 막힌다. 콘솔의 safeRows 와 같은 방식.
export async function safeRows(stmt) {
  try {
    const { results } = await stmt.all();
    return results;
  } catch {
    return null;   // null = 표가 없거나 못 읽었다. 빈 배열(= 표는 있고 행이 0)과 구분한다.
  }
}

// 패턴 실행 결과의 컬럼 출처 판정용 — 제품이 가진 컬럼 이름 집합(#642 답변 ①).
// 패턴 SQL 이 `count(*) AS n` 같은 집계·별칭을 내면 그 이름은 d1_catalog_columns 에 없어
// 소비자가 뜻을 찾을 곳이 없다. 그래서 실행 응답에 컬럼별 출처를 표시한다.
// 메타가 아직 게시 안 된 제품은 **null 을 돌려준다** — 전부 derived 로 찍으면 거짓말이 되고,
// 모른다를 0 으로 만들지 않는다는 원칙(#78 F-3)과도 어긋난다.
export async function productColumnNames(env, productId) {
  const rows = await safeRows(
    env.DB.prepare("SELECT column_name FROM d1_catalog_columns WHERE product_id = ?").bind(productId)
  );
  if (!rows || rows.length === 0) return null;
  return new Set(rows.map((r) => r.column_name));
}

// 결과 컬럼에 출처를 붙인다. known 이 null 이면 판정 자체를 하지 않는다(위 참조).
export function markColumnSource(columnNames, known) {
  if (!known) return null;
  return columnNames.map((name) => ({ name, source: known.has(name) ? "product" : "derived" }));
}

// ── AI 클라이언트 분류 (#9 §3) — 원문 UA 는 저장하지 않고 분류 결과만 남긴다 ─────────
// 목록은 코드 상수로 관리한다(#9 §7-③ 결정: 갱신 주체 = marketplace 담당, 방식 = PR).
// 매칭 실패는 unknown — 지어내지 않는다. MCP·에이전트 툴 호출은 python-httpx 같은
// 평범한 얼굴로 오므로(#9 §3) 수집 시점 분류는 절반이고, 나머지는 여정 분석의 몫이다.
const AI_AGENT_PATTERNS = [
  // [패턴, agent_name, agent_mode] — crawler = 사전 수집, on_demand = 사용자 질문 대행.
  // 한 벤더의 -User 패턴을 크롤러 패턴보다 먼저 둔다(부분 문자열 겹침 대비).
  [/ChatGPT-User/i, "openai", "on_demand"],
  [/GPTBot|OAI-SearchBot/i, "openai", "crawler"],
  [/Claude-User/i, "anthropic", "on_demand"],
  [/ClaudeBot|Claude-SearchBot/i, "anthropic", "crawler"],
  [/Perplexity-User/i, "perplexity", "on_demand"],
  [/PerplexityBot/i, "perplexity", "crawler"],
  [/Google-Extended|GoogleOther/i, "google", "crawler"],
  [/Meta-ExternalFetcher/i, "meta", "on_demand"],
  [/Meta-ExternalAgent/i, "meta", "crawler"],
  [/CCBot/i, "commoncrawl", "crawler"],
  [/Bytespider/i, "bytedance", "crawler"],
  [/Amazonbot/i, "amazon", "crawler"],
  [/Applebot-Extended/i, "apple", "crawler"],
];
const CLI_PATTERN = /curl|wget|python-requests|python-httpx|python-urllib|node-fetch|undici|axios|Go-http-client|okhttp|libwww|java\//i;
const GENERIC_BOT_PATTERN = /bot|crawler|spider|slurp|scrapy/i;

// UA 문자열 → {ua_class, agent_name, agent_mode}. request 가 아니라 문자열을 받는
// 순수 함수 — 스키마·D1 없이 단독 테스트가 가능하다(scripts/classify.test.mjs).
// 판정 순서가 곧 규칙이다: AI 목록 → cli → 일반 bot → browser → unknown.
// 일반 bot 을 browser 보다 먼저 보는 이유: 크롤러 UA 대부분이 Mozilla/ 를 포함한다.
export function classifyClient(ua) {
  if (!ua) return { ua_class: "unknown", agent_name: null, agent_mode: null };
  for (const [re, name, mode] of AI_AGENT_PATTERNS)
    if (re.test(ua))
      return { ua_class: mode === "crawler" ? "ai_crawler" : "ai_agent", agent_name: name, agent_mode: mode };
  if (CLI_PATTERN.test(ua)) return { ua_class: "cli", agent_name: null, agent_mode: null };
  if (GENERIC_BOT_PATTERN.test(ua)) return { ua_class: "bot", agent_name: null, agent_mode: null };
  if (/Mozilla\//.test(ua)) return { ua_class: "browser", agent_name: null, agent_mode: null };
  return { ua_class: "unknown", agent_name: null, agent_mode: null };
}

// ── 요청 축 (#9 · agreement §3) ───────────────────────────────────────────────
// 요청 하나에서 뽑는 관측 축을 한 곳에 모은다. **원문은 하나도 남기지 않는다** —
// UA 는 분류 상수로, Referer 는 호스트로, IP 는 아예 안 본다(§3-2: 컬럼 자체를 안 만든다).
// 남용 판정은 원문 IP 대신 country·asn 으로 한다.
//
// `request.cf` 는 Cloudflare 가 Request 에 얹는 확장이다. `wrangler dev` 는 로컬에서도
// 채워 준다(실측 2026-08-04: `country=KR · asn=4766`). 다만 **항상 있다고 가정하지 않는다** —
// Node 의 Request 에는 없고, 그때 NULL 로 남는 게 맞다. "모른다"를 다른 값으로 꾸미면
// 배포 후 실측과 섞인다(§4-3).
export function clientAxes(request) {
  const cf = request.cf || {};
  const { ua_class, agent_name, agent_mode } = classifyClient(request.headers.get("user-agent"));
  return {
    ua_class, agent_name, agent_mode,
    country: cf.country ?? null,
    // asn 은 숫자로 온다 — 컬럼이 TEXT 라 문자열로 맞춰 넣는다(집계 축이지 산술 대상이 아니다).
    asn: cf.asn == null ? null : String(cf.asn),
    referer_host: refererHost(request.headers.get("referer")),
  };
}

// Referer 는 **호스트만** 남긴다 — 전체 URL 에는 경로·쿼리가 붙고, 거기에 남의 사이트의
// 검색어나 식별자가 섞여 들어온다. 알고 싶은 건 "어디서 왔나"이지 "무엇을 보다 왔나"가 아니다.
export function refererHost(raw) {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;   // 깨진 Referer 는 버린다 — 원문을 대신 남기지 않는다
  }
}

// 의도 슬러그(§3-6) — 어휘는 `d1_usage_patterns.pattern_id` 재사용. 모양이 아니면 `other` 로
// 뭉갠다: 자유 문장이 오면 **질문 원문이 로그에 남고**, 같은 행의 key_hash 가 이메일과 1:1 이라
// "이메일에 연결된 질의 이력"이 된다. 그게 이 축을 슬러그로 못 박은 이유다.
const INTENT_RE = /^[a-z0-9_]{1,64}$/;
export function normalizeIntent(raw) {
  const value = (raw ?? "").trim();
  if (!value) return null;                       // 안 보낸 것과 못 알아본 것은 다르다
  return INTENT_RE.test(value) ? value : "other";
}
