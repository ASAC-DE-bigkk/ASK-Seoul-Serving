// scripts/run-pattern-ext.test.mjs — P1(기본값·허용값)·P3(배열 IN) 변환 (#217 1차 범위)
// npm test 에 포함(scripts/*.test.mjs). 순수 함수라 D1 불필요.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPattern, parseRestArrayParams, resolveRelativeDefault } from "../src/run-pattern-ext.js";

const MAX = 5000;
// 고정 기준시각 — KST 2026-08-10 15:04:05 (UTC 06:04:05). 상대 날짜 해석의 결정성 확보.
const NOW = Date.UTC(2026, 7, 10, 6, 4, 5);

// ── 계약 보존: 게시 메타(defaults/enums/spec)가 없으면 기존 계약 그대로 ──────────────
test("메타 없음: 전 파라미터 필수 · 스칼라 bind · limit 클램프(기존 계약)", () => {
  const r = convertPattern("SELECT * FROM t WHERE g = :gu ORDER BY x LIMIT :n", { gu: "11680", n: "999999" }, { maxLimit: MAX });
  assert.ok(r.ok && r.converted.includes("g = ?") && r.values.length === 2 && r.values[1] === MAX);
  assert.equal(convertPattern("SELECT * FROM t WHERE g=:gu", {}, { maxLimit: MAX }).problem.title, "missing parameter");
  assert.equal(convertPattern("SELECT * FROM t WHERE g=:gu", { gu: "x", bad: "y" }, {}).problem.title, "unknown parameter");
  assert.equal(convertPattern("DELETE FROM t", {}, {}).problem.title, "pattern not runnable");
});

// ── P1 기본값 ────────────────────────────────────────────────────────────────
test("P1 기본값: 미전달 시 상수 bind · defaulted 표시 · 전달 시 override", () => {
  const r = convertPattern("SELECT * FROM t WHERE c >= :min", {}, { defaults: { min: 100 } });
  assert.ok(r.ok && r.values[0] === 100 && r.defaulted.includes("min"));
  const o = convertPattern("SELECT * FROM t WHERE c >= :min", { min: 5 }, { defaults: { min: 100 } });
  assert.ok(o.ok && o.values[0] === 5 && !o.defaulted.includes("min"));
});
test("게시 메타 드리프트(선언 밖 키)는 무시하고 패턴은 돈다 — #217 불변식(메타 지연이 막지 않는다)", () => {
  // c 는 선언 밖 default → 조용히 무시. b 는 진짜 누락 → missing.
  assert.equal(convertPattern("SELECT * FROM t WHERE a=:a AND b=:b", { a: "x" }, { defaults: { c: 1 } }).problem.title, "missing parameter");
  // 선언 밖 default/enum/spec 만 있고 나머지 다 채우면 정상 실행(잘 돌던 패턴을 안 죽인다).
  const ok = convertPattern("SELECT * FROM t WHERE a=:a", { a: "x" }, { defaults: { z: 1 }, enums: { z: ["q"] }, spec: { z: { type: "array" } } });
  assert.ok(ok.ok && ok.values.length === 1 && ok.values[0] === "x");
});

// ── P1 허용값(enum) ──────────────────────────────────────────────────────────
test("P1 enum: 허용값 밖 400 · 안이면 통과 · 기본값에도 적용", () => {
  const sql = "SELECT * FROM t ORDER BY x LIMIT :n";  // enum 은 스칼라 파라미터 대상
  const bad = convertPattern("SELECT * FROM t WHERE dir=:dir", { dir: "sideways" }, { enums: { dir: ["asc", "desc"] } });
  assert.equal(bad.problem.status, 400);
  const ok = convertPattern("SELECT * FROM t WHERE dir=:dir", { dir: "asc" }, { enums: { dir: ["asc", "desc"] } });
  assert.ok(ok.ok);
  // 기본값이 enum 밖이면 그것도 400(게시 메타 버그를 조용히 넘기지 않는다)
  const db = convertPattern("SELECT * FROM t WHERE dir=:dir", {}, { defaults: { dir: "nope" }, enums: { dir: ["asc"] } });
  assert.equal(db.problem.status, 400);
});

