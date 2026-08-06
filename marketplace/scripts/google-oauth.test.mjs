// Google OAuth 순수 로직 테스트 (#110 ②) — 실행: npm test
//
// 네트워크를 타는 부분(exchangeCode)은 여기서 안 본다. 여기서 지키는 것은 **신원 판정**이다 —
// 이 이슈의 전부가 "확인된 이메일만 통과시킨다" 이므로, 그 판정이 느슨해지는 순간 발급 폼
// 시절로 돌아간다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeState, verifyState, readIdTokenFromTokenEndpoint,
  authorizeUrl, isConfigured, readCookie, stateCookie,
} from "../src/google-oauth.js";

const SECRET = "test-salt-not-a-real-secret";
const CLIENT = "1234.apps.googleusercontent.com";
const NOW = 1_800_000_000;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
const ok = {
  iss: "https://accounts.google.com", aud: CLIENT,
  exp: NOW + 3600, email: "Someone@Example.COM", email_verified: true,
};

// ── state (CSRF) ─────────────────────────────────────────────────────────────
test("우리가 만든 state 는 통과한다", async () => {
  assert.equal(await verifyState(SECRET, await makeState(SECRET, NOW), NOW), true);
});

test("남이 만든 state 는 막힌다 — 서명이 안 맞는다", async () => {
  const mine = await makeState(SECRET, NOW);
  assert.equal(await verifyState("다른-비밀값", mine, NOW), false);
});

test("state 는 늙으면 막힌다 — 재생 창을 좁힌다", async () => {
  const s = await makeState(SECRET, NOW);
  assert.equal(await verifyState(SECRET, s, NOW + 599), true);
  assert.equal(await verifyState(SECRET, s, NOW + 601), false);
});

test("미래에서 온 state 도 막힌다 — 시계를 앞당겨 만든 값", async () => {
  assert.equal(await verifyState(SECRET, await makeState(SECRET, NOW + 3600), NOW), false);
});

test("모양이 깨진 state 는 막힌다", async () => {
  for (const bad of ["", null, undefined, "a.b", "a.b.c.d", "....", "notastate"])
    assert.equal(await verifyState(SECRET, bad, NOW), false, `입력: ${JSON.stringify(bad)}`);
});

// ── ID 토큰 ──────────────────────────────────────────────────────────────────
test("정상 토큰은 이메일을 소문자로 정규화해 돌려준다", () => {
  const r = readIdTokenFromTokenEndpoint(idToken(ok), { clientId: CLIENT, nowSec: NOW });
  assert.equal(r.error, undefined);
  assert.equal(r.email, "someone@example.com");
});

// 🔴 이 이슈의 핵심. 이게 통과하면 발급 폼 시절과 똑같아진다.
test("email_verified 가 true 가 아니면 거절한다 — 이 이슈의 전부다", () => {
  for (const v of [false, undefined, null, "true", 1]) {
    const r = readIdTokenFromTokenEndpoint(
      idToken({ ...ok, email_verified: v }), { clientId: CLIENT, nowSec: NOW });
    assert.equal(r.error, "email not verified", `email_verified=${JSON.stringify(v)}`);
    assert.equal(r.email, undefined);
  }
});

test("남의 앱에서 받아 온 토큰은 거절한다 — aud 불일치", () => {
  const r = readIdTokenFromTokenEndpoint(
    idToken({ ...ok, aud: "9999.apps.googleusercontent.com" }), { clientId: CLIENT, nowSec: NOW });
  assert.equal(r.error, "audience mismatch");
});

test("발급자가 Google 이 아니면 거절한다", () => {
  const r = readIdTokenFromTokenEndpoint(
    idToken({ ...ok, iss: "https://evil.example" }), { clientId: CLIENT, nowSec: NOW });
  assert.equal(r.error, "unexpected issuer");
});

test("만료된 토큰은 거절한다", () => {
  const r = readIdTokenFromTokenEndpoint(idToken({ ...ok, exp: NOW - 1 }), { clientId: CLIENT, nowSec: NOW });
  assert.equal(r.error, "expired id_token");
});

test("이메일이 없으면 거절한다 — 발급할 신원이 없다", () => {
  const { email, ...noEmail } = ok;
  const r = readIdTokenFromTokenEndpoint(idToken(noEmail), { clientId: CLIENT, nowSec: NOW });
  assert.equal(r.error, "no email in id_token");
});

test("모양이 깨진 토큰은 거절한다 — 던지지 않고 error 로 돌려준다", () => {
  for (const bad of ["", null, "a.b", "not.a.jwt", `${b64url({})}.@@@.sig`])
    assert.ok(readIdTokenFromTokenEndpoint(bad, { clientId: CLIENT, nowSec: NOW }).error,
      `입력: ${JSON.stringify(bad)}`);
});

// ── 흐름·설정 ────────────────────────────────────────────────────────────────
test("설정이 반쪽이면 미설정으로 본다 — 반만 켜진 상태로 돌지 않게", () => {
  assert.equal(isConfigured({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }), true);
  assert.equal(isConfigured({ GOOGLE_CLIENT_ID: "a" }), false);
  assert.equal(isConfigured({ GOOGLE_CLIENT_SECRET: "b" }), false);
  assert.equal(isConfigured({ GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "b" }), false);
  assert.equal(isConfigured({}), false);
});

test("authorize URL 은 최소 스코프만 요구한다 — 이름·사진은 쓸 데가 없다", () => {
  const u = new URL(authorizeUrl({ clientId: CLIENT, redirect: "https://x.test/cb", state: "s1" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), "openid email");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), CLIENT);
  assert.equal(u.searchParams.get("redirect_uri"), "https://x.test/cb");
  assert.equal(u.searchParams.get("state"), "s1");
  // 공용 PC 에서 앞사람 계정으로 조용히 발급되는 것을 막는다
  assert.equal(u.searchParams.get("prompt"), "select_account");
});

test("state 쿠키는 JS 가 못 읽고, https 일 때만 Secure 를 붙인다", () => {
  const https = stateCookie("v", new URL("https://ask-seoul.kr/x"));
  assert.match(https, /HttpOnly/);
  assert.match(https, /SameSite=Lax/);
  assert.match(https, /; Secure/);
  // 로컬 http 에 Secure 를 붙이면 쿠키가 저장되지 않아 흐름이 통째로 끊긴다
  assert.doesNotMatch(stateCookie("v", new URL("http://localhost:8787/x")), /Secure/);
});

test("쿠키 파싱 — 같은 이름의 접두가 겹쳐도 정확히 집는다", () => {
  assert.equal(readCookie("a=1; ask_oauth_state=xyz; b=2", "ask_oauth_state"), "xyz");
  assert.equal(readCookie("ask_oauth_state_other=nope", "ask_oauth_state"), null);
  assert.equal(readCookie("", "ask_oauth_state"), null);
  assert.equal(readCookie(null, "ask_oauth_state"), null);
});
