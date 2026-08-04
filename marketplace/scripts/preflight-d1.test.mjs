/**
 * preflight-d1 — 판정을 고정한다.
 *
 * 이 검사가 틀리면 손해는 여기가 아니라 **그 다음에 도는 `migrations apply`** 에서 난다.
 * 그래서 각 케이스 이름에 "무엇을 판정했나"가 아니라 **"통과시키면 무슨 일이 나나"** 를 적는다.
 *
 * 실제 원격을 타는 부분(`remoteSchema`)은 여기서 안 부른다 — `judge()` 에 실측 모양을
 * 그대로 넣어 판정만 본다. 원격·로컬 D1 을 전혀 건드리지 않는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { judge, expectedSchema, FOREIGN } from "./preflight-d1.mjs";

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* skip 처리 */ }
const NEEDS_SQLITE = { skip: DatabaseSync ? false : "node:sqlite 없음 — Node 22.5+ 필요" };

const cols = (...names) => new Set(names);
const find = (fs, t) => fs.find((f) => f.table === t);

// 원격 실측(2026-08-04, 읽기만). 남의 표가 이 모양으로 선점돼 있었다.
const FOREIGN_PROD = cols("ts", "path", "query", "token");
const FOREIGN_DEV = cols("ts", "path", "query", "token", "request_id");   // 0004 가 잘못 얹힘

test("빈 DB — 전부 '없음'이고 진행 가능하다 (apply 가 새로 만든다)", () => {
  const expected = new Map([["_keys", cols("key_hash", "email")], ["_usage", cols("key_hash", "day")]]);
  const fs = judge(expected, new Map());
  assert.equal(fs.filter((f) => f.blocking).length, 0);
  assert.equal(find(fs, "_keys").verdict, "없음");
});

test("모양이 같으면 '일치' — 재적용해도 안전하다", () => {
  const expected = new Map([["_keys", cols("key_hash", "email", "status")]]);
  const remote = new Map([["_keys", cols("key_hash", "email", "status")]]);
  const fs = judge(expected, remote);
  assert.equal(find(fs, "_keys").verdict, "일치");
  assert.equal(find(fs, "_keys").blocking, false);
});

test("🔴 컬럼이 빠져 있으면 중단한다 — 통과시키면 INSERT 가 waitUntil 안에서 조용히 죽는다", () => {
  const expected = new Map([["_keys", cols("key_hash", "email", "daily_quota")]]);
  const remote = new Map([["_keys", cols("key_hash", "email")]]);          // daily_quota 없음
  const fs = judge(expected, remote);
  const f = find(fs, "_keys");
  assert.equal(f.verdict, "모양 다름");
  assert.equal(f.blocking, true);
  assert.match(f.note, /daily_quota/);
});

test("컬럼이 더 있으면 막지 않는다 — 증분 규약이 '추가만'이라 앞선 배포가 더 갔을 수 있다", () => {
  const expected = new Map([["_keys", cols("key_hash")]]);
  const remote = new Map([["_keys", cols("key_hash", "note_added_later")]]);
  const fs = judge(expected, remote);
  assert.equal(find(fs, "_keys").blocking, false);
  assert.match(find(fs, "_keys").verdict, /일치/);
});

test("남의 표는 모양이 달라도 통과한다 — 다른 게 정상이고 건드리면 안 된다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status")]]);
  for (const [label, remoteCols] of [["prod", FOREIGN_PROD], ["dev", FOREIGN_DEV]]) {
    const fs = judge(expected, new Map([["_request_log", remoteCols]]));
    const f = find(fs, "_request_log");
    assert.equal(f.verdict, "남의 표", label);
    assert.equal(f.blocking, false, label);
  }
});

test("🔴 남의 표가 **우리 모양이 되면** 중단한다 — 그 이름을 인수해 버렸다는 뜻이다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status")]]);
  const remote = new Map([["_request_log", cols("ts", "route", "status", "extra")]]);
  const f = find(judge(expected, remote), "_request_log");
  assert.equal(f.verdict, "인수됨");
  assert.equal(f.blocking, true);
});

test("남의 표 목록에 사유가 함께 있다 — 이름만 있으면 다음 사람이 왜인지 모른다", () => {
  assert.ok(FOREIGN.has("_request_log"));
  assert.match(FOREIGN.get("_request_log"), /transit/);
});

test("기대 스키마는 마이그레이션 파일에서 나온다 — 하드코딩이면 드리프트한다", NEEDS_SQLITE, async () => {
  const expected = await expectedSchema();
  assert.ok(expected, "node:sqlite 로 기대 스키마를 만들 수 있어야 한다");

  // 마이그레이션이 실제로 만드는 표가 잡히는지
  assert.ok(expected.has("_keys"), "0001 의 _keys");
  assert.ok(expected.has("_burst"), "0003 의 _burst");

  // 0004 의 ALTER 까지 반영돼야 한다 — CREATE 만 읽으면 이 컬럼을 놓친다
  const log = expected.get("_request_log");
  assert.ok(log?.has("request_id"), "0004 의 request_id 가 반영돼야 한다");
  assert.ok(log?.has("route"), "0002 의 route");
});

test("실측 prod 모양을 그대로 넣으면 남의 표만 잡히고 나머지는 '없음'이다", NEEDS_SQLITE, async () => {
  const expected = await expectedSchema();
  // prod 실측: 우리 표는 하나도 없고 남의 _request_log 만 있다
  const fs = judge(expected, new Map([["_request_log", FOREIGN_PROD]]));
  assert.equal(fs.filter((f) => f.blocking).length, 0, "prod 는 지금 진행 가능해야 한다");
  assert.equal(find(fs, "_request_log").verdict, "남의 표");
  assert.equal(find(fs, "_keys").verdict, "없음");
});

// ── 중단 → 결정 → --ack 흐름 ──────────────────────────────────────────────────
// 사용자가 요구한 절차다: 모양이 다르면 **중단**하고, 사람이 정한 뒤에만 통과시킨다.
// `--ack` 가 판정을 '일치'로 바꿔 버리면 그 기록이 사라지므로, **판정은 그대로 두고
// 종료 코드만** 바꾸는지 본다.

test("🔴 중단 케이스 — 남의 표 모양 그대로인데 우리 표로 기대하면 막는다", () => {
  // `_request_log` 를 남의 표 목록에서 빼면(= 우리 것이라고 주장하면) 바로 걸려야 한다.
  const expected = new Map([["_gateway_request_log", cols("ts", "route", "status", "env")]]);
  const remote = new Map([["_gateway_request_log", cols("ts", "path", "query", "token")]]);
  const f = find(judge(expected, remote), "_gateway_request_log");
  assert.equal(f.verdict, "모양 다름");
  assert.equal(f.blocking, true);
  // 어느 컬럼이 없는지 사람이 읽을 수 있어야 한다 — "다름"만으로는 못 정한다
  assert.match(f.note, /route/);
  assert.match(f.note, /status/);
  assert.ok(f.expected.length && f.actual.length, "기대·실제를 둘 다 실어야 판단이 된다");
});

test("--ack 는 판정을 바꾸지 않는다 — 기록이 남아야 다음 사람이 왜인지 안다", () => {
  const expected = new Map([["_keys", cols("key_hash", "daily_quota")]]);
  const remote = new Map([["_keys", cols("key_hash")]]);
  const fs = judge(expected, remote);
  // judge() 는 --ack 를 모른다. 통과 여부는 출력 단계에서만 갈린다.
  assert.equal(find(fs, "_keys").blocking, true, "판정 자체는 그대로 '중단'이어야 한다");
});
