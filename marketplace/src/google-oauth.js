// Google OAuth 위임 (#110 ② · #20 외부 공개 결정의 하류)
//
// 목적은 로그인이 아니라 **이메일 소유 확인**이다. 발급 폼이 받던 주소는 아무나 적을 수
// 있었고(#110), 그걸 우리가 확인 메일로 재는 대신 **Google 이 이미 확인한 값을 받아 온다**.
// 그래서 이 파일이 최종적으로 만들어 내는 값은 **`email` 하나**다.
//
// 🔑 왜 확인 메일(#110 ①)이 아니라 이쪽인가
//   - 메일 발송 수단이 필요 없다 → 이 워커의 외부 의존이 0 인 채로 남는다
//   - 키 상태가 `active`/`revoked` **2값을 유지**한다. 확인 메일은 `pending` 이 필요해
//     CLAUDE.md §6 게이트(콘솔 decision/0006 공동 개정)에 걸린다. 신원 확인이 발급보다
//     **앞에** 오기 때문에 중간 상태가 생기지 않는다.
//
// 스코프는 `openid email` 뿐이다 — 이름·사진은 쓸 데가 없고, 안 받으면 저장할 고민도 없다.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
export const STATE_COOKIE = "ask_oauth_state";
const STATE_TTL_SEC = 600;   // 로그인 왕복에 10분이면 넉넉하다. 길면 재생 공격 창이 넓어진다

// base64url — atob/btoa 는 표준 base64 라 JWT 의 `-`·`_` 를 못 읽는다
const b64urlDecode = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
};
const b64urlEncode = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── CSRF state ───────────────────────────────────────────────────────────────
// D1 에 표를 만들지 않는다. 값 자체에 만료와 서명을 실어 **쿠키 하나로 끝낸다** — 상태를
// 서버에 두면 청소 주기·경합을 같이 안게 되고, 이 용도엔 과하다.
//
// 서명 키는 ISSUANCE_SALT 를 재사용한다. 이미 배포 환경마다 설정돼 있고(없으면 발급이
// 503 으로 닫힌다), 용도가 "이 서버만 아는 값"으로 같다. 키를 하나 더 늘리면 배포 때
// 잊어버릴 자리가 하나 더 생긴다.
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

export async function makeState(secret, nowSec) {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${nonce}.${nowSec}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

// 돌아온 state 가 (a) 우리가 만든 것이고 (b) 아직 안 늙었는지. 둘 다여야 통과한다.
export async function verifyState(secret, state, nowSec) {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return false;
  const [nonce, issued, sig] = parts;
  const ts = Number(issued);
  if (!Number.isFinite(ts) || nowSec - ts > STATE_TTL_SEC || ts - nowSec > 60) return false;
  const expected = await hmac(secret, `${nonce}.${issued}`);
  // 길이가 다르면 비교 자체가 의미 없다. 같으면 상수 시간으로 훑는다.
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ── ID 토큰 ──────────────────────────────────────────────────────────────────
// 🔑 **서명을 검증하지 않는다.** 이 토큰은 우리가 client_secret 을 내고 **토큰 엔드포인트에서
// TLS 로 직접** 받은 것이라, 중간에 낀 사람이 없다 — OIDC Core §3.1.3.7 과 Google 문서가
// 이 경로에서는 서명 검증을 요구하지 않는다. 그래서 JWKS 를 받아 캐시하고 회전에 대응하는
// 층 전체가 필요 없다.
//
// ⚠️ **이 전제는 좁다.** 이 함수에 클라이언트가 보낸 토큰(예: 프런트가 실어 보낸 것)을
// 먹이면 안 된다 — 그때는 서명 검증이 반드시 필요하다. 그래서 인자 이름을 못 박아 둔다.
export function readIdTokenFromTokenEndpoint(idToken, { clientId, nowSec }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return { error: "malformed id_token" };
  let claims;
  try {
    claims = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return { error: "malformed id_token" };
  }
  if (!ISSUERS.has(claims.iss)) return { error: "unexpected issuer" };
  // aud 가 우리 것이 아니면 남의 앱에서 받아 온 토큰이다
  if (claims.aud !== clientId) return { error: "audience mismatch" };
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSec) return { error: "expired id_token" };
  // 🔴 이 두 줄이 이 이슈의 전부다 — 확인되지 않은 주소는 발급 폼과 다를 바 없다
  if (!claims.email) return { error: "no email in id_token" };
  if (claims.email_verified !== true) return { error: "email not verified" };
  return { email: String(claims.email).trim().toLowerCase() };
}

// ── 흐름 ─────────────────────────────────────────────────────────────────────
export const isConfigured = (env) =>
  Boolean(String(env.GOOGLE_CLIENT_ID || "").trim() && String(env.GOOGLE_CLIENT_SECRET || "").trim());

export const redirectUri = (url) => new URL("/api/v1/auth/google/callback", url.origin).toString();

export function authorizeUrl({ clientId, redirect, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email",
    state,
    // 매번 계정을 고르게 한다 — 공용 PC 에서 앞사람 계정으로 조용히 발급되는 것을 막는다
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${q}`;
}

export async function exchangeCode({ code, clientId, clientSecret, redirect }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirect, grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return { error: `token exchange failed (${res.status})` };
  const body = await res.json().catch(() => null);
  if (!body || !body.id_token) return { error: "no id_token in token response" };
  return { idToken: body.id_token };
}

// state 쿠키 — HttpOnly(JS 가 못 읽는다) · SameSite=Lax(외부 사이트발 POST 로는 안 실린다,
// 다만 Google 에서 돌아오는 top-level GET 에는 실린다) · Secure 는 https 일 때만.
// 로컬 http://localhost 에 Secure 를 붙이면 쿠키가 아예 저장되지 않아 흐름이 끊긴다.
export const stateCookie = (value, url, maxAge = STATE_TTL_SEC) =>
  `${STATE_COOKIE}=${value}; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
  (url.protocol === "https:" ? "; Secure" : "");

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
