// 로그인 뒤 회전(재발급) 경로 (#303).
//
// 🔴 **이 경로가 없으면 키를 잃은 사람은 잠긴다.** 발급은 OAuth 뿐인데 이미 키가 있으면
//    409 였고, 폐기에는 그 키가 필요했다 — 못 하는 일을 시키고 있었다. 그래서 여기서
//    지키는 것은 "된다"가 아니라 **어떤 조건에서 되는가**다:
//      ① 티켓이 있어야 한다(= Google 로 소유를 증명하고 확인 버튼을 눌렀다)
//      ② 티켓은 **한 번만** 먹는다(현재 해시에 묶여 있다)
//      ③ **오늘 쓴 양이 새 키로 이월된다** — 아니면 재발급이 곧 쿼터 초기화다
//      ④ 계정당 하루 상한이 있다 — IP 상한만으로는 공유 IP 에서 남의 몫을 갉아먹는다
//      ⑤ GET 으로는 안 된다 — 파괴적 동작이 주소 하나로 실행되면 안 된다
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeRotateTicket } from "../src/google-oauth.js";

const SALT = "test-salt-not-a-real-secret";
const OLD = "c".repeat(64);
const ENV = {
  GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "shh",
  ISSUANCE_SALT: SALT,
  ASK_ENV: "dev",
};

// D1 스텁 — 회전이 실제로 **무엇을 쓰는지**를 본다. 배치에 담긴 문장이 이 테스트의 관찰 대상이다.
function fixtureDb({ row = { key_hash: OLD, rotated_day: null, rotated_count: 0 }, issuedThisHour = 0 } = {}) {
  const seen = { batches: [], binds: [] };
  return {
    seen,
    prepare(sql) {
      const stmt = (b) => ({
        async first() {
          if (sql.includes("FROM _keys WHERE key_hash")) return row;
          return null;
        },
        async all() {
          if (sql.includes("FROM _issuance_log")) return { results: [{ n: issuedThisHour }] };
          return { results: [] };
        },
        async run() { return {}; },
        _sql: sql, _bind: b,
      });
      return { bind: (...b) => { seen.binds.push({ sql, b }); return stmt(b); }, ...stmt([]) };
    },
    async batch(list) { seen.batches.push(list.map((s) => ({ sql: s._sql, bind: s._bind }))); return []; },
  };
}

const rotate = async (db, body, { method = "POST" } = {}) => {
  const pending = [];
  const res = await worker.fetch(
    new Request("https://m.example.test/api/v1/keys/rotate", {
      method,
      headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {},
      body: method === "POST" ? body : undefined,
    }),
    { ...ENV, DB: db }, { waitUntil: (p) => pending.push(p) });
  await Promise.allSettled(pending);
  return res;
};
const ticketBody = async (hash = OLD) =>
  new URLSearchParams({ ticket: await makeRotateTicket(SALT, hash, Math.floor(Date.now() / 1000)) });

test("🔴 ⑤ GET 으로는 회전되지 않는다 — 주소 하나로 실행되면 안 된다", async () => {
  const res = await rotate(fixtureDb(), null, { method: "GET" });
  assert.equal(res.status, 405);
});

test("🔴 ① 티켓이 없거나 상하면 회전하지 않는다", async () => {
  for (const body of [new URLSearchParams(), new URLSearchParams({ ticket: "아무거나" })]) {
    const res = await rotate(fixtureDb(), body);
    assert.equal(res.status, 400, "티켓 없이 통과했다");
  }
});

test("티켓이 맞으면 새 키를 한 번 보여 준다", async () => {
  const db = fixtureDb();
  const res = await rotate(db, await ticketBody());
  assert.equal(res.status, 201);
  const html = await res.text();
  assert.match(html, /ask_[a-z0-9]+/, "새 키가 화면에 안 나온다");
  assert.match(html, /이전 키는 <strong>이제 무효<\/strong>/, "옛 키가 죽는다는 말을 안 한다");
  // 쿠키는 역할이 끝났으니 지운다 — 남기면 다음 사람이 같은 브라우저에서 이어받는다
  assert.match(String(res.headers.get("set-cookie")), /ask_oauth_state=;|Max-Age=0/);
});

