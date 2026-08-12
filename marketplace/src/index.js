// marketplace — 라우터 + `/api/*` 프로토타입 (ASK-Seoul#58, 로컬 전용)
// 게이트 순서: 키 검증 → 버스트 → 쿼터 → _catalog 게이트 → 조회 (#476 게이트웨이 실물 검증)
//
// 문이 셋이다(agreement §1-2 — 기술 계층이 아니라 **누가 쓰는가**로 가른다):
// `/api/v1/*`(이 파일, 사람·일반 소비자) · `/skill/v1/*`(K-Skill 전용, 별도 담당) ·
// `/mcp`(MCP 클라이언트, src/mcp.js). 옛 `/v1/*` 표면은 접고 기능은 `/api/v1` 로
// 흡수했다(agreement §10 · decision/0004 D-2) — 제품 번들·용어 사전 두 경로다.
// 공유 층은 src/shared.js 한 곳이다: 키 발급·검증 · 쿼터·버스트 · 오류 형식 · 요청 로깅.
import {
  json, problem, quotaHeaders, quotaExceededProblem, sha256hex, kstDay, PUBLIC, ATTRIBUTION,
  authenticate, checkBurst, burstProblem, countUsage, refundUsage, checkDailyCap, clientAxes, normalizeIntent, safeRows,
  parseJsonArray, loadRedistributionRights, redistributionBlockers, rightsBlockedProblem,
} from "./shared.js";
import { handleProductBundle, handleGlossary } from "./v1.js";
import { denyGate } from "./pattern-audit.js";
import { convertPattern, parseRestArrayParams } from "./run-pattern-ext.js";
import {
  SKILL_BUNDLE_ID,
  SKILL_SERVICE_SCOPE,
  handleSkillBundle,
  handleSkillData,
  handleSkillProduct,
} from "./skill.js";
import { handleMcp } from "./mcp.js";
import { TOOLS } from "./mcp.js";
import {
  runChat, CHAT_MODEL, CHAT_ANON_DAILY_TOTAL, CHAT_ANON_DAILY_PER_IP, CHAT_ANON_PRINCIPAL,
} from "./chat.js";
import { searchProducts } from "./agent-tools.js";
import { loadProductAvailability, productNotReadyResponse } from "./product-availability.js";
import {
  isConfigured, redirectUri, authorizeUrl, exchangeCode, makeState, verifyState,
  readIdTokenFromTokenEndpoint, stateCookie, readCookie, STATE_COOKIE,
  makeRotateTicket, verifyRotateTicket,
} from "./google-oauth.js";

const ISSUE_HOURLY_CAP = 5;
// 계정 기준 재발급 상한(#303). IP 상한만으로는 **공유 IP 에서 남의 몫을 갉아먹는다** —
// 한 사람이 반복 회전하면 같은 사무실·학교의 다른 사람이 발급을 못 한다. 회전 자체로는
// 쿼터 이득이 없지만(당일 사용량 이월), 그건 "이득이 없다"이지 "해가 없다"가 아니다.
const ROTATE_DAILY_CAP = 5;

// 🔴 **상한은 키 행 밖에 산다** (#320). 예전엔 `_keys.rotated_*` 에 얹혀 있었는데
//    완전삭제가 그 행을 지워, **상한이 막으려던 행동으로 상한이 사라졌다**:
//    남용 → 완전삭제 → 재로그인 → 신규 발급 → 반복. 그래서 이메일 해시를 키로 하는
//    `_issuance_guard` 로 옮긴다 — 완전삭제는 이 표를 건드리지 않는다.
// 보존 30일: 남용 대응에 필요한 만큼만 둔다(요청 로그와 같은 창). 처리방침 제3조에 명시.
const GUARD_RETENTION_DAYS = 30;
const guardHash = (secret, email) => sha256hex(`guard|${secret}|${String(email).trim().toLowerCase()}`);

// 오늘 몇 번 썼나. 가드 행이 없으면 `_keys` 의 옛 컬럼에서 읽는다 — 0008 적용 **전에**
// 회전한 계정의 오늘치가 그쪽에만 있기 때문이다. 하루가 지나면 어차피 0이라 이 seed 는
// 저절로 쓸모를 잃는다(그때 지워도 되는 코드다).
const usedTodayFrom = (guard, legacyRow) => {
  const day = kstDay();
  if (guard) return guard.day === day ? Number(guard.count) || 0 : 0;
  if (legacyRow && legacyRow.rotated_day === day) return Number(legacyRow.rotated_count) || 0;
  return 0;
};

const readGuard = (env, hash) =>
  env.DB.prepare("SELECT day, count FROM _issuance_guard WHERE email_hash = ?").bind(hash).first();

// 카운터를 `count` 로 맞춘다. **키 발급과 같은 batch 로 나가야** 키만 나가고 카운터는
// 안 오르는 창이 안 생긴다. 청소도 여기 붙인다 — 별도 스케줄러는 안 도는 걸 아무도 모른다.
// ⚠️ 첫 발급은 재발급이 아니므로 `count = 0` 으로 **자리만** 만든다. 1 로 시작하면
//    "재발급 하루 5회"라 해 놓고 처음 받은 사람이 4번만 쓰게 된다.
const writeGuard = (env, hash, count) => [
  env.DB.prepare(
    "INSERT INTO _issuance_guard (email_hash, day, count, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(email_hash) DO UPDATE SET day = excluded.day, count = excluded.count, updated_at = excluded.updated_at")
    .bind(hash, kstDay(), count, new Date().toISOString()),
  env.DB.prepare("DELETE FROM _issuance_guard WHERE updated_at < ?")
    .bind(new Date(Date.now() - GUARD_RETENTION_DAYS * 86400000).toISOString()),
];
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

// 이메일 발급(POST /api/v1/keys)은 폐지했다(2026-08-07) — 주소 소유가 확인되지 않은 채로
// 키를 내주지 않기 위해서다(#110 ②). 발급 배선은 아래 OAuth 절 하나뿐이고,
// `_issuance_log`·`ISSUE_HOURLY_CAP`·IP 해시는 **그쪽이 계속 쓴다**(지우면 안 된다).

// ── Google OAuth 발급 경로 (#110 ②) ─────────────────────────────────────────
// 순수 로직(state 서명·ID 토큰 판정)은 src/google-oauth.js 에 있고 단독 테스트가 붙어 있다.
// 여기 있는 건 그걸 D1·응답에 잇는 배선뿐이다.

const oauthConfigured = (env) => isConfigured(env);
const nowSec = () => Math.floor(Date.now() / 1000);

// 서명 키는 ISSUANCE_SALT 를 재사용한다 — 이유는 google-oauth.js 주석 참조.
// 미설정이면 발급이 이미 503 이므로 로그인만 열어 둘 이유가 없다.
const authSecret = (env) => String(env.ISSUANCE_SALT || "").trim();