// ── P3 배열 IN ───────────────────────────────────────────────────────────────
test("P3 배열: spec array → ?,?,? 전개 · 원소별 bind", () => {
  const r = convertPattern("SELECT * FROM t WHERE gu IN (:gus)", { gus: ["a", "b", "c"] }, { spec: { gus: { type: "array" } } });
  assert.ok(r.ok && /IN \(\?,\?,\?\)/.test(r.converted) && r.values.length === 3);
});
test("P3 배열: 스칼라 선언에 배열 오면 400 · array 선언에 스칼라 오면 400", () => {
  assert.equal(convertPattern("SELECT * FROM t WHERE g=:g", { g: ["a"] }, { spec: { g: { type: "string" } } }).problem.status, 400);
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: "a" }, { spec: { g: { type: "array" } } }).problem.status, 400);
});
test("P3 배열: max_len(≤하드캡 100) · 빈 배열 400 · 원소 타입 강제(number)", () => {
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: [] }, { spec: { g: { type: "array" } } }).problem.title, "empty array parameter");
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: ["a", "b", "c"] }, { spec: { g: { type: "array", max_len: 2 } } }).problem.title, "array too large");
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: Array(101).fill("x") }, { spec: { g: { type: "array" } } }).problem.title, "array too large");
  const num = convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: ["1", "2"] }, { spec: { g: { type: "array", item: "number" } } });
  assert.deepEqual(num.values, [1, 2]);
});
test("P3 배열: array 선언 없으면 배열 거부(무과금 400) — json_each·LIMIT 클램프 보호", () => {
  // 미선언 배열은 옛 계약대로 400(전개 안 함) — json_each(:x) 관용구·스칼라 문맥을 지킨다
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: ["a", "b"] }, {}).problem.status, 400);
  // LIMIT 파라미터에 배열 → 거부(클램프 우회 차단): 미선언이든 array 선언이든
  assert.equal(convertPattern("SELECT * FROM t ORDER BY x LIMIT :n", { n: [999999] }, {}).problem.status, 400);
  assert.equal(convertPattern("SELECT * FROM t ORDER BY x LIMIT :n", { n: [1, 999999] }, { spec: { n: { type: "array" } } }).problem.status, 400);
  // 스칼라 LIMIT 은 여전히 클램프됨
  assert.equal(convertPattern("SELECT * FROM t LIMIT :n", { n: "999999" }, { maxLimit: MAX }).values[0], MAX);
});

// ── spec type=number 스칼라 강제 ─────────────────────────────────────────────
test("spec number 스칼라: 숫자 강제 · 비숫자 400", () => {
  assert.deepEqual(convertPattern("SELECT * FROM t WHERE c=:c", { c: "42" }, { spec: { c: { type: "number" } } }).values, [42]);
  assert.equal(convertPattern("SELECT * FROM t WHERE c=:c", { c: "x" }, { spec: { c: { type: "number" } } }).problem.status, 400);
});

// ── parseRestArrayParams (REST 진입) ─────────────────────────────────────────
test("REST: array 선언 + JSON 배열 문자열 → 실배열 · 그 외는 그대로(json_each 하위호환)", () => {
  const spec = { gus: { type: "array" } };
  assert.deepEqual(parseRestArrayParams({ gus: '["a","b"]' }, spec).gus, ["a", "b"]);
  // array 선언 아님 → 문자열 그대로(json_each(:gus) 관용구 보존)
  assert.equal(parseRestArrayParams({ gus: '["a","b"]' }, {}).gus, '["a","b"]');
  // 깨진 JSON → 그대로(convertPattern 이 "배열이어야 한다" 400 으로 원인 안내)
  assert.equal(parseRestArrayParams({ gus: "[oops" }, spec).gus, "[oops");
  // spec 없음 → supplied 그대로
  assert.deepEqual(parseRestArrayParams({ a: "1" }, null), { a: "1" });
});

// ── 동적 기본값(상대 날짜) — 시점이 박제되지 않고 '지금' 기준으로 움직인다 ──────────────
test("resolveRelativeDefault: 형식별 KST 기준 해석", () => {
  const r = (rel, as) => resolveRelativeDefault({ rel, as }, NOW).val;
  assert.equal(r("0d", "date"), "2026-08-10");       // KST 오늘
  assert.equal(r("-30d", "date"), "2026-07-11");     // 30일 전
  assert.equal(r("-1w", "date"), "2026-08-03");      // 1주 전
  assert.equal(r("-1M", "date"), "2026-07-10");      // 1달 전
  assert.equal(r("0M", "ym"), "2026-08");            // 이번 달
  assert.equal(r("0y", "year"), "2026");             // 올해
  assert.equal(r("-1y", "year"), "2025");
  assert.equal(r("0d", "datetime"), "2026-08-10 15:04:05");  // 오프셋 0 = 지금(시각까지)
  assert.equal(r("-7d", "datetime"), "2026-08-03 00:00:00"); // 그 외 = 그날 00:00:00
});

test("resolveRelativeDefault: KST 경계 — UTC 늦은 밤이 KST 다음날", () => {
  // UTC 2026-08-10 16:00 = KST 2026-08-11 01:00 → '오늘'은 11일
  const late = Date.UTC(2026, 7, 10, 16, 0, 0);
  assert.equal(resolveRelativeDefault({ rel: "0d", as: "date" }, late).val, "2026-08-11");
});

test("resolveRelativeDefault: 잘못된 표현은 err", () => {
  assert.ok(resolveRelativeDefault({ rel: "-30x", as: "date" }, NOW).err);
  assert.ok(resolveRelativeDefault({ rel: "-30d", as: "week" }, NOW).err);
});

test("convertPattern: 상대 기본값이 실행 시점으로 bind (from/to 최근 30일)", () => {
  const sql = "SELECT * FROM t WHERE d BETWEEN :from AND :to";
  const defaults = { from: { rel: "-30d", as: "date" }, to: { rel: "0d", as: "date" } };
  const r = convertPattern(sql, {}, { defaults, nowMs: NOW });
  assert.ok(r.ok);
  assert.deepEqual(r.values, ["2026-07-11", "2026-08-10"]);
  assert.deepEqual(r.defaulted.sort(), ["from", "to"]);
});

