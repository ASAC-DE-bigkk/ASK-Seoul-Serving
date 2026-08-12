// 완전삭제가 재발급 상한의 우회로가 되지 않게 (#320).
//
// 🔴 **이 파일이 지키는 사실 하나**: 재발급 상한(하루 5회)은 오너가 *"사용자가 임의로 계속
//    키를 무한 재발급 받을 수 있는 구조 아니냐"* 고 물어 생긴 장치인데, 그 카운터가
//    `_keys` 행에 얹혀 있었고 완전삭제(`?purge=true`)가 그 행을 지웠다. 그래서
//
//        남용 → 완전삭제 → 재로그인 → **신규 발급**(회전이 아니라) → 반복
//
//    이 되어 **상한이 막으려던 바로 그 행동으로 상한이 사라졌다.** 남는 제동은 발급 IP
//    시간당 5회뿐이고 IP 는 바꾸기 쉽다.
//
// 그래서 카운터를 이메일 해시를 키로 하는 `_issuance_guard` 로 옮겼다. 아래는 그 계약이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeState, STATE_COOKIE } from "../src/google-oauth.js";

const SALT = "test-salt-not-a-real-secret";
const EMAIL = "someone@example.com";
const KEY = "ask_" + "b".repeat(32);
const KEY_HASH = "c".repeat(64);
const ENV = {
  GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "shh",
  ISSUANCE_SALT: SALT,
  ASK_ENV: "dev",
};
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// Google 토큰 엔드포인트를 세운다. `readIdTokenFromTokenEndpoint` 는 **서명을 검증하지
// 않는다**(TLS 로 직접 받은 토큰이라는 전제) — 그래서 payload 만 맞으면 된다.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
globalThis.fetch = async () => new Response(JSON.stringify({
  id_token: "x." + b64url({
    iss: "https://accounts.google.com", aud: ENV.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600, email: EMAIL, email_verified: true,
  }) + ".y",
}), { headers: { "content-type": "application/json" } });

