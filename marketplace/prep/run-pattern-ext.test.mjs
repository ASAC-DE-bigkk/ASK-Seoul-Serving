// prep/run-pattern-ext.test.mjs — P1~P6 (미배선 · 실행: node --test marketplace/prep/run-pattern-ext.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertPattern, encodeCursor, decodeCursor, pageRows, pivot,
  unguaranteedFunctions, resolveIdentifierSlots,
} from "./run-pattern-ext.mjs";

// ── P1 + P3: convertPattern ──────────────────────────────────────────────────
test("P1/P3 convertPattern: 스칼라 + LIMIT 클램프", () => {
  const r = convertPattern("SELECT * FROM t WHERE g = :gu ORDER BY x LIMIT :n", { gu: "11680", n: "999999" });
  assert.ok(r.ok && r.values.length === 2 && r.converted.includes("g = ?") && r.values[1] === 5000);
});
test("P3 배열 → ?,?,?", () => {
  const r = convertPattern("SELECT * FROM t WHERE gu IN (:gus)", { gus: ["a", "b", "c"] });
  assert.ok(r.ok && /IN \(\?,\?,\?\)/.test(r.converted) && r.values.length === 3);
});
test("P1 기본값 채움", () => {
  const r = convertPattern("SELECT * FROM t WHERE c >= :min", {}, { defaults: { min: 100 } });
  assert.ok(r.ok && r.values[0] === 100);
});
test("선언 밖 파라미터/기본값 400", () => {
  assert.equal(convertPattern("SELECT * FROM t WHERE g = :gu", { gu: "x", bad: "y" }).problem.status, 400);
  assert.equal(convertPattern("SELECT * FROM t WHERE g = :gu", { gu: "x" }, { defaults: { bad: 1 } }).problem.title, "unknown default");
});
test("누락/빈배열/과대배열/비-SELECT 400", () => {
  assert.equal(convertPattern("SELECT * FROM t WHERE g = :gu", {}).problem.title, "missing parameter");
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: [] }).problem.title, "empty array parameter");
  assert.equal(convertPattern("SELECT * FROM t WHERE g IN (:g)", { g: Array(101).fill("x") }).problem.title, "array too large");
  assert.equal(convertPattern("DELETE FROM t", {}).problem.title, "pattern not runnable");
});

// ── P2: 커서 ─────────────────────────────────────────────────────────────────
test("P2 커서 왕복 + pageRows has_more", () => {
  assert.deepEqual(decodeCursor(encodeCursor("2026-08-08", 42)), { rid: 42, stamp: "2026-08-08" });
  assert.equal(decodeCursor("!!bad!!"), null);
  const rows = [{ _rid: 1 }, { _rid: 2 }, { _rid: 3 }];
  const p = pageRows(rows, { pageSize: 2, stamp: "s", keyOf: (r) => r._rid });
  assert.ok(p.has_more && p.rows.length === 2 && decodeCursor(p.next_cursor).rid === 2);
  const q = pageRows(rows.slice(0, 2), { pageSize: 2, stamp: "s", keyOf: (r) => r._rid });
  assert.ok(!q.has_more && q.next_cursor === null);
});

// ── P4: 함수 화이트리스트 ────────────────────────────────────────────────────
test("P4 보장 밖 함수만 잡는다", () => {
  const flagged = unguaranteedFunctions("SELECT sum(x), regexp(a,b), stddev(c), round(d) FROM t");
  assert.deepEqual(flagged.sort(), ["regexp", "stddev"]);
  assert.equal(unguaranteedFunctions("SELECT count(*), avg(x), sqrt(y) FROM t").length, 0);
});

// ── P5: 피벗 ─────────────────────────────────────────────────────────────────
test("P5 롱→와이드 + maxCols 가드", () => {
  const long = [{ ym: "24", gu: "A", c: 1 }, { ym: "24", gu: "B", c: 2 }, { ym: "25", gu: "A", c: 3 }];
  const w = pivot(long, { row: "ym", col: "gu", val: "c" });
  assert.ok(w.ok && w.rows.length === 2 && w.columns.includes("A") && w.columns.includes("B"));
  const r24 = w.rows.find((x) => x.ym === "24");
  assert.equal(r24.A, 1); assert.equal(r24.B, 2);
  assert.equal(pivot(long, { row: "ym", col: "gu", val: "c", maxCols: 1 }).problem.status, 400);
});

// ── P6: 식별자 슬롯 (고위험, 기본 비활성) ───────────────────────────────────────
const SLOTS = { col: { allow: ["lq", "share"] }, dir: { allow: ["asc", "desc"] } };
const SQL6 = "SELECT lq, share FROM d1_ok ORDER BY @{col} @{dir}";
test("P6 기본 비활성 → 403", () => {
  assert.equal(resolveIdentifierSlots(SQL6, SLOTS, { col: "lq", dir: "desc" }).problem.status, 403);
});
test("P6 활성+허용값 → 치환 후 스코프 통과", () => {
  const r = resolveIdentifierSlots(SQL6, SLOTS, { col: "lq", dir: "desc" }, { enabled: true, allowedTables: ["d1_ok"] });
  assert.ok(r.ok && r.sql.includes("ORDER BY lq desc"));
});
test("P6 허용 목록 밖 값 → 400 (인젝션 차단)", () => {
  const evil = resolveIdentifierSlots(SQL6, SLOTS, { col: "(SELECT key_hash FROM _keys)", dir: "desc" }, { enabled: true, allowedTables: ["d1_ok"] });
  assert.equal(evil.problem.status, 400);
});
test("P6 allow 미선언 → 400", () => {
  assert.equal(resolveIdentifierSlots(SQL6, { dir: { allow: ["asc"] } }, { col: "lq", dir: "asc" }, { enabled: true, allowedTables: ["d1_ok"] }).problem.title, "identifier slot not allowlisted");
});
