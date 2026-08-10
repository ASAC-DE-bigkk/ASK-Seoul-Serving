// prep/pattern-telemetry.test.mjs (미배선 · 실행: node --test ops-dashboard/prep/pattern-telemetry.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageSql, usageSql, asisVsToBeSql, shapeCoverage, shapeUsage, TEST_INTENT, RUN_PATTERN_ROUTES,
} from "./pattern-telemetry.mjs";
import { mergeRouteKo, mergeServeRoutes, ROUTE_KO_ADDITIONS, SERVE_ROUTES_ADDITIONS } from "./route-ko-additions.mjs";

test("usageSql: run_pattern 두 문 필터 + 환경 스코프 + 테스트 필터", () => {
  const sql = usageSql({ envClause: " AND env = 'prod'", testOnly: true });
  for (const r of RUN_PATTERN_ROUTES) assert.ok(sql.includes(`'${r}'`), `누락: ${r}`);
  assert.ok(sql.includes("AND env = 'prod'"));
  assert.ok(sql.includes(`intent = '${TEST_INTENT}'`));
  assert.ok(sql.includes("status = 500") && sql.includes("AS drift"));
  // testOnly=false 면 테스트 필터가 없어야 한다
  assert.ok(!usageSql({}).includes(TEST_INTENT));
});

test("coverageSql: d1_usage_patterns 에서 verified/total, 도메인별", () => {
  const sql = coverageSql();
  assert.ok(sql.includes("d1_usage_patterns") && sql.includes("verified_at IS NOT NULL") && sql.includes("GROUP BY domain"));
});

test("asisVsToBeSql: as_is/to_be 라벨링", () => {
  const sql = asisVsToBeSql({ envClause: " AND env = 'prod'" });
  assert.ok(sql.includes("'to_be'") && sql.includes("'as_is'") && sql.includes("mcp_query_product"));
});

test("shapeCoverage: 도메인별 pct + 총계 ('모른다≠0' — 미검증은 분모에 남는다)", () => {
  const s = shapeCoverage([
    { domain: "commerce", total: 275, verified: 0 },
    { domain: "traffic", total: 48, verified: 48 },
  ]);
  assert.equal(s.total, 323);
  assert.equal(s.verified, 48);
  assert.equal(s.domains.find((d) => d.domain === "commerce").pct, 0);
  assert.equal(s.domains.find((d) => d.domain === "traffic").pct, 100);
});

test("shapeUsage: 오류율·드리프트율", () => {
  const s = shapeUsage([
    { route: "run_pattern", calls: 80, errors: 4, drift: 2 },
    { route: "mcp_run_pattern", calls: 20, errors: 1, drift: 1 },
  ]);
  assert.equal(s.calls, 100); assert.equal(s.errors, 5); assert.equal(s.drift, 3);
  assert.equal(s.error_rate, 5); assert.equal(s.drift_rate, 3);
});

test("route 확장: 병합 헬퍼가 겹치지 않게 더한다", () => {
  const merged = mergeRouteKo({ data: "데이터 조회" });
  assert.equal(merged.data, "데이터 조회");
  assert.equal(merged.chat_run_pattern, ROUTE_KO_ADDITIONS.chat_run_pattern);
  const serve = mergeServeRoutes(["data", "run_pattern"]);
  for (const r of SERVE_ROUTES_ADDITIONS) assert.ok(serve.includes(r));
  assert.equal(serve.filter((r) => r === "data").length, 1);
});