async function startGoogleAuth(env, url) {
  if (!oauthConfigured(env))
    return problem(503, "oauth disabled", "GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET 미설정");
  const secret = authSecret(env);
  if (!secret) return problem(503, "issuance disabled", "ISSUANCE_SALT 미설정 — 발급 경로가 닫혀 있다");
  const state = await makeState(secret, nowSec());
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl({ clientId: env.GOOGLE_CLIENT_ID, redirect: redirectUri(url), state }),
      "set-cookie": stateCookie(state, url),
      // 로그인 시작 페이지가 캐시되면 남의 state 를 물고 갈 수 있다
      "cache-control": "no-store",
    },
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 🔴 키는 **URL 에 절대 싣지 않는다** — 주소창·브라우저 이력·Referer·서버 로그에 남는다.
// 그래서 리다이렉트로 넘기지 않고 콜백이 직접 페이지를 그린다. 기존 "지금 한 번만 표시"
// 계약과 같고, 새 엔드포인트도 새 표도 필요 없다.
const authPage = (title, bodyHtml, status = 200) => new Response(
  `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${esc(title)} — ASK: SEOUL</title>` +
  `<link rel="stylesheet" href="/site.css"></head><body class="doc">` +
  `<main style="max-width:44rem;margin:3rem auto;padding:0 1.25rem">${bodyHtml}` +
  `<p style="margin-top:2rem"><a href="/catalog.html">← 데이터 카탈로그로</a></p></main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function googleCallback(env, request, url, trace) {
  if (!oauthConfigured(env)) return problem(503, "oauth disabled", "GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET 미설정");
  const secret = authSecret(env);
  if (!secret) return problem(503, "issuance disabled", "ISSUANCE_SALT 미설정");

  const err = url.searchParams.get("error");
  if (err) return authPage("로그인 취소", `<h1>로그인이 완료되지 않았어요</h1><p>Google 에서 <code>${esc(err)}</code> 로 돌아왔습니다. 다시 시도해 주세요.</p>`, 400);

  // state 는 **두 곳이 일치**해야 한다 — 쿼리(돌아온 값)와 쿠키(우리가 심은 값).
  // 하나만 봐서는 남이 만든 로그인을 우리 브라우저에 이어붙이는 것을 못 막는다.
  const qState = url.searchParams.get("state");
  const cState = readCookie(request.headers.get("cookie"), STATE_COOKIE);
  if (!qState || !cState || qState !== cState || !(await verifyState(secret, qState, nowSec())))
    return authPage("로그인 확인 실패", "<h1>로그인 확인에 실패했어요</h1><p>주소가 오래됐거나 중간에 바뀌었습니다. 처음부터 다시 시도해 주세요.</p>", 400);

  const code = url.searchParams.get("code");
  if (!code) return authPage("로그인 실패", "<h1>로그인 정보가 없어요</h1><p>처음부터 다시 시도해 주세요.</p>", 400);

  const ex = await exchangeCode({
    code, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirect: redirectUri(url),
  });
  if (ex.error) return authPage("로그인 실패", "<h1>Google 확인에 실패했어요</h1><p>잠시 뒤 다시 시도해 주세요.</p>", 502);

  const id = readIdTokenFromTokenEndpoint(ex.idToken, { clientId: env.GOOGLE_CLIENT_ID, nowSec: nowSec() });
  if (id.error) {
    // email_verified 가 아닌 계정은 여기서 멈춘다 — 이 이슈의 전부가 이 한 줄이다.
    const detail = id.error === "email not verified"
      ? "이 Google 계정은 이메일이 확인되지 않은 상태예요. 계정 설정에서 이메일을 확인한 뒤 다시 시도해 주세요."
      : "Google 응답을 확인하지 못했어요. 다시 시도해 주세요.";
    return authPage("발급 불가", `<h1>키를 발급하지 못했어요</h1><p>${esc(detail)}</p>`, 403);
  }
  const email = id.email;

  // 발급 rate limit 은 그대로 둔다 — 로그인이 확인해 주는 건 **주소 소유**이지 남용 의도가 아니다.
  const ip = await sha256hex(`${kstDay()}|${secret}|${request.headers.get("cf-connecting-ip") || "local"}`);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { results: recent } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM _issuance_log WHERE ip = ? AND created_at > ?").bind(ip, hourAgo).all();
  if (recent[0].n >= ISSUE_HOURLY_CAP)
    return authPage("잠시 뒤에", `<h1>발급이 잦았어요</h1><p>같은 네트워크에서 시간당 ${ISSUE_HOURLY_CAP}회까지예요. 잠시 뒤 다시 시도해 주세요.</p>`, 429);

  // 🔑 이미 키가 있으면 **여기서 바로 회전하지 않는다.** 파괴적 동작을 확인 없이 실행하지
  // 않는다는 규약(#58) 때문이다. 대신 **되묻는다** — 콜백의 code 는 일회용이라 왕복을 못
  // 만들지만, 소유 확인 결과를 짧은 서명 티켓으로 바꿔 실어 보내면 된다(#303).
  //
  // ⚠️ 예전에는 여기서 409 로 끝내고 *"기존 키를 폐기한 뒤 다시 로그인하라"* 고 안내했는데,
  //    폐기에는 그 키가 필요하다 — **키를 잃은 사람에게 그가 할 수 없는 일을 시키고 있었다.**
  //    게다가 폐기는 행을 남기므로(status='revoked'), 폐기에 성공해도 아래 검사에 다시 걸려
  //    재발급이 안 됐다. 그래서 이 검사는 **상태를 안 본다** — 살아 있든 폐기됐든 "다시
  //    로그인 = 재발급" 하나로 통일한다.
  // 🔴 가드를 **키 행보다 먼저** 읽는다 — 완전삭제로 키 행이 없어도 상한은 살아 있어야 한다.
  const gHash = await guardHash(secret, email);
  const guard = await readGuard(env, gHash);

  const existing = await env.DB.prepare(
    "SELECT key_hash, key_prefix, status, rotated_day, rotated_count FROM _keys WHERE email = ?")
    .bind(email).first();
  if (existing) {
    const ticket = await makeRotateTicket(secret, existing.key_hash, nowSec());
    const dead = existing.status !== "active";
    const usedToday = usedTodayFrom(guard, existing);
    const left = Math.max(0, ROTATE_DAILY_CAP - usedToday);
    return authPage("키를 새로 발급할까요?",
      `<h1>이 계정에 이미 키가 있어요</h1>` +
      `<p><code>${esc(existing.key_prefix)}…</code> 로 시작하는 키가 있습니다` +
      (dead ? " (이미 폐기된 키예요)" : "") + `. 키는 계정당 하나예요.</p>` +
      `<p><strong>새로 발급하면 그 키는 즉시 무효가 됩니다.</strong> 지금 쓰고 있는 곳이 있다면 ` +
      `새 키로 바꿔 주셔야 해요. 오늘 쓴 호출 수는 새 키로 그대로 이어집니다.</p>` +
      (left > 0
        // 두 번 눌리는 것을 화면에서도 한 번 막는다 — 서버가 겹침을 잡긴 하지만, 잡히는 쪽은
        // 키를 못 받고 재발급 횟수만 쓴다. JS 가 없어도 폼은 그대로 동작한다.
        ? `<form method="post" action="/api/v1/keys/rotate" style="margin-top:1.5rem" ` +
          `onsubmit="setTimeout(function(){var b=document.getElementById('go');b.disabled=true;b.textContent='발급 중…'},0)">` +
          `<input type="hidden" name="ticket" value="${esc(ticket)}">` +
          `<button type="submit" id="go" style="font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;` +
          `border:1px solid currentColor;background:transparent;cursor:pointer">새 키 발급</button>` +
          `</form>` +
          `<p style="margin-top:1rem;font-size:.9rem;opacity:.75">키가 아직 있으시면 이 창을 닫으셔도 됩니다` +
          ` · 오늘 ${left}번 더 재발급할 수 있어요.</p>`
        : `<p style="margin-top:1.5rem"><strong>오늘 재발급 횟수를 다 쓰셨어요.</strong> ` +
          `한 계정은 하루 ${ROTATE_DAILY_CAP}번까지예요 — 내일 다시 시도해 주세요` +
          `(하루 경계는 한국 시간 자정입니다).</p>`),
      409);
  }

  // 🔴 **키 행이 없는데 가드가 있으면 그건 첫 발급이 아니다** — 완전삭제하고 돌아온 것이다.
  //    여기서 상한을 안 걸면 완전삭제가 상한의 우회로가 된다(#320 의 전부가 이 갈래다).
  const usedToday = usedTodayFrom(guard, null);
  if (guard && usedToday >= ROTATE_DAILY_CAP)
    return authPage("오늘은 여기까지",
      `<h1>오늘 재발급 횟수를 다 쓰셨어요</h1>` +
      `<p>한 계정은 하루 ${ROTATE_DAILY_CAP}번까지 새로 발급할 수 있어요. ` +
      `내일 다시 시도해 주세요 — 하루 경계는 한국 시간 자정입니다.</p>` +
      `<p style="font-size:.9rem;opacity:.75">이 횟수는 키를 완전 삭제하셔도 이어서 셉니다 ` +
      `(<a href="/privacy#retention">개인정보 처리방침 제3조</a> — 30일 보관).</p>`, 429);

  const key = newKey();
  const hash = await sha256hex(key);
  const prefix = key.slice(0, 8);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO _keys (key_hash, key_prefix, email, created_at) VALUES (?, ?, ?, ?)")
      .bind(hash, prefix, email, now),
    env.DB.prepare("INSERT INTO _issuance_log (ip, created_at) VALUES (?, ?)").bind(ip, now),
    env.DB.prepare("DELETE FROM _issuance_log WHERE created_at < ?")
      .bind(new Date(Date.now() - 86400000).toISOString()),
    // 첫 발급이면 자리만(0), 완전삭제 뒤 재발급이면 한 칸 올린다
    ...writeGuard(env, gHash, guard ? usedToday + 1 : 0),
  ]);
  trace.keyHash = hash;

  // 키 원문은 여기 한 번만 나온다. 쿠키는 역할이 끝났으니 즉시 지운다.
  return new Response(authPage("키 발급 완료",
    `<h1>키가 발급됐어요</h1>` +
    `<p><strong>이 키는 지금 한 번만 표시됩니다</strong> — 서버에는 해시만 저장돼 다시 보여드릴 수 없어요.</p>` +
    `<p><code style="display:block;padding:.75rem 1rem;font-size:1.05rem;word-break:break-all">${esc(key)}</code></p>` +
    `<p>요청 헤더에 <code>Authorization: Bearer &lt;키&gt;</code> 로 실어 보내세요.</p>`).body,
    { status: 201, headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "set-cookie": stateCookie("", url, 0),
      } });
}

// 회전 — 잃어버린 키를 **본인이** 새로 발급받는 경로(#303).
//
// 여기 오는 사람은 이미 Google 로 이메일 소유를 증명했고(콜백), 확인 페이지에서 버튼을
// 한 번 더 눌렀다. 티켓이 그 둘을 이어 준다 — 서명이 소유를, POST 가 확인을 맡는다.
//
// 🔴 **행을 제자리에서 갈아 끼운다.** `_keys.email` 이 UNIQUE 라 새 행을 못 넣고, 넣을
//    이유도 없다 — "계정당 키 하나"가 이 서비스의 모델이다.
// 🔴 **오늘 쓴 양을 새 해시로 이월한다.** `_usage` 는 `(key_hash, day)` 가 PK 라 새 키는
//    당일 사용량이 0 으로 시작한다 — 이월하지 않으면 **회전이 곧 쿼터 리셋**이라, 한도를
//    다 쓴 사람이 재발급으로 초기화할 수 있다(오너 결정, 2026-08-12). 버스트(`_burst`)는
//    분 단위라 이월하지 않는다 — 회전 한 번으로 얻는 이득이 없다.
async function rotateKey(env, request, url, trace) {
  if (!oauthConfigured(env)) return problem(503, "oauth disabled", "GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET 미설정");
  const secret = authSecret(env);
  if (!secret) return problem(503, "issuance disabled", "ISSUANCE_SALT 미설정");

  let ticket = "";
  try {
    const form = await request.formData();
    ticket = String(form.get("ticket") || "");
  } catch { /* 폼이 아니면 아래에서 티켓 없음으로 떨어진다 */ }

  const ok = await verifyRotateTicket(secret, ticket, nowSec());
  if (!ok)
    return authPage("다시 시도해 주세요",
      `<h1>확인이 만료됐어요</h1><p>확인 창은 10분 동안만 열려 있어요. ` +
      `<a href="/api/v1/auth/google">다시 로그인</a>해서 새로 시작해 주세요.</p>`, 400);

  // 🔑 티켓은 **그 해시의 행이 아직 있을 때만** 유효하다. 회전하면 해시가 바뀌므로 같은
  //    티켓을 두 번 쓰면 여기서 걸린다 — 사용 여부를 적어 둘 표가 필요 없다.
  const row = await env.DB.prepare(
    "SELECT key_hash, email, rotated_day, rotated_count FROM _keys WHERE key_hash = ?").bind(ok.keyHash).first();
  if (!row)
    return authPage("이미 처리됐어요",
      `<h1>이미 새 키가 발급됐어요</h1><p>이 확인은 한 번만 쓸 수 있어요. ` +
      `키를 못 받으셨다면 <a href="/api/v1/auth/google">다시 로그인</a>해 주세요.</p>`, 409);

  // 계정 기준 상한 — 오늘이 아니면 0 부터 다시 센다. 정본은 `_issuance_guard` 이고
  // (완전삭제가 못 지우는 자리), `_keys` 의 옛 컬럼은 0008 적용 전 계정의 seed 로만 읽는다.
  const gHash = await guardHash(secret, row.email);
  const usedToday = usedTodayFrom(await readGuard(env, gHash), row);
  if (usedToday >= ROTATE_DAILY_CAP)
    return authPage("오늘은 여기까지",
      `<h1>오늘 재발급 횟수를 다 쓰셨어요</h1>` +
      `<p>한 계정은 하루 ${ROTATE_DAILY_CAP}번까지 재발급할 수 있어요. ` +
      `내일 다시 시도해 주세요 — 하루 경계는 한국 시간 자정입니다.</p>` +
      `<p style="font-size:.9rem;opacity:.75">지금 쓰고 계신 키는 그대로 살아 있습니다.</p>`, 429);

  // 발급 상한은 그대로 건다 — 로그인이 확인해 주는 건 주소 소유이지 남용 의도가 아니다.
  const ip = await sha256hex(`${kstDay()}|${secret}|${request.headers.get("cf-connecting-ip") || "local"}`);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { results: recent } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM _issuance_log WHERE ip = ? AND created_at > ?").bind(ip, hourAgo).all();
  if (recent[0].n >= ISSUE_HOURLY_CAP)
    return authPage("잠시 뒤에",
      `<h1>발급이 잦았어요</h1><p>같은 네트워크에서 시간당 ${ISSUE_HOURLY_CAP}회까지예요. 잠시 뒤 다시 시도해 주세요.</p>`, 429);

  const key = newKey();
  const hash = await sha256hex(key);
  const prefix = key.slice(0, 8);
  const now = new Date().toISOString();
  const written = await env.DB.batch([
    // 오늘 쓴 양을 먼저 옮긴다 — 키를 갈아 끼운 뒤에 옮기면 그 사이 요청이 새 해시에 세어져
    // 덮어쓸 위험이 있다. 같은 batch 라 원자적이지만 순서까지 맞춰 둔다.
    env.DB.prepare(
      "INSERT INTO _usage (key_hash, day, count) SELECT ?, day, count FROM _usage WHERE key_hash = ? AND day = ? " +
      "ON CONFLICT(key_hash, day) DO UPDATE SET count = excluded.count")
      .bind(hash, ok.keyHash, kstDay()),
    // ⚠️ `rotated_day/rotated_count` 는 **더 쓰지 않는다** — 정본이 `_issuance_guard` 로
    //    옮겨졌다(#320). 컬럼은 증분 원칙상 남겨 두고(0008 주석) 읽기만 한다.
    env.DB.prepare(
      "UPDATE _keys SET key_hash = ?, key_prefix = ?, status = 'active', created_at = ? WHERE key_hash = ?")
      .bind(hash, prefix, now, ok.keyHash),
    env.DB.prepare("INSERT INTO _issuance_log (ip, created_at) VALUES (?, ?)").bind(ip, now),
    env.DB.prepare("DELETE FROM _issuance_log WHERE created_at < ?")
      .bind(new Date(Date.now() - 86400000).toISOString()),
    ...writeGuard(env, gHash, usedToday + 1),
  ]);

  // 🔴 **키를 보여 주기 전에 그 키가 실제로 앉았는지 본다.** 같은 티켓으로 두 요청이 거의
  //    동시에 오면(버튼 두 번 누르기) 둘 다 행을 읽은 뒤 하나만 갱신에 성공한다 — 진 쪽은
  //    `WHERE key_hash = <옛 해시>` 가 0행이 되는데, 그걸 안 보면 **작동하지 않는 키를
  //    보여 주고** 이용자는 그 사실을 나중에 401 로 알게 된다. 원문은 여기서만 나오므로
  //    그 화면을 놓치면 복구할 길도 없다.
  //    (`meta` 를 못 읽는 실행기에서는 판단을 보류하고 진행한다 — 실 D1 은 항상 준다.)
  const changed = written?.[1]?.meta?.changes;
  if (changed === 0)
    return authPage("다시 시도해 주세요",
      `<h1>발급이 겹쳤어요</h1><p>같은 확인이 두 번 처리돼 이번 요청은 반영되지 않았습니다. ` +
      `<a href="/api/v1/auth/google">다시 로그인</a>해서 새로 받아 주세요.</p>`, 409);

  trace.keyHash = hash;

  return new Response(authPage("새 키 발급 완료",
    `<h1>새 키가 발급됐어요</h1>` +
    `<p>이전 키는 <strong>이제 무효</strong>입니다.</p>` +
    `<p><strong>이 키는 지금 한 번만 표시됩니다</strong> — 서버에는 해시만 저장돼 다시 보여드릴 수 없어요.</p>` +
    `<p><code style="display:block;padding:.75rem 1rem;font-size:1.05rem;word-break:break-all">${esc(key)}</code></p>` +
    `<p>요청 헤더에 <code>Authorization: Bearer &lt;키&gt;</code> 로 실어 보내세요.</p>`).body,
    { status: 201, headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "set-cookie": stateCookie("", url, 0),
      } });
}