// keyRow=null 이면 "완전삭제하고 돌아온 사람"이다 — 이 파일의 주인공.
function fixtureDb({ guard = null, keyRow = null, issuedThisHour = 0 } = {}) {
  const seen = { batches: [], logBinds: null };
  return {
    seen,
    prepare(sql) {
      const stmt = (b) => ({
        async first() {
          if (sql.includes("FROM _issuance_guard")) return guard;
          if (sql.includes("FROM _keys WHERE email")) return keyRow;
          if (sql.includes("FROM _keys WHERE key_hash")) return keyRow;
          return null;
        },
        async all() {
          if (sql.includes("FROM _issuance_log")) return { results: [{ n: issuedThisHour }] };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO _gateway_request_log")) seen.logBinds = b;
          return {};
        },
        _sql: sql, _bind: b,
      });
      return { bind: (...b) => stmt(b), ...stmt([]) };
    },
    async batch(list) {
      seen.batches.push(list.map((s) => ({ sql: s._sql, bind: s._bind })));
      return list.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

async function callback(db) {
  const state = await makeState(SALT, Math.floor(Date.now() / 1000));
  const pending = [];
  const res = await worker.fetch(
    new Request(`https://m.example.test/api/v1/auth/google/callback?code=abc&state=${state}`,
      { headers: { cookie: `${STATE_COOKIE}=${state}` } }),
    { ...ENV, DB: db }, { waitUntil: (p) => pending.push(p) });
  await Promise.allSettled(pending);
  return res;
}

async function del(db, qs = "") {
  const pending = [];
  const res = await worker.fetch(
    new Request("https://m.example.test/api/v1/keys" + qs,
      { method: "DELETE", headers: { authorization: "Bearer " + KEY } }),
    { ...ENV, DB: db }, { waitUntil: (p) => pending.push(p) });
  await Promise.allSettled(pending);
  return res;
}

const guardWrite = (db) =>
  db.seen.batches.at(-1)?.find((s) => s.sql.includes("INSERT INTO _issuance_guard"));

// ── 발급 경로 ────────────────────────────────────────────────────────────────

test("🔴 완전삭제하고 돌아와도 상한은 살아 있다 — 이게 이 변경의 전부다", async () => {
  // 키 행은 없다(완전삭제됨). 그런데 가드에 오늘 5회가 남아 있다.
  const db = fixtureDb({ keyRow: null, guard: { day: today(), count: 5 } });
  const res = await callback(db);
  assert.equal(res.status, 429, "완전삭제가 상한의 우회로가 됐다");
  assert.equal(db.seen.batches.length, 0, "상한에 걸렸는데 키를 발급했다");
  assert.match(await res.text(), /하루 5번/);
});

test("완전삭제 뒤 재발급은 한 칸을 쓴다 — 신규 발급으로 위장되지 않는다", async () => {
  const db = fixtureDb({ keyRow: null, guard: { day: today(), count: 2 } });
  const res = await callback(db);
  assert.equal(res.status, 201);
  assert.equal(guardWrite(db).bind[2], 3, "재발급인데 카운터가 안 올랐다");
});

test("첫 발급은 자리만 만든다(0) — 처음 받은 사람이 4번만 쓰면 안 된다", async () => {
  const db = fixtureDb({ keyRow: null, guard: null });
  const res = await callback(db);
  assert.equal(res.status, 201);
  const g = guardWrite(db);
  assert.ok(g, "가드를 아예 안 만들면 다음 완전삭제가 또 우회로가 된다");
  assert.equal(g.bind[2], 0, "첫 발급을 재발급 1회로 셌다");
});

test("어제 다 썼어도 오늘은 새로 센다", async () => {
  const db = fixtureDb({ keyRow: null, guard: { day: "2020-01-01", count: 5 } });
  assert.equal((await callback(db)).status, 201);
  assert.equal(guardWrite(db).bind[2], 1);
});

test("30일 청소가 발급과 같은 batch 에 붙어 있다 — 별도 스케줄러는 안 도는 걸 모른다", async () => {
  const db = fixtureDb({ keyRow: null, guard: null });
  await callback(db);
  assert.ok(db.seen.batches.at(-1).some((s) => s.sql.includes("DELETE FROM _issuance_guard")));
});

test("🔴 가드에 이메일 원문이 들어가지 않는다 — 해시만 남긴다", async () => {
  const db = fixtureDb({ keyRow: null, guard: null });
  await callback(db);
  for (const s of db.seen.batches.at(-1))
    if (s.sql.includes("_issuance_guard"))
      for (const v of s.bind || [])
        assert.notEqual(String(v), EMAIL, "가드에 이메일 원문이 실렸다");
});

// ── 삭제 경로 ────────────────────────────────────────────────────────────────

test("🔴 완전삭제는 가드를 지우지 않는다 — 지우면 우회로가 그대로 남는다", async () => {
  const db = fixtureDb({ keyRow: { key_hash: KEY_HASH, key_prefix: "ask_bbbb", email: EMAIL, status: "active" } });
  const res = await del(db, "?purge=true");
  assert.equal(res.status, 200);
  const batch = db.seen.batches.at(-1);
  assert.ok(batch.some((s) => s.sql.includes("DELETE FROM _keys")), "키 행은 지워야 한다");
  assert.ok(!batch.some((s) => s.sql.includes("_issuance_guard")),
    "완전삭제가 상한 카운터까지 지웠다 — 삭제권을 지키느라 우회로를 열었다");
});

test("완전삭제 응답이 무엇이 남는지 밝힌다 — 지웠다고만 하면 사실과 다르다", async () => {
  const db = fixtureDb({ keyRow: { key_hash: KEY_HASH, key_prefix: "ask_bbbb", email: EMAIL, status: "active" } });
  const body = await (await del(db, "?purge=true")).json();
  assert.equal(body.purged, true);
  assert.match(body.note, /재발급 횟수/, "남는 것을 안 밝히면 안내가 틀린 것이다");
});

test("🔴 폐기와 완전삭제가 로그에서 갈린다 — 안 가르면 쓰이는지조차 모른다", async () => {
  const row = { key_hash: KEY_HASH, key_prefix: "ask_bbbb", email: EMAIL, status: "active" };
  const plain = fixtureDb({ keyRow: row });
  await del(plain);
  const purged = fixtureDb({ keyRow: row });
  await del(purged, "?purge=true");
  // LOG_COLUMNS 순서: ts, route, …
  assert.equal(plain.seen.logBinds[1], "revoke");
  assert.equal(purged.seen.logBinds[1], "purge");
});
