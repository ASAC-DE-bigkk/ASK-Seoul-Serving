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
import { readFile } from "node:fs/promises";
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

test("🔴 배포 모드는 우리 표가 없으면 중단한다 — route 전에 migrations apply 가 필요하다", () => {
  const expected = new Map([
    ["_keys", cols("key_hash", "email")],
    ["_gateway_request_log", cols("ts", "route", "status")],
  ]);
  const fs = judge(expected, new Map(), { requireApplied: true });
  assert.equal(fs.filter((f) => f.blocking).length, 2);
  assert.equal(find(fs, "_keys").verdict, "없음");
  assert.equal(find(fs, "_keys").requiredForDeploy, true);
  assert.match(find(fs, "_gateway_request_log").note, /migrations apply/);
});

test("배포 모드도 남의 표가 없거나 원래 모양이면 막지 않는다 — Gateway 의존성이 아니다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status", "request_id")]]);
  const missing = judge(expected, new Map(), { requireApplied: true });
  const present = judge(expected, new Map([["_request_log", FOREIGN_PROD]]), { requireApplied: true });
  assert.equal(find(missing, "_request_log").blocking, false);
  assert.equal(find(present, "_request_log").blocking, false);
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

test("남의 표가 **원래 모양 그대로면** 통과한다 — 다른 게 정상이고 건드리면 안 된다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status")]]);
  const fs = judge(expected, new Map([["_request_log", FOREIGN_PROD]]));
  const f = find(fs, "_request_log");
  assert.equal(f.verdict, "남의 표");
  assert.equal(f.blocking, false);
  // `ts` 는 우리 스키마에도 있다 — 단순 교집합으로 판정하면 멀쩡한 prod 가 오염으로 잡힌다.
  assert.deepEqual(f.contaminated, []);
});

test("🔴 남의 표에 **우리 컬럼이 하나라도** 얹히면 중단한다 — dev 가 지금 그 상태다", () => {
  // 이 케이스가 없으면 검사가 **이미 일어난 사고를 통과시킨다.** `0004` 의 조건 없는 ALTER 가
  // 붙인 `request_id` 는 우리 스키마 전체가 아니라서 '인수됨'에 걸리지 않는다.
  const expected = new Map([["_request_log", cols("ts", "route", "status", "request_id")]]);
  const fs = judge(expected, new Map([["_request_log", FOREIGN_DEV]]));
  const f = find(fs, "_request_log");
  assert.equal(f.verdict, "오염");
  assert.equal(f.blocking, true);
  assert.deepEqual(f.contaminated, ["request_id"]);   // 어느 컬럼인지 사람이 읽을 수 있어야 한다
  assert.match(f.note, /request_id/);
});

test("남의 표가 **자기 컬럼을** 늘린 건 막지 않는다 — 그건 그쪽 사정이다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status")]]);
  const remote = new Map([["_request_log", cols("ts", "path", "query", "token", "their_new_col")]]);
  const f = find(judge(expected, remote), "_request_log");
  assert.equal(f.verdict, "남의 표");
  assert.equal(f.blocking, false);
});

test("🔴 남의 표가 **우리 모양이 되면** 중단한다 — 그 이름을 인수해 버렸다는 뜻이다", () => {
  const expected = new Map([["_request_log", cols("ts", "route", "status")]]);
  const remote = new Map([["_request_log", cols("ts", "route", "status", "extra")]]);
  const f = find(judge(expected, remote), "_request_log");
  assert.equal(f.verdict, "인수됨");
  assert.equal(f.blocking, true);
});

test("판정마다 표시 기호가 있다 — 빠지면 표에 undefined 가 찍힌다", async () => {
  // 실제로 겪었다. 판정을 하나 늘리고 MARK 를 안 늘려서 원격 출력에 `undefined 오염` 이 찍혔다.
  const src = await readFile(new URL("./preflight-d1.mjs", import.meta.url), "utf8");
  const marks = src.match(/^const MARK = \{[^}]*\}/m)?.[0] ?? "";
  for (const verdict of ["없음", "일치", "일치+", "모양 다름", "남의 표", "오염", "인수됨"]) {
    assert.ok(marks.includes(`"${verdict}"`), `MARK 에 '${verdict}' 이 없다`);
  }
});

test("남의 표 목록에 사유와 기준 모양이 함께 있다 — 둘 다 없으면 판정이 안 선다", () => {
  assert.ok(FOREIGN.has("_request_log"));
  const entry = FOREIGN.get("_request_log");
  assert.match(entry.why, /transit/);
  // baseline 이 없으면 "우리가 얹은 컬럼"을 골라낼 수 없다 — 교집합만으로는 `ts` 때문에 못 가린다.
  assert.ok(Array.isArray(entry.baseline) && entry.baseline.length, "baseline 이 필요하다");
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