// 폐기 — 키를 즉시 무효화한다. purge=true 면 이메일·사용량까지 지운다(처리방침의 삭제 요청
// 셀프 경로). 요청 로그의 key_hash 는 남지만, 해시→이메일 대응이 사라지므로 사람과 연결되지
// 않는다. 30일 뒤 자동 삭제되는 건 그대로다.
//
// 🔴 **`_issuance_guard` 는 지우지 않는다** (#320). 지우면 완전삭제가 재발급 상한의
//    우회로가 된다 — 남용 → 완전삭제 → 재로그인 → 새 키가 무제한으로 돈다. 가드에는
//    이메일 **해시**만 있고 30일 뒤 사라지므로, 삭제권을 지우는 대신 **범위를 좁혀** 남긴다
//    (처리방침 제3조·제7조에 그대로 적었다). 이건 정보를 늘린 게 아니라 — 원문 이메일이
//    무기한 남던 자리를 해시 30일로 **줄인** 것이다.
async function revokeKey(env, keyRow, purge) {
  if (purge) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM _usage WHERE key_hash = ?").bind(keyRow.key_hash),
      env.DB.prepare("DELETE FROM _burst WHERE bucket = ?").bind("k:" + keyRow.key_hash),
      env.DB.prepare("DELETE FROM _keys WHERE key_hash = ?").bind(keyRow.key_hash),
    ]);
    return json({
      key_prefix: keyRow.key_prefix, purged: true,
      note: "키와 이메일·사용량 기록을 삭제했다. 요청 로그(30일 보존)는 키 해시만 남아 사람과 연결되지 않는다. " +
        "재발급 횟수는 이메일 해시로 30일 더 남는다 — 하루 5회 상한을 위한 것이며 삭제해도 이어서 센다",
    });
  }
  await env.DB.prepare("UPDATE _keys SET status = 'revoked' WHERE key_hash = ?")
    .bind(keyRow.key_hash).run();
  return json({
    key_prefix: keyRow.key_prefix, revoked: true,
    // 발급 경로가 환경마다 갈리므로(#110 ②) 한쪽을 단정하지 않는다 — 이메일 폼일 수도,
    // Google 로그인일 수도 있다. 어느 쪽인지는 카탈로그의 key_issuance 가 말한다.
    // 🔴 예전 문구는 "같은 주소로 다시 발급받으면 새 키를 받는다"였는데, 폐기는 행을 남기고
    //    존재 검사가 그 행을 잡아 **재발급이 409 로 막혔다**(#303). 지금은 그 검사가 상태를
    //    안 보고 회전 확인 페이지로 보내므로 이 말이 사실이 됐다 — 경로까지 밝혀 둔다.
    note: "이 키는 즉시 무효다. 다시 로그인하면(GET /api/v1/auth/google) 확인 뒤 새 키를 받는다",
  });
}


// 도메인 간 공통 조인축(#48) — 서로 다른 제품의 같은 컬럼끼리 그대로 조인된다.
// UI(catalog.html) 의 JOIN 배지와 같은 목록인데, 화면에만 있으면 API 소비자(특히 AI 에이전트)는
// 크로스도메인 분석의 열쇠를 모른 채 추측해야 한다 — 그래서 응답 메타로도 내보낸다.
const JOIN_AXES = ["admin_dong_code", "gu_code", "stat_region_cd"];

// 카탈로그는 **발행할 때만 바뀐다** — 그런데 방문마다 D1 을 세 번 치고 1,156행을 읽어
// 414KB 를 새로 만든다. 실측(2026-08-06): 배포본 1.8s · 로컬 2.7s 이고 세 번 연속 호출해도
// 2.7·2.7·2.8 로 전혀 안 줄었다. 같은 워커의 정적 경로(`/llms.txt`)가 0.51s 이므로
// **1.3초 이상이 이 응답을 만드는 데 쓰인다.**
//
// 무거워진 건 #434 가 성공했기 때문이다 — 활용 예시가 8건 → 379건이 되면서 응답의 74.7%를
// 차지하게 됐다(주석에 "약 245KB"라 적혀 있던 것이 414KB). 남은 도메인이 발행하면 425건이 된다.
//
// 그래서 줄이는 대신 **다시 만들지 않는다.**
//
// 🔴 **60초 TTL 만으로는 거의 안 들었다**(2026-08-06 재실측). 카탈로그는 발행할 때만 바뀌는데
// 사람은 띄엄띄엄 들어온다 — curl 세 번은 0.014s 였는데 1분 뒤 브라우저 진입은 **4.5초**였다.
// 캐시가 "연타할 때만" 듣고 있었다. 그래서 두 가지를 더한다:
//   ① 질의 병렬화 — 아래 Promise.all. 콜드 경로 자체를 낮춘다
//   ② stale-while-revalidate — 만료돼도 옛것을 즉시 주고 뒤에서 갱신한다
// ②가 있으면 **첫 방문 한 번**만 콜드를 맞고 이후는 계속 즉시 응답이다.
const CATALOG_TTL = 60;              // 이 안이면 그냥 신선
// 만료 뒤에도 이만큼은 **옛것을 주면서** 뒤에서 갱신한다. 카탈로그 메타(제품 목록·설명·예시)는
// 하루 단위로 바뀌고 15분마다 바뀌는 것은 `exported_at` 뿐이라, 10분 묵은 값이 틀린 값은 아니다.
const CATALOG_STALE_TTL = 600;
// 캐시에 담는 사본은 **더 길게** 산다 — Cache API 가 max-age 로 만료시켜 버리면 stale 을 꺼낼
// 수가 없다. 신선도 판정은 우리가 `x-cached-at` 으로 직접 한다.
const CATALOG_CACHE_HEADER = `public, max-age=${CATALOG_STALE_TTL}`;
// 캐시 키는 **합성 URL** 이다 — 이 핸들러는 `/api/v1/catalog` 와 MCP `list_products` 양쪽에서
// 불리는데(mcp.js 의 deps.handleCatalog), 요청 객체가 서로 달라도 같은 응답이라 한 칸을 쓴다.
// 🔴 캐시 키에 **발급 방식**을 섞는다. 응답 본문에 `key_issuance` 가 들어 있어서, 정책을
// 켠 직후에도 캐시가 옛 값("email")을 최대 10분간 준다 — 그 사이 화면은 이메일 폼을 띄우고
// 제출은 403 을 받는다. 실측으로 걸린 함정이다(2026-08-06, #110 ② 로컬 검증).
// 캐시를 지우는 대신 **키를 가른다**: 정책이 바뀌면 다른 칸을 보므로 즉시 새 값이 나가고,
// 옛 칸은 TTL 로 알아서 만료된다.
// 테스트가 키를 하드코딩하면 다음에 축을 하나 더 섞을 때 조용히 어긋난다 — 그래서 내보낸다.
// 🐛 2026-08-06 사고의 잔상: 응답 본문에 `key_issuance` 가 들어 있는데 캐시 키에 그 축이
// 없어서, 발급 방식을 바꾼 뒤 최대 10분간 **옛 방식이 그대로 나갔다**(화면은 이메일 폼,
// 제출은 403). 그래서 키에 축을 섞었었다.
// 이메일 발급을 폐지(2026-08-07)하면서 그 축은 **상수가 됐다** — 가를 것이 없어 뺐었다.
//
// 🔴 2026-08-12 — **축이 다시 생겼다.** 응답에 `chat.enabled`(= `env.AI` 바인딩 유무)를
//    실었기 때문이다. 위 경고("환경마다 달라지는 값을 다시 넣게 되면 그 축을 되살려야 한다")가
//    가리키던 바로 그 경우다. 안 가르면 AI 를 켠 뒤에도 캐시가 최대 10분간 `enabled:false` 를
//    주고, 화면은 그동안 질문 칸을 안 띄운다 — 2026-08-06 사고와 똑같은 모양이다.
export const catalogCacheKey = (env) =>
  `https://catalog.internal/api/v1/catalog?chat=${env && env.AI ? 1 : 0}`;

// 캐시에 담긴 사본의 나이(초). `x-cached-at` 이 없으면 옛 형식이라 만료로 본다.
const cachedAgeSeconds = (res) => {
  const at = Number(res.headers.get("x-cached-at"));
  return Number.isFinite(at) && at > 0 ? (Date.now() - at) / 1000 : Infinity;
};