test("🔴 ③ 오늘 쓴 양을 새 키로 이월한다 — 아니면 재발급이 곧 쿼터 초기화다", async () => {
  const db = fixtureDb();
  await rotate(db, await ticketBody());
  const batch = db.seen.batches.at(-1);
  const carry = batch.find((s) => s.sql.includes("INSERT INTO _usage"));
  assert.ok(carry, "사용량 이월 문장이 없다 — 회전할 때마다 한도가 리셋된다");
  assert.match(carry.sql, /SELECT \?, day, count FROM _usage WHERE key_hash = \? AND day = \?/);
  assert.equal(carry.bind[1], OLD, "옛 해시에서 가져와야 한다");
  // 이월이 키 교체보다 **먼저** 와야 한다 — 뒤에 오면 그 사이 요청이 새 해시에 세어져 덮인다
  assert.ok(batch.findIndex((s) => s.sql.includes("INSERT INTO _usage"))
          < batch.findIndex((s) => s.sql.includes("UPDATE _keys")), "이월이 교체보다 뒤에 있다");
});

test("🔴 행을 제자리에서 갈아 끼운다 — `_keys.email` 이 UNIQUE 라 새 행을 못 넣는다", async () => {
  const db = fixtureDb();
  await rotate(db, await ticketBody());
  const upd = db.seen.batches.at(-1).find((s) => s.sql.includes("UPDATE _keys"));
  assert.ok(upd, "키 교체 문장이 없다");
  assert.match(upd.sql, /status = 'active'/, "폐기된 키를 되살리지 않으면 재발급이 안 된다");
  assert.equal(upd.bind.at(-1), OLD, "옛 해시로 행을 찾아야 한다");
  assert.notEqual(upd.bind[0], OLD, "새 해시가 옛 해시와 같다");
});

test("🔴 ② 같은 티켓을 두 번 쓰면 안 된다 — 그 해시의 행이 이미 없다", async () => {
  // 회전하면 해시가 바뀌므로, 재생된 티켓은 행을 못 찾는다. 사용 여부를 적어 둘 표가 필요 없다.
  const db = fixtureDb({ row: null });
  const res = await rotate(db, await ticketBody());
  assert.equal(res.status, 409);
  assert.equal(db.seen.batches.length, 0, "행이 없는데 뭔가 썼다");
});

test("🔴 ④ 계정당 하루 상한 — 다 쓰면 429 이고 쓰던 키는 살아 있다", async () => {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const db = fixtureDb({ row: { key_hash: OLD, rotated_day: today, rotated_count: 5 } });
  const res = await rotate(db, await ticketBody());
  assert.equal(res.status, 429);
  assert.match(await res.text(), /하루 5번/);
  assert.equal(db.seen.batches.length, 0, "상한에 걸렸는데 키를 갈아 끼웠다");
});

test("어제 쓴 횟수는 오늘을 막지 않는다 — 날짜가 바뀌면 0부터 센다", async () => {
  const db = fixtureDb({ row: { key_hash: OLD, rotated_day: "2020-01-01", rotated_count: 99 } });
  const res = await rotate(db, await ticketBody());
  assert.equal(res.status, 201);
  const upd = db.seen.batches.at(-1).find((s) => s.sql.includes("UPDATE _keys"));
  assert.equal(upd.bind[4], 1, "오늘 첫 회전인데 카운터가 1이 아니다");
});

test("발급 IP 상한은 회전에도 그대로 걸린다", async () => {
  const db = fixtureDb({ issuedThisHour: 5 });
  const res = await rotate(db, await ticketBody());
  assert.equal(res.status, 429);
  assert.equal(db.seen.batches.length, 0);
});

test("🔴 키 원문·이메일이 응답 헤더나 로그 바인딩에 새지 않는다", async () => {
  const db = fixtureDb();
  const res = await rotate(db, await ticketBody());
  const html = await res.text();
  const key = html.match(/ask_[a-z0-9]+/)[0];
  // 화면에 한 번 보여 주는 것 말고는 어디에도 원문이 없어야 한다
  for (const { b } of db.seen.binds)
    for (const v of b)
      assert.notEqual(String(v), key, "키 원문이 D1 바인딩에 실렸다");
  assert.doesNotMatch(String(res.headers.get("set-cookie") || ""), /ask_[a-z0-9]{8}/);
});
