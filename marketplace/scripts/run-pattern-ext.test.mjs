// scripts/run-pattern-ext.test.mjs — P1(기본값·허용값)·P3(배열 IN) 변환 (#217 1차 범위)
// npm test 에 포함(scripts/*.test.mjs). 순수 함수라 D1 불필요.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPattern, parseRestArrayParams } from "../src/run-pattern-ext.js";

const MAX = 5000;

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