// 캐시 사본을 **클라이언트용 헤더로 갈아입혀** 내보낸다. 사본은 stale 을 꺼내려고 긴
// `max-age` 와 내부 표식(`x-cached-at`)을 달고 있는데, 그대로 주면 브라우저가 10분을 들고
// 있고 내부 구현이 응답에 샌다(실측 — 히트 시 `max-age=600` 이 나갔다).
const asClientResponse = (hit) =>
  new Response(hit.body, {
    status: hit.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${CATALOG_TTL}`,
    },
  });

async function handleCatalog(env, ctx) {
  // Cache API 가 없는 실행기(테스트 하네스 등)에서도 그대로 동작해야 한다 — 캐시는 성능이지
  // 계약이 아니다. 못 쓰면 조용히 매번 만든다.
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const cacheKey = cache ? new Request(catalogCacheKey(env)) : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const age = cachedAgeSeconds(hit);
      if (age <= CATALOG_TTL) return asClientResponse(hit);  // 신선 — 그대로
      if (age <= CATALOG_STALE_TTL) {
        // 만료됐지만 **기다리게 하지 않는다** — 옛것을 즉시 주고 뒤에서 새로 만든다.
        // waitUntil 이 없으면(=MCP 경유 등) 갱신을 띄우지 않는다. 응답 반환과 함께
        // 취소될 약속을 남기면 "갱신했다고 믿는데 안 된" 상태가 된다.
        if (ctx && ctx.waitUntil) ctx.waitUntil(buildCatalog(env, cache, cacheKey));
        return asClientResponse(hit);
      }
      // 그보다 오래됐으면 옛것을 주지 않는다 — 새로 만든다(아래로 떨어진다).
    }
  }
  return buildCatalog(env, cache, cacheKey);
}

async function buildCatalog(env, cache, cacheKey) {
  // 🔴 **여섯 질의를 줄세우지 않는다.** 서로 독립적인 읽기인데 순차로 `await` 하면 D1 왕복이
  // 그대로 더해진다 — 한국↔CF 왕복이 회당 0.7~0.9s 라 5번이면 4~4.5s 다(브라우저 실측 4,529ms).
  // 병렬로 띄우면 가장 느린 하나로 수렴한다. 실패 처리는 그대로다: `_catalog` 이 깨지면
  // 전체가 reject 되고(카탈로그 없이는 응답이 성립하지 않는다), 나머지 다섯은 `safeRows` 가
  // null 로 내려앉아 **그 부분만 빠진 채** 응답이 나간다.
  const [catalogRes, docRows, patternRows, displayRows, grainRows, vocabularyRows] = await Promise.all([
    env.DB.prepare(
      "SELECT name, product_id, external, description, product_question, time_axis, columns, " +
      "row_count, freshness, exported_at " +
      `FROM _catalog WHERE ${PUBLIC} ORDER BY name`
    ).all(),
    safeRows(env.DB.prepare(
      "SELECT product_id, column_name, description_ko FROM d1_catalog_columns"
    )),
    safeRows(env.DB.prepare(
      'SELECT product_id, pattern_id, question_ko, axes, "sql", requires, verified_rows, ' +
      'verified_at, allow_empty, insight_sample_ko FROM d1_usage_patterns ORDER BY product_id, pattern_id'
    )),
    safeRows(env.DB.prepare(
      "SELECT product_id, title, summary, caveat, use_cases FROM d1_catalog_display"
    )),
    safeRows(env.DB.prepare(
      "SELECT product_id, grain FROM d1_catalog_ext"
    )),
    safeRows(env.DB.prepare(
      "SELECT product_id, column_name, vocabulary_id FROM d1_catalog_column_vocabularies"
    )),
  ]);
  const { results } = catalogRes;

  // 컬럼 설명의 정본은 **게시본**이다(`d1_catalog_columns.description_ko`, ASAC-DAG#642 §3).
  // `_catalog.columns` 는 name·type 만 실어 오므로 여기서 붙인다.
  //
  // 예전엔 정적 `column-docs.json` 이 그 자리를 메웠는데, 원천이 dbt yml 이고 생성기를 사람이
  // 돌리는 구조라 **게시본과 어긋났다** — 실측에서 14종 중 7종이 카탈로그에 없는 표였고,
  // culture 활동 제품은 `kopis_festivals_count` 라는 지금 없는 컬럼을 설명하고 있었다.
  // "손으로 쓰는 예제 문서는 만들지 않는다"(#642 §3)가 그래서 있다.
  //
  // 표가 없거나 못 읽으면 **설명만 빠지고 카탈로그는 그대로 나간다** — 관측 부재가 서빙을
  // 막지 않는다. 값이 없는 컬럼은 `description: null` 로 명시한다("모른다"를 빈 문자열로
  // 꾸미면 화면이 설명이 있는 척한다).
  const docs = new Map();
  for (const r of docRows || []) docs.set(`${r.product_id}|${r.column_name}`, r.description_ko || null);
  const vocabularies = new Map();
  for (const r of vocabularyRows || []) {
    vocabularies.set(`${r.product_id}|${r.column_name}`, r.vocabulary_id);
  }

  // 활용 예시도 같은 이유로 게시본에서 온다(`d1_usage_patterns`, #642 §3).
  //
  // **목록 단계에서 전 제품이 필요하다** — 화면 검색이 모든 제품의 질문을 훑고, 목록 배지가
  // 개수를 띄운다. 제품을 펼칠 때 받아 오면 검색이 깨진다. 그래서 카탈로그가 통째로 싣는다.
  // 응답이 무거워지지만(약 245KB) 총량은 안 는다 — 화면이 정적 사본으로 받던 그 양이고,
  // 요청만 하나 줄었다. 대신 **화면만 알던 예시를 API 소비자·에이전트도 받는다.**
  //
  // 필드 이름은 번들(`/api/v1/products/<id>`)과 같은 게시본 어휘로 맞춘다 — 같은 것을 문마다
  // 다르게 부르면 소비자가 두 벌을 배워야 한다.
  const patterns = new Map();
  for (const p of patternRows || []) {
    if (!patterns.has(p.product_id)) patterns.set(p.product_id, []);
    patterns.get(p.product_id).push({
      pattern_id: p.pattern_id,
      question_ko: p.question_ko,
      axes: p.axes,
      // sql 은 **참조 구현**이다(#600 §4.3) — 그대로 실행하는 값이 아니라 "이 제품으로 어디까지
      // 답할 수 있는가"의 명세다. 번들은 아직 이 필드를 안 싣는다(별건).
      sql: p.sql,
      requires: parseJsonArray(p.requires),
      verified_rows: p.verified_rows,
      verified_at: p.verified_at,           // 백필 전이라 당분간 NULL (#642 §0)
      allow_empty: Boolean(p.allow_empty),
      insight_sample_ko: p.insight_sample_ko,
    });
  }
  // 표시 메타도 게시본에서 온다(`d1_catalog_display`, ASAC-DAG#706). 여기가 **손 사본을
  // 없앤 자리**다 — `public/product-display.json` 이 제목·설명을 들고 있었는데, 원천이 dbt yml
  // 이고 생성기를 사람이 돌리는 구조라 게시본과 계속 어긋났다(62키 대 카탈로그 56종, 내려간
  // 제품이 그대로 남음). `column-docs.json`·`usage-patterns.json` 과 같은 처리다.
  //
  // 미선언 제품은 `display: null` 이다 — 빈 문자열로 채우면 화면이 "제목이 있는 척"한다.
  // 지금은 절반(citydata·culture·transit)만 선언했고, 나머지는 화면이 product_id 로 내려앉는다.
  const displays = new Map();
  for (const r of displayRows || []) {
    displays.set(r.product_id, {
      title: r.title ?? null,
      summary: r.summary ?? null,
      caveat: r.caveat ?? null,
      use_cases: parseJsonArray(r.use_cases),
    });
  }

  // 그레인은 `d1_catalog_ext` 에 이미 게시돼 있다. 사본이 `unit`("행정동 × 날짜")으로 들고
  // 있던 것의 정본이고, 사본을 지우면서 이쪽으로 옮긴다. **별도 질의로 둔다** — 조인하면
  // 한쪽 표가 없을 때 둘 다 잃는다.
  const grains = new Map();
  for (const r of grainRows || []) grains.set(r.product_id, r.grain ?? null);

  // description 을 반드시 실어야 한다 — 제품의 주의사항("기상청 공식 특보가 아님" 등)이
  // 여기에 있고, 화면을 안 거치는 소비자에게는 이 응답이 그걸 전달할 유일한 경로다.
  const res = json({
    // 출처·이용조건은 응답에서도 닿아야 한다 — 화면을 거치지 않고 API 만 쓰는 소비자가 있다
    attribution: ATTRIBUTION,
    docs: "/llms.txt",
    openapi: "/openapi.json",
    // 키를 어떻게 받는지는 **화면을 안 거치는 소비자에게도** 필요하다(#110 ②).
    // 이메일 발급 폐지(2026-08-07) 후로 방법은 하나뿐이지만 필드는 유지한다 — 소비자가
    // 문서가 아니라 **응답을 보고** 알게 하는 것이 이 필드의 목적이다.
    key_issuance: { method: "google_oauth", start: "/api/v1/auth/google" },
    // 🔴 **채팅이 실제로 답할 수 있는지**를 응답이 말한다(#0006 의 `env.AI` 바인딩 유무).
    //    화면이 이 값을 보고 질문 칸을 띄운다 — 안 보고 띄우면 **답 못 하는 입구**가 선다.
    //    실측(2026-08-12 운영): 바인딩이 없으면 `degraded: ai_unavailable` 이고 `answer` 가
    //    늘 null 이다. 질문이 그 제품과 안 맞으면 후보도 0건이라, 화면이 약속한 "추천"조차
    //    안 나온다 — 라벨은 "골라 실행합니다"인데 실행이 없다.
    //    ⚠️ 이 값을 넣었으므로 **캐시 키에 축이 생겼다**(`catalogCacheKey` 주석 참조).
    chat: { enabled: Boolean(env.AI) },
    join_axes: JOIN_AXES,
    products: results.map((r) => {
      const columns = JSON.parse(r.columns).map((c) => {
        const vocabularyId = vocabularies.get(`${r.product_id}|${c.name}`);
        return {
          ...c,
          description: docs.get(`${r.product_id}|${c.name}`) ?? null,
          ...(vocabularyId ? { vocabulary_id: vocabularyId } : {}),
        };
      });
      return {
        ...r, columns,
        join_keys: columns.map((c) => c.name).filter((n) => JOIN_AXES.includes(n)),
        usage_patterns: patterns.get(r.product_id) || [],
        display: displays.get(r.product_id) || null,
        grain: grains.get(r.product_id) ?? null,
      };
    }),
  }, 200, {
    // 브라우저에게 알리는 수명은 **짧게** — 사람이 새로고침했을 때 한 세대 묵은 값을
    // 오래 들고 있지 않게 한다. 엣지 사본은 아래에서 더 길게 담는다(stale 을 꺼내야 하므로).
    "cache-control": `public, max-age=${CATALOG_TTL}`,
  });

  if (cache) {
    // 캐시 사본은 **클라이언트에 준 것과 헤더가 다르다.**
    //  · `max-age` 를 stale 한도까지 늘린다 — Cache API 가 만료로 지워 버리면 stale 을
    //    꺼낼 수가 없어 SWR 자체가 성립하지 않는다.
    //  · `x-cached-at` 으로 **우리가 직접** 신선도를 잰다(Age 헤더는 실행기마다 다르다).
    const copy = new Response(res.clone().body, {
      status: res.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": CATALOG_CACHE_HEADER,
        "x-cached-at": String(Date.now()),
      },
    });
    // 실패한 응답은 담지 않는다(여기까지 왔으면 200 이지만, 규칙을 코드에 남긴다).
    if (res.status === 200) await cache.put(cacheKey, copy);
  }
  return res;
}

// 공개 식별자 해석 — `product_id` 가 정본이고 테이블명은 과도기 별칭이다(decision/0003).
//
// 왜 둘 다 받나: 테이블명은 물리 이름이라 바뀔 수 있고 도메인마다 접두사가 갈리는데
// (`gold_` 40종 · `d1_` 22종), `product_id` 는 계약(meta.serving)이 보증하고 접두사가 없다.
// `/v1/*`·`/skill/v1/*` 은 이미 product_id 를 쓰고 있어서, 옛 `/api/*` 만 맞추는 것이다.
// 별칭을 끊는 시점은 공개 배포 이후 별도 판단(#20) — 지금 끊으면 붙어 있는 소비자가 깨진다.
//
// 우선순위를 명시하는 이유: 지금은 두 이름 공간이 안 겹치지만(테이블은 gold_/d1_, id 는
// 도메인 접두), 언젠가 어떤 제품의 테이블명이 다른 제품의 id 와 같아지면 `.first()` 가
// 어느 행을 줄지 알 수 없다. product_id 가 이긴다고 못박아 둔다.
async function lookupProduct(env, id, cols) {
  return env.DB.prepare(
    `SELECT ${cols} FROM _catalog WHERE (product_id = ?1 OR name = ?1) AND ${PUBLIC} ` +
    "ORDER BY CASE WHEN product_id = ?1 THEN 0 ELSE 1 END LIMIT 1"
  ).bind(id).first();
}

// 무인증 샘플 미리보기 — 고정 5행, 필터 없음, 쿼터 무과금 ("물건을 먼저 보여준다")
const PREVIEW_ROWS = 5;
async function handlePreview(env, id, trace = {}) {
  // 해석 전에는 "요청된 것"을 기록해 둔다 — 400·404 로 끝나는 요청도 무엇을 찾다 못 찾았는지
  // 남아야 한다. 성공하면 아래에서 해석된 물리명으로 덮는다(decision/0003 D-4).
  trace.table = id;
  if (!/^[a-z0-9_]+$/.test(id))
    return problem(400, "invalid id", "제품 id 형식이 아니다");
  // 비공개 제품은 404 로 답한다 — 403 이면 "있긴 있다"를 알려주는 셈이다
  const meta = await lookupProduct(env, id, "*");
  if (!meta) return problem(404, "unknown product", `'${id}' 은 서빙 카탈로그에 없다 — GET /api/v1/catalog 참조`);
  // 조회는 **카탈로그가 준 물리명**으로만 한다 — 요청 문자열을 식별자로 쓰지 않는다
  const table = meta.name;
  trace.table = table;
  // 공개 식별자도 함께 남긴다 — 요청은 별칭(물리명)으로도 들어오므로, 해석된 뒤의
  // `product_id` 여야 같은 제품의 호출이 한 축으로 모인다(decision/0003).
  trace.productId = meta.product_id;
  trace.publicationId = meta.publication_id ?? null;
  // 시간축이 있으면 최신 구간을 보여준다 — 미리보기의 존재 이유는 "실물이 쓸만한가"의 판단
  const availability = await loadProductAvailability(env, meta);
  if (availability.blockers.length) {
    trace.status = 503;
    return productNotReadyResponse(meta, availability.blockers);
  }
  if (availability.availability) {
    trace.rows = 0;
    return json({
      product_id: meta.product_id,
      table,
      preview: true,
      row_count: 0,
      availability: availability.availability,
      rows: [],
    });
  }
  const order = meta.time_axis ? ` ORDER BY "${meta.time_axis}" DESC` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM "${table}"${order} LIMIT ${PREVIEW_ROWS}`
  ).all();
  trace.rows = results.length;
  return json({ product_id: meta.product_id, table, preview: true, row_count: results.length, rows: results });
}

async function handleData(env, id, params, keyRow, trace = {}, opts = {}) {
  trace.table = id;   // handlePreview 와 같은 이유 — 실패 요청도 무엇을 찾았는지 남는다
  if (!/^[a-z0-9_]+$/.test(id))
    return problem(400, "invalid id", "제품 id 형식이 아니다");
  const meta = await lookupProduct(env, id, "*");
  if (!meta) return problem(404, "unknown product", `'${id}' 은 서빙 카탈로그에 없다 — GET /api/v1/catalog 참조`);
  // 아래 SQL 에 들어가는 이름은 여기 하나뿐이다 — 요청 문자열이 아니라 카탈로그가 준 값
  const table = meta.name;
  trace.table = table;
  trace.productId = meta.product_id;   // handlePreview 와 같은 이유
  trace.publicationId = meta.publication_id ?? null;

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
      return problem(400, "no time axis", `'${id}' 은 시간축이 없어 from/to 를 지원하지 않는다`);
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
        `'${id}' 이 그 사이 재발행됐다 — 커서를 버리고 첫 페이지부터 다시 받을 것`,
        { exported_at: meta.exported_at });
    where.push("rowid > ?");
    binds.push(cur.rid);
  }

  // 재배포 권리 게이트(#88 §1-2 B) — 쿼터보다 **앞**이다. 차단은 서빙이 아니므로 무과금이고,
  // MCP `query_product` 가 이 함수를 그대로 쓰므로(mcp.js 의 deps.handleData) 같이 걸린다.
  const rights = await loadRedistributionRights(env, meta.product_id);
  const rightsBlockers = redistributionBlockers(rights);
  if (rightsBlockers.length) {
    trace.status = 503;   // waitUntil 로깅이 실제 응답 코드를 남기게(logStatus 규약)
    return rightsBlockedProblem(meta.product_id, meta.publication_id, rightsBlockers);
  }

  const availability = await loadProductAvailability(env, meta);
  if (availability.blockers.length) {
    trace.status = 503;
    return productNotReadyResponse(meta, availability.blockers);
  }
  if (availability.availability) {
    trace.rows = 0;
    return json({
      product_id: meta.product_id,
      ...(opts.includeMeta ? { product_meta: {
        description: meta.description ?? null,
        freshness: meta.freshness ?? null,
        serving_status: meta.serving_status ?? null,
      } } : {}),
      table,
      row_count: 0,
      limit,
      time_axis: meta.time_axis,
      has_more: false,
      next_cursor: null,
      availability: availability.availability,
      quota_charged: false,
      rows: [],
    });
  }

  // 쿼터는 유효한 요청(실제 서빙 직전)만 소모 — 400/404/409 는 무과금
  const usage = await countUsage(env, keyRow);
  if (usage.exceeded) return quotaExceededProblem(usage.used, usage.quota);

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
    product_id: meta.product_id,
    // MCP data_context 용(#118 리뷰 ②) — 이 함수가 이미 읽은 카탈로그 행을 재사용해
    // 핫패스에 D1 왕복을 안 늘린다. REST 응답 형태는 옵트인이라 그대로다.
    ...(opts.includeMeta ? { product_meta: {
      description: meta.description ?? null,
      freshness: meta.freshness ?? null,
      serving_status: meta.serving_status ?? null,
    } } : {}),
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

// 없는 패턴을 불렀을 때 **무엇을 고르면 되는지**까지 답한다(#204).
//
// 🔴 **검증된 것만 싣는다**(`verified_at IS NOT NULL`) — 미검증을 권하면 다음 호출이 409 로
//    끝난다. 이 기준은 제품 번들의 `runnable`(= `Boolean(verified_at)`, `v1.js`)과 같은 값이다.
// 상한 12: 안내 문장이 읽히는 선. 넘으면 개수만 알린다(MCP 문과 같은 값 — 두 문의 안내가
// 다른 길이로 잘리면 같은 404 를 두 모양으로 배우게 된다).
const MAX_PATTERN_HINT = 12;

async function runnablePatternHint(env, productId) {
  try {
    const res = await env.DB.prepare(
      "SELECT pattern_id FROM d1_usage_patterns " +
      "WHERE product_id = ? AND verified_at IS NOT NULL ORDER BY pattern_id"
    ).bind(productId).all();
    const ids = (res?.results || []).map((r) => r && r.pattern_id).filter(Boolean);
    if (!ids.length) return null;
    const shown = ids.slice(0, MAX_PATTERN_HINT);
    return `실행 가능한 pattern_id: ${shown.join(" · ")}` +
      (ids.length > shown.length ? ` 외 ${ids.length - shown.length}개` : "") +
      " — 이 중 하나를 그대로 쓸 것(이름을 지어내지 말 것)";
  } catch {
    return null;   // 목록은 덤이다 — 이것이 실패해도 404 안내 자체는 나가야 한다
  }
}

// 검증된 질의 패턴 실행 (#118 run_pattern — MCP P1). AI 가 필터를 조립하는 대신 도메인
// 오너가 게시·검증한 SQL(d1_usage_patterns)을 서버가 실행한다 — 질의를 "짓는" 여지가 없다.
//
// 계약(#118 4항): ① 바인딩은 SQL 의 :이름 자리만(선언 밖 파라미터는 400) ② verified_* 있는
// 패턴만 실행 ③ 과금은 query_product 와 동일(쿼터 1회·상한 MAX_LIMIT·권리 게이트 상속,
// 버스트는 tools/call 공통) ④ 응답에 insight_sample_ko(해석 예시) 동봉.
export async function handleRunPattern(env, productId, patternId, userParams, keyRow, trace = {}) {
  trace.productId = productId;
  if (!/^[a-z0-9_]+$/.test(String(productId)) || !/^[a-z0-9_]+$/.test(String(patternId)))
    return problem(400, "invalid id", "product_id·pattern_id 형식이 아니다");
  // 형식 검사를 **통과한 뒤에** 남긴다 — 실패 요청도 무엇을 찾았는지 남아야 하지만
  // (`trace.table = id` 와 같은 이유), 검사 전이면 아무 문자열이나 로그에 실린다.
  // 슬러그 모양만 통과하므로 여기서부터는 값-최소화(0001)를 깨지 않는다.
  // 404·409 로 끝나도 남는다: "무슨 패턴을 부르다 막혔나"가 곧 수요 신호다.
  trace.patternId = patternId;
  // 카탈로그를 먼저 통과한다(#132 사후 리뷰 ①) — 조회 4경로가 전부 같은 문(external=1)을
  // 지나야 한다. 지금은 publisher 가 비공개 제품에 패턴을 안 실어 우연히 안전하지만,
  // 코드가 지키지 않으면 그 우연이 깨지는 날 열린다. 부수로 404 구분(제품/패턴)·
  // 유사 제품 제안·요청 로그(table·publication_id)가 같이 닫힌다.
  const meta = await lookupProduct(env, productId, "*");
  if (!meta)
    return problem(404, "unknown product", `'${productId}' 은 서빙 카탈로그에 없다 — GET /api/v1/catalog 참조`);
  trace.table = meta.name;
  trace.productId = meta.product_id;
  trace.publicationId = meta.publication_id ?? null;
  // 파라미터 메타(P1 기본값·허용값 / P3 타입 선언)는 **별도 표** `d1_pattern_params` 다 —
  // 공유 핸드오프 표는 컬럼 집합 완전일치 검사(handoff_schema_is_current)라 컬럼을 더하면
  // 구 실행기가 되돌린다(#706 d1_catalog_display 전례). 표가 아직 없거나(파이프라인 게시 전)
  // 못 읽으면 **그 조각만 없이** 동작한다 — 기본값 없음 = 전 파라미터 필수(기존 계약 그대로).
  const [pattern, paramMeta] = await Promise.all([
    env.DB.prepare(
      "SELECT sql, question_ko, verified_rows, verified_at, allow_empty, insight_sample_ko " +
      "FROM d1_usage_patterns WHERE product_id = ? AND pattern_id = ?"
    ).bind(productId, patternId).first(),
    env.DB.prepare(
      "SELECT param_defaults, param_enum, params FROM d1_pattern_params " +
      "WHERE product_id = ? AND pattern_id = ?"
    ).bind(productId, patternId).first().catch(() => null),
  ]);
  if (!pattern) {
    // 문구는 **두 독자를 겸한다** — MCP 로 오는 AI 와 `/api/v1/patterns` 로 오는 사람.
    // 🔴 전에는 *"카탈로그의 usage_patterns 에서 runnable 인 것을 고를 것"* 이었는데
    //    **카탈로그 응답에 `runnable` 이 없다**(#204, 2026-08-08 운영에서 404 를 받고 발견).
    //    그 값은 제품 번들이 `Boolean(verified_at)` 로 만든다(`v1.js`) — 가리킨 곳에 없었다.
    // 그래서 **가리키지 않고 목록을 싣는다.** 제품이 가진 pattern_id 는 확정 목록이라
    // 짐작할 여지가 없다. MCP 문은 #187 에서 이미 이렇게 한다(`mcp.js unknownPatternWithList`).
    const hint = await runnablePatternHint(env, productId);
    return problem(404, "unknown pattern",
      `'${patternId}' 는 '${productId}' 의 패턴에 없다 — ` + (hint ||
        `GET /api/v1/products/${productId} 의 usage_patterns 에서 runnable=true 인 것을 고를 것`));
  }
  // 미검증 패턴 실행은 "환각을 서버가 대행"하는 꼴이다(#118 ②) — 검증되면 저절로 열린다
  if (!pattern.verified_at)
    return problem(409, "pattern not verified",
      "아직 검증(verified_*)되지 않은 패턴이라 실행하지 않는다 — 도메인 검증 사이클 후 열린다");

  // 재배포 권리 게이트(#88) — handleData 와 같은 자리·같은 판정. 차단은 무과금.
  const rights = await loadRedistributionRights(env, productId);
  const rightsBlockers = redistributionBlockers(rights);
  if (rightsBlockers.length) {
    trace.status = 503;
    return rightsBlockedProblem(productId, null, rightsBlockers);
  }

  const availability = await loadProductAvailability(env, meta);
  if (availability.blockers.length) {
    trace.status = 503;
    return productNotReadyResponse(meta, availability.blockers);
  }
  if (availability.availability) {
    trace.rows = 0;
    return json({
      product_id: productId,
      pattern_id: patternId,
      question_ko: pattern.question_ko ?? null,
      row_count: 0,
      rows: [],
      availability: availability.availability,
      quota_charged: false,
      insight_sample_ko: pattern.insight_sample_ko ?? null,
      verified: { rows: pattern.verified_rows ?? null, at: pattern.verified_at },
    });
  }

  // 저장된 SQL 만, 그리고 읽기만 — 검증기(serving_verify)와 같은 원칙이다.
  // 변환(주석 제거 → SELECT/WITH 확인 → :이름→? → 값 해석·클램프)은 run-pattern-ext.js 의
  // convertPattern 하나가 맡는다(#217 P1·P3 — prep/run-pattern-ext.mjs 이식본).
  const parseMeta = (raw) => { try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : null; } catch { return null; } };
  const defaults = paramMeta ? parseMeta(paramMeta.param_defaults) : null;
  const enums = paramMeta ? parseMeta(paramMeta.param_enum) : null;
  const spec = paramMeta ? parseMeta(paramMeta.params) : null;
  // REST 쿼리스트링은 문자열뿐이라, 선언이 array 인 파라미터만 JSON 배열 문자열을 실배열로
  // 해석한다(선언 없는 값은 그대로 스칼라 — json_each 관용구 하위 호환). MCP 는 typed JSON.
  const supplied = parseRestArrayParams(
    userParams && typeof userParams === "object" ? userParams : {}, spec);
  const conv = convertPattern(pattern.sql, supplied,
    { defaults: defaults || {}, enums: enums || {}, spec: spec || {}, maxLimit: MAX_LIMIT });
  if (!conv.ok) return problem(conv.problem.status, conv.problem.title, conv.problem.detail);
  const { converted, values } = conv;

  // P0-a(#217 결정): 실행 직전 거부 목록 게이트 — 게이트웨이 자기 표(`_keys`·`_usage`·
  // `d1_migrations` 등)와 `sqlite_*` 를 읽는 패턴은 게시자의 실수이므로 실행하지 않는다.
  // 무과금(400) — countUsage 앞이어야 한다. 허용 목록(P0-b)은 게시 계약과 함께 2차.
  const gate = denyGate(converted);
  if (!gate.ok) {
    trace.status = 400;
    return problem(gate.problem.status, gate.problem.title, gate.problem.detail);
  }

  // 쿼터는 유효한 실행 직전만 소모 — 400/404/409 는 무과금 (query_product 와 같은 규약)
  const usage = await countUsage(env, keyRow);
  if (usage.exceeded) return quotaExceededProblem(usage.used, usage.quota);

  let results;
  try {
    ({ results } = await env.DB.prepare(converted).bind(...values).all());
  } catch (e) {
    // 패턴 SQL 이 게시본과 어긋난 경우(드리프트) — 소비자 잘못이 아니므로 그렇게 말한다
    trace.status = 500;
    // 🔴 **말만 그렇게 하고 요금은 받고 있었다.** `countUsage` 는 읽기가 아니라 증가라
    //    여기 닿은 시점에 이미 하루 몫이 하나 깎여 있다. 게시자가 깨뜨린 패턴을 소비자가
    //    지불하는 꼴이고, 재시도하면 매번 깎인다. §2 의 "쿼터 과금은 유효한 서빙 직전만"
    //    이 400/404/409 만 적어 둬서 이 자리가 새 있었다(ASK-Seoul-Serving#217 검토 중 발견).
    const refunded = await refundUsage(env, keyRow, usage.day);
    return problem(500, "pattern execution failed",
      "패턴이 현재 게시본과 어긋난다(드리프트) — 도메인 검증 사이클에서 잡힐 문제이니 다른 패턴이나 일반 데이터 조회를 쓸 것" +
      // 되돌리기가 실패했으면 **말하지 않는다.** 틀린 안내는 안내가 없는 것보다 나쁘다.
      (refunded ? ". 이 실패는 오늘 쿼터를 소모하지 않았다" : ""),
      refunded ? { quota_charged: false } : {});
  }
  const rows = results.length > MAX_LIMIT ? results.slice(0, MAX_LIMIT) : results;
  trace.rows = rows.length;
  return json({
    product_id: productId,
    pattern_id: patternId,
    question_ko: pattern.question_ko ?? null,
    row_count: rows.length,
    rows,
    // 0행 해석까지 계약이다 — allow_empty 패턴은 빈 결과가 정상 상태다(#638)
    ...(rows.length === 0 ? { empty_note: pattern.allow_empty ? "이 패턴은 빈 결과가 정상일 수 있다(allow_empty)" : "0행 — 조건에 맞는 데이터가 없다(실패 아님)" } : {}),
    insight_sample_ko: pattern.insight_sample_ko ?? null,
    verified: { rows: pattern.verified_rows ?? null, at: pattern.verified_at },
    usage: { used: usage.used, daily_quota: usage.quota },
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

// 기록하는 컬럼 목록은 여기 한 곳에만 둔다 — INSERT 문과 바인딩 순서가 갈리면
// 컬럼 개수 불일치로 INSERT 가 통째로 실패하는데, 그 실패는 `catch` 에 먹혀
// **조용히 전량 유실**된다(0004 미적용으로 실제로 겪었다). scripts/request-log.test.mjs 가
// 이 목록과 실제 스키마를 대조한다.
export const LOG_COLUMNS = [
  "ts", "route", "table_name", "status", "key_hash", "filters", "row_count", "ms",
  "request_id", "product_id", "env", "intent",
  // 행동 로그 (#9 · agreement §3-1) — 원문은 하나도 없다. UA 는 분류 상수로, Referer 는
  // 호스트로, IP 는 아예 안 본다(§3-2). 미배선으로 남는 셋은 아래 주석에 이유를 적었다.
  "ua_class", "agent_name", "agent_mode", "agent_verified", "country", "asn", "referer_host",
  "publication_id", "pattern_id", "page_path",
];

export function logValues(trace, env) {
  return [
    new Date().toISOString(), trace.route, trace.table ?? null, trace.status,
    trace.keyHash ?? null, trace.filterCols ? trace.filterCols.join(",") : null,
    trace.rows ?? null, trace.ms, trace.requestId ?? null,
    trace.productId ?? null,
    // 환경은 워커가 자기 설정에서 읽는다 — 값이 환경을 정하지, 키 이름이 정하지 않는다
    // (ASK-Seoul#78 `Z-7`). 미설정이면 NULL 로 남긴다 — "모른다"를 "local" 로 꾸미지 않는다.
    env.ASK_ENV ?? null,
    // 질문 의도 슬러그(agreement §3-6) — 원문이 아니라 축만. MCP 는 툴 인자로(src/mcp.js),
    // 헤더 제어가 되는 클라이언트는 `X-ASK-Intent` 로 보낸다. 컬럼과 화면은 하나다.
    trace.intent ?? null,
    // 요청 축(#9) — `clientAxes` 가 만든 값 그대로. 라우팅과 무관해 모든 표면에 같이 붙는다.
    // agent_verified 는 0 이 뜻을 갖는 값이다(자칭인데 CF 가 확인 못 함) — `??` 여야 한다.
    // `||` 였으면 0 이 조용히 NULL 로 바뀌어 "검증 실패"가 "검증 안 함"이 된다.
    trace.uaClass ?? null, trace.agentName ?? null, trace.agentMode ?? null,
    trace.agentVerified ?? null,
    trace.country ?? null, trace.asn ?? null, trace.refererHost ?? null,
    // 어느 게시본을 읽었는지 — 제품을 해석한 핸들러만 안다(카탈로그·미리보기·데이터·skill).
    trace.publicationId ?? null,
    // 어느 검증 패턴을 돌렸는지(ASAC-DAG#642) — `run_pattern` 만 채운다. 나머지 경로는
    // 패턴이라는 개념 자체가 없어 NULL 이 맞다(§4-3: 없는 것을 0·'' 로 꾸미지 않는다).
    trace.patternId ?? null,
    // 어느 기계 문서를 읽었는지(#285 · agreement §3-1-1) — `route="page"` 만 채운다.
    // 값은 `LOGGED_PAGES` 셋뿐이고 사람 페이지는 안 넣는다(`/`·`/catalog` 는 부팅에서
    // `/api/v1/catalog` 를 불러 **이미 `route=catalog` 로 세어져** 같은 방문을 두 번 센다).
    trace.pagePath ?? null,
  ];
}

// `0005` 의 22종은 이제 전부 배선됐다 — 미배선으로 남은 컬럼이 없다.
//
// `page_path` 는 마지막 하나였다(#285). 착수를 막던 전제는 `[assets]` 의 `binding` 부재였고
// #238(charset 수정)이 그걸 해소하면서 길이 열렸다 — 워커가 자산을 직접 꺼낼 수 있어야
// `run_worker_first` 에 더한 경로가 problem+json 으로 떨어지지 않는다.
//
// `pattern_id` 는 배선됐다 — "패턴 실행 API 가 아직 없다"가 미룬 이유였고 `run_pattern`(#132)
// 이 그 소비자다. 이걸로 ASAC-DAG#642 의 로깅 키 `(product_id, pattern_id, publication_id)`
// 세 축이 한 행에 모인다.

async function logRequest(env, trace) {
  try {
    await env.DB.prepare(
      `INSERT INTO _gateway_request_log (${LOG_COLUMNS.join(", ")}) ` +
      `VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`
    ).bind(...logValues(trace, env)).run();
    if (Math.random() < LOG_SWEEP_RATE) {
      const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
      await env.DB.prepare("DELETE FROM _gateway_request_log WHERE ts < ?").bind(cutoff).run();
      // 익명 IP 버킷은 주소 수만큼 생긴다 — 창이 지난 행은 남겨 둘 이유가 없다
      const stale = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 16);
      await env.DB.prepare("DELETE FROM _burst WHERE window_start < ?").bind(stale).run();
    }
  } catch {
    // 관측 실패가 응답에 영향을 주면 안 된다 — 조용히 버린다
  }
}

// 한글이 든 정적 텍스트 — **charset 을 우리가 말해야 하는 파일들.**
//
// Assets 가 직접 서빙하면 운영에서 `Content-Type: text/plain` 만 붙고 charset 이 없다.
// 그러면 브라우저가 자기 기본 인코딩(대개 windows-1252)으로 읽어 **한글이 전부 깨진다** —
// `llms.txt` 는 한글이 123줄, `robots.txt` 는 8줄이다(2026-08-09 운영 제보).
//
// 🔴 `_headers` 로는 못 고친다. **덮지 않고 덧붙인다** — 로컬 실측에서
//    `text/plain; charset=utf-8, text/plain; charset=euc-kr` 처럼 값 둘이 콤마로 붙은
//    망가진 헤더가 나왔다. 운영에 나가면 지금보다 나빠진다.
//
// ⚠️ 그리고 **로컬은 이 버그가 안 보인다.** 로컬 workerd 는 `.txt` 에 charset 을 알아서
//    붙여서, 규칙을 넣든 빼든 로컬 응답은 늘 정상이다. 정적 자산의 content-type 은
//    **로컬이 운영의 증거가 되지 않는다** — 이 파일들을 만질 때 그걸 기억한다.
const TEXT_ASSETS = new Set(["/llms.txt", "/robots.txt"]);

// 🔴 관측 대상은 **기계 문서 3종**이고, 워커를 통과하는 4경로와 **다르다**(#285 · #177 §3).
//    `robots.txt` 가 워커를 지나는 건 위의 charset 사고 때문이지 관측 의도가 아니다 —
//    통과 사유와 적재 사유를 섞으면 나중에 "왜 이건 세고 저건 안 세나"를 못 답한다.
//    그리고 크롤러가 주기적으로 치는 파일이라, 세면 "기계가 우리 **데이터 계약**을 읽었다"는
//    신호가 그 잡음에 묻힌다. 범위의 정본은 agreement §3-1-1 이고 넓히려면 그 개정이 먼저다.
//
// 🔑 이 집합이 곧 `page_path` 의 **값 전체**다 — 자유 문자열이 아니라 값 셋짜리 열거형이라,
//    콘솔 카드가 값을 그대로 표시해도 예기치 못한 것이 들어올 자리가 없다(#177 "형식이 곧 화면").
const LOGGED_PAGES = new Set(["/llms.txt", "/openapi.json", "/skill-openapi.json"]);

// 워커가 직접 꺼내 주는 정적 문서 전부(= `run_worker_first` 의 문서 넷).
const WORKER_SERVED_ASSETS = new Set([...TEXT_ASSETS, ...LOGGED_PAGES]);

async function serveAsset(request, env, path) {
  const res = await env.ASSETS.fetch(request);
  // 원본 응답을 그대로 두고 헤더만 바꾼다 — 본문·상태·`_headers` 의 보안 헤더가 다 살아야
  // 한다. `new Response(res.body, res)` 가 그걸 보장한다(헤더 사본이 따라온다).
  const out = new Response(res.body, res);
  // ⚠️ charset 교정은 **텍스트 둘에만** 건다. `.json` 에 `text/plain` 을 씌우면 문서가
  //    깨진다 — JSON 은 규격상 UTF-8 이라 손댈 이유도 없다.
  if (TEXT_ASSETS.has(path)) out.headers.set("content-type", "text/plain; charset=utf-8");
  return out;
}


// ── 채팅 문(#159 · decision/0006) — 상한·인증·제품 찾기. 루프는 chat.js ─────────────
//
// 🔴 무인증 상한이 코드에 있기 전에는 채팅을 무인증에 열지 않는다(0006 게이트) — 이 함수가
//    그 상한이다. 층 순서는 §2 규약 그대로: 버스트(속도) → 하루 몫(비용) → 실행.
async function handleChat(request, env, trace, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid request body", "JSON 본문이 필요하다 — { product_id, question }");
  }
  const productId = String(body?.product_id || "");
  const question = String(body?.question || "").trim();
  if (!productId || !question)
    return problem(400, "missing fields", "product_id 와 question 이 모두 필요하다");
  // 질문 길이 상한 — LLM 비용은 왕복 수만이 아니라 **넣는 길이**로도 자란다. 500자면
  // 사람 질문으로 충분하고, 그 이상은 대개 붙여넣기(문서·코드)라 채팅의 용도가 아니다.
  if (question.length > 500)
    return problem(400, "question too long", "질문은 500자 이내 — 데이터에 대한 질문 하나를 적어 달라");

  // 인증은 **선택**이다(0006 맛보기+키). 헤더가 있으면 정식 인증을 태우고 — 틀린 키에
  // 조용히 익명 취급을 하면 사용자는 자기 키가 죽은 걸 모른다 — 없으면 맛보기다.
  let keyRow = null;
  if (request.headers.get("authorization")) {
    const auth = await authenticate(env, request);
    if (auth.error) return auth.error;
    keyRow = auth.keyRow;
    trace.keyHash = keyRow.key_hash;
  }

  if (keyRow) {
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    // 키 사용자의 채팅 1건 = 기존 일일 쿼터에서 1 (0006 — "기존 쿼터를 그대로 쓴다").
    // LLM 왕복이 실제 비용이므로 질문 자체가 유효한 서빙이다. 패턴 실행은 안에서 따로
    // 과금된다(진짜 데이터 서빙이라 이중이 아니라 각자 몫이다).
    const usage = await countUsage(env, keyRow);
    if (usage.exceeded) return quotaExceededProblem(usage.used, usage.quota);
  } else {
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const burst = await checkBurst(env, "ip:" + ip);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    // IP 몫은 해시 버킷으로 센다 — 분 버킷(위)은 1시간 안에 청소되지만 하루 버킷은 ~하루
    // 산다. 원문 IP 를 그만큼 들고 있지 않는다(0001 값-최소화 — 발급 rate limit 의
    // 일 회전 해시와 같은 판단). 날짜를 소금으로 섞어 날이 바뀌면 같은 IP 도 다른 버킷이다.
    const ipBucket = "chatd:" + (await sha256hex(kstDay() + "|" + ip)).slice(0, 16);
    const perIp = await checkDailyCap(env, ipBucket, CHAT_ANON_DAILY_PER_IP);
    const total = await checkDailyCap(env, "chatd:total", CHAT_ANON_DAILY_TOTAL);
    // 🔴 몫이 다 차면 429 가 아니라 **강등**이다(0006 — "채팅이 죽는 대신 내려앉는다").
    //    LLM 만 안 부르고 후보 제시는 그대로 하므로, 문은 통과시키되 ai 를 안 준다.
    if (perIp.exceeded || total.exceeded) {
      const product = await findChatProduct(env, ctx, productId);
      if (!product) return chatUnknownProduct(productId);
      const r = await runChat({ product, question, tools: TOOLS,
                                ctx: { env, request, keyRow: CHAT_ANON_PRINCIPAL, trace, deps: chatDeps(ctx) } });
      return json({ ...r, reason: "anon_quota_exhausted",
                    message: "오늘 체험 몫이 다 찼습니다. 로그인하시면 계속 쓰실 수 있어요." });
    }
  }

  const product = await findChatProduct(env, ctx, productId);
  if (!product) return chatUnknownProduct(productId);

  // 🔴 여기는 env.AI 유무만 본다. 바인딩이 없으면(아직 안 켬 — 과금 스위치는 별도 PR)
  //    어댑터가 후보 제시로 내려앉는다. 있으면 채택 모델로 감싼 함수 하나를 꽂는다 —
  //    chat.js 는 끝까지 env.AI 를 모른다(테스트 가능성의 근거).
  const ai = env.AI ? (payload) => env.AI.run(CHAT_MODEL, payload) : undefined;
  const r = await runChat({ product, question, ai, tools: TOOLS,
                            ctx: { env, request, keyRow: keyRow ?? CHAT_ANON_PRINCIPAL, trace, deps: chatDeps(ctx) } });
  if (r.degraded && r.reason === "ai_unavailable")
    r.message = "채팅 AI 가 아직 연결되지 않았습니다 — 질문과 비슷한 질의 패턴을 추천해 드려요.";
  return json(r);
}

// 질문 하나로 제품을 찾는다 — 랜딩 챗봇의 첫 답이 여기서 나온다(LLM 없음).
// 🔴 **여기서 `export` 를 붙이지 않는다.** 진입 모듈의 named export 는 workerd 가 전부
//    Workers 엔트리포인트로 검사해서, 숫자를 내보내면 런타임이 아예 안 뜬다(실측:
//    "Incorrect type for map entry 'SEARCH_Q_MAX': not of type 'function or ExportedHandler'").
//    값 자체를 계약으로 고정할 일이 있으면 shared.js 로 옮기거나 동작(400)으로 검증한다.
const SEARCH_Q_MAX = 200;   // 화면 입력 상한과 같은 값(catalog 채팅은 500 — 여긴 실행이 없어 더 짧다)
const SEARCH_LIMIT = 3;     // 후보 셋 — 근거를 붙여 사람이 고르게 한다(하나만 주면 틀렸을 때 길이 없다)

async function handleSearch(env, ctx, q, trace) {
  const query = String(q ?? "").trim();
  // 빈 질의는 400 이다 — 빈 결과로 답하면 "맞는 게 없다"로 읽힌다(모른다 ≠ 없다).
  if (!query) return problem(400, "missing query", "질문을 q 파라미터로 보내 달라 — 예: /api/v1/search?q=주차장 자리 있나");
  if (query.length > SEARCH_Q_MAX)
    return problem(400, "query too long", `질문은 ${SEARCH_Q_MAX}자 이내 — 찾고 싶은 데이터를 한 문장으로 적어 달라`);

  const res = await handleCatalog(env, ctx);
  if (res.status >= 400) return res;   // 카탈로그가 안 서면 검색도 성립하지 않는다 — 그 오류를 그대로 전한다
  const body = await res.json();
  const r = searchProducts(body, query, SEARCH_LIMIT);
  trace.rows = r.matched;   // 몇 건을 찾아 줬나 — "0건이 잦은 질문"이 곧 카탈로그의 구멍 신호다
  return json(r);
}

// 채팅의 도구 실행이 쓰는 shared 핸들러 묶음 — MCP 의 deps 와 같은 조립(내부 HTTP 재호출 없음).
const chatDeps = (ctx) => ({
  handleCatalog: (e) => handleCatalog(e, ctx),
  handlePreview, handleData, handleMe, handleProductBundle, handleRunPattern,
});

// 채팅은 제품이 먼저다(측정 9/10 의 전제) — 카탈로그(캐시)에서 패턴까지 통째로 꺼낸다.
async function findChatProduct(env, ctx, productId) {
  const res = await handleCatalog(env, ctx);
  if (res.status >= 400) return null;
  const { products = [] } = await res.json();
  return products.find((p) => p.product_id === productId) || null;
}

const chatUnknownProduct = (productId) =>
  problem(404, "unknown product",
    `'${productId}' 은 서빙 카탈로그에 없다 — GET /api/v1/catalog 로 목록을 확인할 것`);

async function route(request, env, url, trace, ctx) {
  const path = url.pathname;

  // 정적 문서는 게이트 앞이다 — 키도 쿼터도 없는 공개 문서다.
  // 기계 문서 3종만 `route="page"` 로 센다(#285 · agreement §3-1-1). `page` 는 **SERVE 가
  // 아니다** — 문서 접근은 데이터 서빙이 아니라 관측 축이다(콘솔 decision/0014 §2).
  if (WORKER_SERVED_ASSETS.has(path) && (request.method === "GET" || request.method === "HEAD")) {
    if (LOGGED_PAGES.has(path)) {
      trace.route = "page";
      trace.pagePath = path;      // 화이트리스트를 통과한 경로 원문 — 정규화하지 않는다
    }
    return serveAsset(request, env, path);
  }

  // 폐지된 이메일 발급 경로. **경로 자체는 안내용으로 남긴다** — 지우면 아래 405 분기로
  // 떨어져 "왜 안 되는지"를 못 말하고, 같은 주소의 DELETE 는 살아 있어 더 헷갈린다.
  if (path === "/api/v1/keys" && request.method === "POST") {
    trace.route = "keys";
    return problem(403, "email issuance disabled",
      "이메일 발급은 폐지됐다 — GET /api/v1/auth/google 로 발급받을 것",
      { auth_url: "/api/v1/auth/google" });
  }
  // ── Google OAuth (#110 ②) — 목적은 로그인이 아니라 **이메일 소유 확인**이다 ──────────
  if (path === "/api/v1/auth/google" && request.method === "GET") {
    trace.route = "auth_start";
    return startGoogleAuth(env, url);
  }
  if (path === "/api/v1/auth/google/callback" && request.method === "GET") {
    trace.route = "auth_callback";
    return googleCallback(env, request, url, trace);
  }
  // 회전(#303) — 확인 페이지의 폼이 여기로 POST 한다. **GET 이면 안 된다**: 파괴적 동작이라
  // 주소를 누르거나 미리 가져오기만 해도 실행되면 곤란하다.
  if (path === "/api/v1/keys/rotate") {
    trace.route = "rotate";
    if (request.method !== "POST")
      return problem(405, "method not allowed", "회전은 POST 다 — 확인 페이지의 버튼으로 실행할 것");
    return rotateKey(env, request, url, trace);
  }
  if (path === "/api/v1/keys" && request.method === "DELETE") {
    // 🔴 **폐기와 완전삭제를 가른다** (#320 Phase 0). 예전엔 둘 다 `revoke` 로 찍혀
    //    **완전삭제가 쓰이고 있는지조차 몰랐다** — 무엇을 고칠지 정하는 근거가 없었다.
    //    ⚠️ `route` 값은 콘솔과의 공유 계약이라 값을 늘리면 콘솔 담당에게 통지한다(0001).
    const purge = url.searchParams.get("purge") === "true";
    trace.route = purge ? "purge" : "revoke";
    const { keyRow, error } = await authenticate(env, request, { allowRevoked: true });
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    return revokeKey(env, keyRow, purge);
  }
  // 채팅 — 질문 하나를 검증된 패턴 실행으로 (#159 · decision/0006). 루프는 chat.js,
  // 여기는 문(상한·인증·제품 찾기)만 지킨다.
  if (path === "/api/v1/chat" && request.method === "POST") {
    trace.route = "chat";
    return handleChat(request, env, trace, ctx);
  }
  // MCP 서버 — Streamable HTTP, stateless POST /mcp (#26 P0). shared 핸들러 재사용(내부 HTTP X).
  if (path === "/mcp") {
    // `Allow` 는 405 의 필수 헤더다(RFC 9110 §15.5.6). 없으면 "무엇으로 다시 걸어야 하나"를
    // 클라이언트가 못 읽는다 — SSE 스트림을 열려고 `GET /mcp` 를 먼저 두드리는 호스트가
    // 여기서 막히면 지원 여부를 판단할 근거가 응답에 없다.
    if (request.method !== "POST")
      return problem(405, "method not allowed", "MCP 는 POST /mcp (Streamable HTTP)", {},
        { allow: "POST, OPTIONS" });
    trace.route = "mcp";
    return handleMcp(request, env, trace, {
      authenticate, checkBurst,
      // ctx 를 물려 SWR 캐시가 살게 한다(#118 리뷰 ③) — 안 물리면 404 제안 경로의 캐시
      // 미스가 오류 경로에서 동기 D1 5회가 된다.
      handleCatalog: (e) => handleCatalog(e, ctx),
      handlePreview, handleData, handleMe, handleProductBundle, handleRunPattern,
    });
  }
  if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용 API (폐기는 DELETE /api/v1/keys)");
  if (path === "/api/v1/catalog") { trace.route = "catalog"; return handleCatalog(env, ctx); }

  // 질문 문장 → 맞는 제품 찾기 (#159 후속 — 랜딩 챗봇의 1단계).
  //
  // 🔴 **데이터를 조회하지 않는다.** 카탈로그를 읽어 "어느 제품이 답할 수 있나"만 답하므로
  //    무인증·무과금이고 LLM 도 안 부른다. 랜딩 방문마다 도는 자리라 그게 전제다 —
  //    여기서 LLM 을 부르면 구경꾼이 무인증 채팅 몫(100/일)을 다 태운다.
  // 🔴 검색기는 `mcp.js` 의 `search_products` 와 **같은 함수**다(agent-tools). 사본을 만들면
  //    사람이 보는 순위와 AI 가 보는 순위가 갈린다.
  if (path === "/api/v1/search") {
    trace.route = "search";
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const burst = await checkBurst(env, "ip:" + ip);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    return handleSearch(env, ctx, url.searchParams.get("q"), trace);
  }

  const previewMatch = path.match(/^\/api\/v1\/preview\/([^/]+)$/);
  if (previewMatch) {
    trace.route = "preview";
    // 익명 경로라 셀 식별자가 IP 밖에 없다 — 키 버킷과 같은 상한을 쓴다
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const burst = await checkBurst(env, "ip:" + ip);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    return handlePreview(env, decodeURIComponent(previewMatch[1]), trace);
  }

  const dataMatch = path.match(/^\/api\/v1\/data\/([^/]+)$/);
  if (dataMatch || path === "/api/v1/me") {
    trace.route = dataMatch ? "data" : "me";
    const { keyRow, error } = await authenticate(env, request);
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    // 버스트는 쿼터보다 **앞**에서 본다 — 400·404 로 끝날 요청도 서버를 미는 건 같다
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    if (path === "/api/v1/me") return handleMe(env, keyRow);
    return handleData(env, decodeURIComponent(dataMatch[1]), url.searchParams, keyRow, trace);
  }

  // 검증 패턴 실행 — **사람용 문**. 로직은 `handleRunPattern` 하나이고 MCP 와 공유한다(#118).
  // 왜 문을 따로 내나: 지금까지 이 기능은 `POST /mcp` 로만 닿아, **AI 는 155개 검증 패턴을
  // 돌리는데 우리 화면에 온 사람은 못 돌렸다.** 브라우저가 `/mcp` 를 부를 수도 있지만
  // ① 툴 설명·오류 문구가 AI 를 겨냥해 쓰여 있고 ② 우리 화면 클릭이 MCP 사용량에 섞이며
  // ③ 화면이 남의 프로토콜 계약에 묶인다. 문을 가르면 셋 다 안 생긴다.
  //
  // GET 인 이유: 이 아래는 전부 조회 전용(위 405 가드)이라 예외를 안 판다. 덤으로
  // **URL 이 곧 질의**라 "이 조회 해보세요"를 링크로 주고받을 수 있다.
  // 쿼터·권리 게이트·미검증 409 는 `handleRunPattern` 안에 이미 있다 — 여기선 키와
  // 버스트만 본다(`/api/v1/data` 와 같은 순서: 버스트가 쿼터보다 앞).
  //
  // 🔴 route 값 `run_pattern` 은 콘솔 계약(ops-dashboard `decision/0014`)에 **없던 값**이다.
  //    거기 `SERVE_ROUTES` 배열과 `ROUTE_KO` 표에 같이 올라야 한다 — 안 오르면 데이터를
  //    돌려주는 문인데 SERVE 로 안 세어지고, 화면에는 영문 그대로 뜬다. `mcp_run_pattern`
  //    때 **배포가 반영보다 먼저 나간 사고**(#132→PR#138)가 정확히 이 순서 문제였다.
  const patternMatch = path.match(/^\/api\/v1\/patterns\/([^/]+)\/([^/]+)$/);
  if (patternMatch) {
    trace.route = "run_pattern";
    const { keyRow, error } = await authenticate(env, request);
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);
    // 쿼리스트링이 곧 패턴 파라미터다(`:이름` 자리와 1:1). 선언 밖 이름은 400 으로 막힌다.
    return handleRunPattern(env, decodeURIComponent(patternMatch[1]),
      decodeURIComponent(patternMatch[2]), Object.fromEntries(url.searchParams), keyRow, trace);
  }

  // ── /skill/v1 — seoul-weather-risk K-Skill 전용 API ──────────────────────
  // 제품 선택·응답 계약은 `/api/v1` 과 분리하지만, 키·버스트·오류·로그 정책은
  // 공유한다. K-Skill 신규 경로는 전부 Bearer 인증이며 메타 조회는 쿼터를 소모하지 않는다.
  if (path.startsWith("/skill/v1/")) {
    const bundlePath = `/skill/v1/bundles/${SKILL_BUNDLE_ID}`;
    const dataMatch = path.match(/^\/skill\/v1\/products\/([^/]+)\/data$/);
    const productMatch = path.match(/^\/skill\/v1\/products\/([^/]+)$/);
    if (path !== bundlePath && !dataMatch && !productMatch)
      return problem(404, "not found",
        `GET ${bundlePath} · /skill/v1/products/<product_id> · /skill/v1/products/<product_id>/data`);

    trace.route = path === bundlePath ? "skill_bundle" : dataMatch ? "skill_data" : "skill_product";
    const { keyRow, error } = await authenticate(env, request, { requiredScope: SKILL_SERVICE_SCOPE });
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);

    if (path === bundlePath) return handleSkillBundle(env, trace);
    const productId = decodeURIComponent((dataMatch || productMatch)[1]);
    return dataMatch
      ? handleSkillData(env, productId, url.searchParams, keyRow, trace)
      : handleSkillProduct(env, productId, trace);
  }

  // ── 옛 `/v1/*` 에서 흡수한 둘 (agreement §10 · decision/0004 D-2) ─────────────
  // 표면은 접고 **기능은 `/api/v1` 아래로 옮겼다.** 지우지 않는 이유가 각각 있다:
  // 제품 번들은 `column-docs.json`(손 갱신 사본, 계약과 어긋난 실사고가 있었다)의 퇴역
  // 경로이고, 용어 사전은 `d1_catalog_glossary` 를 읽는 **유일한 문**이다(commerce 가 지금도
  // 게시한다 — ASAC-DAG `common/serving/d1_client.py` 외 4).
  //
  // 인증·쿼터 정책은 옛 문 그대로다: **전 경로 Bearer**(#638), 메타 조회는 버스트만 적용하고
  // 일일 쿼터를 소모하지 않는다 — 데이터가 아니라 판단 재료이고, 소비 순서상 데이터 호출
  // 앞에 반드시 오는 단계라 여기서 깎으면 정작 쓸 몫이 준다.
  const bundleMatch = path.match(/^\/api\/v1\/products\/([^/]+)$/);
  if (bundleMatch || path === "/api/v1/glossary") {
    trace.route = bundleMatch ? "product" : "glossary";
    const { keyRow, error } = await authenticate(env, request);
    if (error) return error;
    trace.keyHash = keyRow.key_hash;
    const burst = await checkBurst(env, "k:" + keyRow.key_hash);
    if (burst.exceeded) return burstProblem(burst.retryAfter);

    return bundleMatch
      ? handleProductBundle(env, decodeURIComponent(bundleMatch[1]), request, trace)
      : handleGlossary(env, url.searchParams.get("vocabulary_id"), trace);
  }

  return problem(404, "not found",
    "GET /api/v1/catalog · /api/v1/preview/<table> · /api/v1/data/<table> · /api/v1/me · " +
    "/api/v1/products/<product_id> · /api/v1/patterns/<product_id>/<pattern_id> · " +
    "/api/v1/glossary, POST·DELETE /api/v1/keys, POST /api/v1/keys/rotate · " +
    "GET /skill/v1/bundles/seoul-weather-risk, POST /mcp — 문법·한도 안내는 GET /llms.txt (사람용 문서 /docs)");
}

/**
 * 로그에 남길 상태 — **핸들러가 정해 둔 값이 있으면 그게 결과의 뜻이다.**
 *
 * HTTP 상태가 곧 결과인 표면(`/api/v1`·`/skill/v1`·`/v1`)에서는 `trace.status` 가 비어 있어
 * 그대로 응답 상태를 쓴다. MCP 는 다르다 — JSON-RPC 는 오류도 봉투에 담아 HTTP 는 200 이라,
 * 응답 상태만 믿으면 **인증 실패·404·429·503 이 전부 `mcp/200` 으로 남는다.** 그러면 콘솔의
 * 오류율이 영원히 0 이 되는데, 이건 관측 공백이 아니라 **틀린 값**이다(#62 · agreement §4).
 */
export const logStatus = (trace, res) => trace.status ?? res.status;

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
          // 🔴 **MCP 가 규격으로 요구하는 헤더들이 빠져 있었다**(2026-08-13). 사양은
          // 협상 뒤 모든 요청에 `MCP-Protocol-Version` 을 실으라고 하는데, 브라우저에서
          // 도는 MCP 호스트는 프리플라이트에서 그 이름을 허용받지 못하면 **본 요청을 아예
          // 보내지 않는다** — 서버 로그에는 아무것도 안 남고 호스트에는 "도구 0개"로 보인다.
          // `Mcp-Session-Id`·`Last-Event-ID` 는 우리가 stateless 라 쓰지 않지만, 클라이언트가
          // 실어 보내는 것을 막을 이유는 없다(막으면 그쪽이 실패한다).
          "access-control-allow-headers":
            "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          // 응답 헤더는 **노출을 따로 허용**해야 스크립트가 읽는다. 세션 헤더를 안 쓰더라도
          // `x-request-id` 는 장애 문의의 유일한 실마리라 읽히게 둔다.
          "access-control-expose-headers": "mcp-session-id, x-request-id",
          "access-control-max-age": "86400",
        },
      });

    const started = Date.now();
    // 요청 축은 라우팅 **전에** 뽑는다 — 401·404 로 끝난 요청도 "누가 두드렸나"는 남아야
    // 한다(그게 남용 판정의 재료다). 순수 계산이라 D1 도 안 만진다.
    const axes = clientAxes(request);
    const trace = {
      route: null, requestId: newRequestId(),
      uaClass: axes.ua_class, agentName: axes.agent_name, agentMode: axes.agent_mode,
      agentVerified: axes.agent_verified,
      country: axes.country, asn: axes.asn, refererHost: axes.referer_host,
      // 헤더로 온 의도. MCP 는 툴 인자로 받아 이 값을 덮어쓴다 — 질의마다 바뀌는 쪽이
      // 더 정확하기 때문이다(agreement §3-6: 경로는 둘, 컬럼은 하나).
      intent: normalizeIntent(request.headers.get("x-ask-intent")),
    };
    let res = await route(request, env, url, trace, ctx);

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
      trace.status = logStatus(trace, res);
      trace.ms = Date.now() - started;
      const write = logRequest(env, trace);
      if (ctx && ctx.waitUntil) ctx.waitUntil(write);  // 응답을 붙잡지 않는다
    }
    return res;
  },
};