test("convertPattern: 🔴 동적 — 다른 '지금'이면 다른 날짜 (박제 아님)", () => {
  const sql = "SELECT * FROM t WHERE d >= :from";
  const d = { from: { rel: "-7d", as: "date" } };
  const day1 = convertPattern(sql, {}, { defaults: d, nowMs: NOW }).values[0];
  const day2 = convertPattern(sql, {}, { defaults: d, nowMs: NOW + 5 * 86400_000 }).values[0]; // +5일
  assert.equal(day1, "2026-08-03");
  assert.equal(day2, "2026-08-08");   // 기준이 5일 이동하면 기본값도 5일 이동
  assert.notEqual(day1, day2);
});

test("convertPattern: 소비자가 날짜를 주면 상대 기본값을 override", () => {
  const sql = "SELECT * FROM t WHERE d >= :from";
  const d = { from: { rel: "-7d", as: "date" } };
  const r = convertPattern(sql, { from: "2020-01-01" }, { defaults: d, nowMs: NOW });
  assert.equal(r.values[0], "2020-01-01");
  assert.equal(r.defaulted.length, 0);
});

test("convertPattern: 상대 기본값 형식 오류는 400 invalid default", () => {
  const r = convertPattern("SELECT * FROM t WHERE d >= :from", {}, { defaults: { from: { rel: "bad", as: "date" } }, nowMs: NOW });
  assert.equal(r.problem.title, "invalid default");
});

// ── REST 문자열 ↔ SQLite 타입 어피니티 (2026-08-12) ────────────────────────────
//
// 🔴 **REST 로 온 값은 전부 문자열이다.** SQLite 는 타입 어피니티를 **컬럼과 비교할 때만**
//    적용한다 — `WHERE successions >= ?` 는 '50' 을 숫자로 바꿔 주지만
//    `WHERE a_to_b + b_to_a >= ?` 는 **식이라 어피니티가 없어** INTEGER < TEXT 규칙이 그대로
//    걸린다. 그래서 같은 50 인데 MCP(타입 있는 JSON)는 행이 나오고 REST 는 **조용히 0행**이다.
//    오류도 안 난다. D1 실측(2026-08-12):
//      컬럼 비교 → '50' 5행 · 50 5행   /   식 비교 → '50' **0행** · 50 5행
//    게시본 884건 전수 실행에서 이 강제 하나로 0행 78건 → 12건이 됐다(회귀 0).
test("🔴 숫자 기본값이 선언된 파라미터는 REST 문자열도 숫자로 bind — 식 비교에서 조용히 0행이 된다", () => {
  const sql = "SELECT * FROM t WHERE a + b >= :min_pair";
  const r = convertPattern(sql, { min_pair: "50" }, { defaults: { min_pair: 50 } });
  assert.ok(r.ok);
  assert.strictEqual(r.values[0], 50, "문자열 '50' 이 그대로 나가면 식 비교에서 0행이다");
});

test("🔴 문자열로 선언된 기본값은 건드리지 않는다 — 코드값을 숫자로 바꾸면 반대로 0행이다", () => {
  // `'02'`(휴업 상태 코드) → `2` 가 되면 TEXT 컬럼과 안 맞는다. 선언이 문자열이면 그대로 둔다.
  const sql = "SELECT * FROM t WHERE from_status = :s";
  const r = convertPattern(sql, { s: "02" }, { defaults: { s: "01" } });
  assert.ok(r.ok);
  assert.strictEqual(r.values[0], "02");
});

test("숫자 선언이 없으면 강제하지 않는다 — 근거 없이 타입을 바꾸지 않는다", () => {
  const r = convertPattern("SELECT * FROM t WHERE a + b >= :min", { min: "50" }, {});
  assert.ok(r.ok);
  assert.strictEqual(r.values[0], "50");
});

test("숫자 표기만 받는다 — `0x10`·`1e5` 로 다른 수가 들어가면 안 된다", () => {
  const sql = "SELECT * FROM t WHERE a + b >= :min";
  const d = { defaults: { min: 50 } };
  assert.strictEqual(convertPattern(sql, { min: "0x10" }, d).values[0], "0x10");
  assert.strictEqual(convertPattern(sql, { min: "1e5" }, d).values[0], "1e5");
  assert.strictEqual(convertPattern(sql, { min: "가나다" }, d).values[0], "가나다");
  assert.strictEqual(convertPattern(sql, { min: " 50 " }, d).values[0], 50, "앞뒤 공백은 벗긴다");
  assert.strictEqual(convertPattern(sql, { min: "-3.5" }, d).values[0], -3.5);
});

test("spec.type=number 가 있으면 그쪽이 먼저다 — 두 규칙이 싸우지 않는다", () => {
  const r = convertPattern("SELECT * FROM t WHERE a + b >= :min", { min: "1e5" },
    { defaults: { min: 50 }, spec: { min: { type: "number" } } });
  assert.ok(r.ok && r.values[0] === 100000, "명시 선언(spec)은 넓은 표기를 그대로 받는다");
});
