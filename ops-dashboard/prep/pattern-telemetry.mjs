// prep/pattern-telemetry.mjs — TO-BE 관측 지표 (검증 커버리지·run_pattern 사용·드리프트) 후보
//                              (#192 OPS · 이식 후보, 미배선)
//
// 콘솔(ops-dashboard)이 TO-BE 진척을 상설로 보여주기 위한 질의 빌더 + 순수 집계기.
// 🔴 어디에도 import 되지 않는다 — `ops-dashboard/prep/` 폴더를 지우면 사라진다.
// 이식 시: `src/index.js` 의 서빙 절에 카드 하나 추가(safeRows 로 아래 SQL 실행 → shape* 로 가공).
//
// 규약 준수:
//  · 환경 스코프는 호출부가 `gwWhere(env)` 결과(예: " AND env = 'prod'")를 넘긴다(#64 — local/dev 혼입 차단).
//  · `SERVE`/route 계약은 decision/0014 정본. run_pattern 계열은 두 문(사람 `run_pattern`·AI `mcp_run_pattern`).
//  · "모른다 ≠ 0"(agreement §4): 검증 안 된 패턴은 verified=0 이 아니라 분모에 남겨 커버리지로 보인다.

// 우리 테스트 트래픽 식별자 — 이 값으로 필터하면 max20_fable 이 남긴 호출만 본다.
export const TEST_INTENT = "max20_fable";

// run_pattern 두 문(사람/AI). decision/0014 SERVE_ROUTES 의 부분집합.
export const RUN_PATTERN_ROUTES = ["run_pattern", "mcp_run_pattern"];
const RP_IN = "(" + RUN_PATTERN_ROUTES.map((r) => `'${r}'`).join(", ") + ")";

// ── ① 검증 패턴 커버리지 (d1_usage_patterns) — 도메인별 verified/total ──────────
// "모른다 ≠ 0": 미검증도 분모에 남긴다. 도메인은 product_id 의 밑줄 접두사(없으면 unknown).
// ⚠️ 접두사만으로 도메인을 단정하지 않는 원칙(콘솔 CLAUDE.md §5)은 '세는' 자리에 적용된다 —
//    여기 커버리지는 목록성이라 접두사로 묶되, 실제 KPI 분모는 카탈로그 교차로 별도 확인한다.
export function coverageSql() {
  return "SELECT CASE WHEN instr(product_id,'_') > 0 " +
    "THEN substr(product_id,1,instr(product_id,'_')-1) ELSE 'unknown' END AS domain, " +
    "COUNT(*) AS total, SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified " +
    "FROM d1_usage_patterns GROUP BY domain ORDER BY total DESC";
}

// ── ② run_pattern 사용·오류·드리프트 (_gateway_request_log) ────────────────────
// drift = status 500 (게이트웨이가 '패턴이 게시본과 어긋남'을 500 으로 돌려준다 — handleRunPattern).
// testOnly=true 면 우리 테스트 트래픽(intent=max20_fable)만.
export function usageSql({ envClause = "", testOnly = false } = {}) {
  const testC = testOnly ? ` AND intent = '${TEST_INTENT}'` : "";
  return "SELECT route, product_id, COUNT(*) AS calls, " +
    "SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors, " +
    "SUM(CASE WHEN status = 500 THEN 1 ELSE 0 END) AS drift, " +
    "ROUND(AVG(row_count),1) AS avg_rows, ROUND(AVG(ms),1) AS avg_ms, " +
    "COUNT(DISTINCT key_hash) AS keys " +
    "FROM _gateway_request_log " +
    "WHERE ts >= datetime('now', ?) AND route IN " + RP_IN + envClause + testC + " " +
    "GROUP BY route, product_id ORDER BY calls DESC";
}

// ── ③ 기존형↔신설형 비교 (같은 창에서 query_product vs run_pattern 실호출 대비) ──
// AS-IS(mcp_query_product·data) vs TO-BE(run_pattern 계열)의 호출·행수·오류를 나란히.
export function asisVsToBeSql({ envClause = "" } = {}) {
  return "SELECT CASE WHEN route IN " + RP_IN + " THEN 'to_be' " +
    "WHEN route IN ('data','mcp_query_product','skill_data') THEN 'as_is' ELSE 'other' END AS mode, " +
    "COUNT(*) AS calls, ROUND(AVG(row_count),1) AS avg_rows, " +
    "SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors " +
    "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + envClause +
    " GROUP BY mode";
}

// ── 순수 집계기 (D1 없이 단독 테스트) ─────────────────────────────────────────
export function shapeCoverage(rows) {
  const out = (rows || []).map((r) => ({
    domain: r.domain, verified: Number(r.verified) || 0, total: Number(r.total) || 0,
    pct: r.total ? Math.round((100 * Number(r.verified)) / Number(r.total)) : 0,
  }));
  const total = out.reduce((a, r) => a + r.total, 0);
  const verified = out.reduce((a, r) => a + r.verified, 0);
  return { domains: out, total, verified, pct: total ? Math.round((100 * verified) / total) : 0 };
}

export function shapeUsage(rows) {
  const calls = (rows || []).reduce((a, r) => a + (Number(r.calls) || 0), 0);
  const errors = (rows || []).reduce((a, r) => a + (Number(r.errors) || 0), 0);
  const drift = (rows || []).reduce((a, r) => a + (Number(r.drift) || 0), 0);
  return {
    products: rows || [], calls, errors, drift,
    error_rate: calls ? +(100 * errors / calls).toFixed(1) : 0,
    drift_rate: calls ? +(100 * drift / calls).toFixed(1) : 0,
  };
}
