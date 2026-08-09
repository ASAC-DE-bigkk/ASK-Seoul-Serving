// prep/run-pattern-ext.mjs — run_pattern 표현력 확장 후보 (#192 P1~P6 · 이식 후보, 미배선)
//
// 게이트웨이 규약(problem+json·`:name` 바인딩·MAX_LIMIT 클램프)을 그대로 지키는 순수 함수들.
// 검증 후 `src/index.js` `handleRunPattern` 의 변환부를 대체/보강하도록 작성했다.
// 🔴 어디에도 import 되지 않는다 — `marketplace/prep/` 폴더를 지우면 사라진다.
//
// 담는 것: P1(선택 파라미터+기본값) · P2(페이지네이션 커서) · P3(배열 IN) · P4(함수 화이트리스트)
//        · P5(서버측 피벗) · P6(식별자 슬롯 — 🔴 고위험, 기본 비활성).
// P0(테이블 스코프)은 `pattern-audit.mjs` 에 별도. P6 는 그 스코프 게이트 재감사에 의존한다.
import { scopeGate } from "./pattern-audit.mjs";

export const MAX_LIMIT = 5000;           // src/index.js MAX_LIMIT 과 같은 값 하나
const LIMIT_PARAM = /^(n|limit|top_n)$/i;
const problem = (status, title, detail) => ({ ok: false, problem: { status, title, detail } });

// ── P1 + P3: 바인딩 변환 (기본값·배열) ─────────────────────────────────────────
// convert(sql, supplied, {defaults}) → { ok, converted, values, declared } | { ok:false, problem }
// 현행 handleRunPattern 611~639 와 동일 규약 + P1(defaults) + P3(배열→?,?,?).
export function convertPattern(sql, supplied, opts = {}) {
  supplied = supplied && typeof supplied === "object" ? supplied : {};
  const defaults = opts.defaults && typeof opts.defaults === "object" ? opts.defaults : {};
  const sqlBody = String(sql || "").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!/^(select|with)\b/i.test(sqlBody)) return problem(400, "pattern not runnable", "SELECT/WITH 패턴만 실행한다");

  const occur = [];
  sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, (_, nm) => { occur.push(nm); return _; });
  const declared = [...new Set(occur)];
  const extra = Object.keys(supplied).filter((k) => !declared.includes(k));
  if (extra.length) return problem(400, "unknown parameter", `선언되지 않은 파라미터: ${extra.join(", ")} — 이 패턴의 파라미터는 [${declared.join(", ")}] 뿐이다`);
  const badDefault = Object.keys(defaults).filter((k) => !declared.includes(k));
  if (badDefault.length) return problem(400, "unknown default", `선언되지 않은 파라미터의 기본값: ${badDefault.join(", ")}`);

  const resolved = {};
  for (const nm of declared) {
    const has = Object.prototype.hasOwnProperty.call(supplied, nm) && supplied[nm] !== undefined && supplied[nm] !== null;
    let v = has ? supplied[nm] : (Object.prototype.hasOwnProperty.call(defaults, nm) ? defaults[nm] : undefined);
    if (v === undefined || v === null) return problem(400, "missing parameter", `파라미터 :${nm} 값이 필요하다 — 이 패턴의 파라미터: [${declared.join(", ")}]`);
    if (Array.isArray(v)) {                                   // P3
      if (v.length === 0) return problem(400, "empty array parameter", `:${nm} 배열이 비었다 — 최소 1개 값이 필요하다`);
      if (v.length > 100) return problem(400, "array too large", `:${nm} 는 최대 100개까지다(카티전 상한)`);
      for (const el of v) if (typeof el !== "string" && typeof el !== "number") return problem(400, "invalid parameter", `:${nm} 배열 원소는 문자열/숫자만 받는다`);
      resolved[nm] = { isArray: true, values: v.slice() }; continue;
    }
    if (typeof v !== "string" && typeof v !== "number") return problem(400, "invalid parameter", `:${nm} 은 문자열/숫자만 받는다`);
    if (LIMIT_PARAM.test(nm)) { const num = Number(v); if (!Number.isFinite(num)) return problem(400, "invalid parameter", `:${nm} 은 숫자여야 한다`); v = Math.min(num, MAX_LIMIT); }
    resolved[nm] = { isArray: false, value: v };
  }
  const values = [];
  const converted = sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, (_, nm) => {
    const r = resolved[nm];
    if (r.isArray) { for (const x of r.values) values.push(x); return r.values.map(() => "?").join(","); }
    values.push(r.value); return "?";
  });
  return { ok: true, converted, values, declared };
}

// ── P2: 키셋 커서 코덱 (handleData 와 동형) ────────────────────────────────────
// run_pattern 응답에 has_more/next_cursor 를 붙이기 위한 도구. 커서에 발행시각을 실어
// 다른 발행의 커서를 409 로 거절(rowid 재매김 방지) — handleData 규약과 같다.
// ⚠️ 임의 패턴 SQL 에 키셋 조건을 안전하게 주입하는 것은 "ORDER BY rowid" 규약이 선행이다(#192 P2).
//    여기서는 코덱 + 결과단 페이지네이션(pageRows)만 제공한다.
const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const encodeCursor = (stamp, rid) => b64url(`${rid}@${stamp}`);
export function decodeCursor(raw) {
  let text; try { text = Buffer.from(String(raw).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return null; }
  const at = text.indexOf("@"); if (at < 1) return null;
  const rid = Number(text.slice(0, at));
  if (!Number.isSafeInteger(rid) || rid < 0) return null;
  return { rid, stamp: text.slice(at + 1) };
}
// 게이트웨이가 limit+1 로 떠서 넘긴 rows 를 페이지로 나눈다. keyOf(row)=결정적 정렬 키(예: _rid).
export function pageRows(rows, { pageSize, stamp, keyOf }) {
  const size = Math.min(Math.max(1, pageSize | 0), MAX_LIMIT);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page.length ? keyOf(page[page.length - 1]) : null;
  return { rows: page, has_more: hasMore, next_cursor: hasMore ? encodeCursor(stamp, last) : null };
}

// ── P4: 함수 화이트리스트 (대부분 명문화) ──────────────────────────────────────
// #192 실측(2026-08-08 실 D1): 아래는 보장. REGEXP·stddev·corr 는 **미보장**(사전계산/FTS 로).
export const SQL_FUNCTION_ALLOWLIST = new Set([
  "abs", "round", "ceil", "floor", "min", "max", "sum", "count", "avg", "total",
  "coalesce", "nullif", "ifnull", "cast", "length", "substr", "instr", "trim", "ltrim", "rtrim",
  "lower", "upper", "replace", "sqrt", "pow", "power", "exp", "log", "cos", "sin", "tan",
  "acos", "asin", "atan", "atan2", "radians", "degrees", "pi", "mod", "sign",
  "date", "datetime", "strftime", "julianday", "row_number", "rank", "dense_rank", "ntile",
  "lag", "lead", "first_value", "last_value", "json_each", "json_extract", "group_concat",
]);
// SQL 에서 호출된 함수 이름을 뽑는다(식별자 바로 뒤 `(`). 보장 밖 함수는 게시 검토·경보용.
export function functionsUsed(sql) {
  const used = new Set();
  const s = String(sql || "").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([a-z_][a-z0-9_]*)\s*\(/gi; let m;
  while ((m = re.exec(s))) used.add(m[1].toLowerCase());
  return used;
}
export function unguaranteedFunctions(sql, allow = SQL_FUNCTION_ALLOWLIST) {
  // SQL 키워드(호출처럼 보이는 절)는 함수가 아니다 — 제외.
  const KW = new Set(["select", "from", "where", "group", "order", "by", "having", "on", "using", "and", "or", "in", "not", "as", "when", "case", "then", "else", "end", "union", "all", "values", "with"]);
  return [...functionsUsed(sql)].filter((f) => !allow.has(f) && !KW.has(f)).sort();
}

// ── P5: 서버측 동적 피벗 (SQL 불변, 결과 후처리) ──────────────────────────────
// 검증된 롱(long) 결과를 와이드(wide)로 변형. SQL 은 안 건드리므로 감사도 그대로 통과.
// maxCols 로 컬럼 카디널리티 폭발을 막는다.
export function pivot(rows, { row, col, val, maxCols = 50, agg = "last" }) {
  if (!Array.isArray(rows)) return problem(400, "invalid rows", "rows 는 배열이어야 한다");
  const cols = [...new Set(rows.map((r) => String(r[col])))];
  if (cols.length > maxCols) return problem(400, "too many pivot columns", `피벗 컬럼 ${cols.length} > 상한 ${maxCols}`);
  const byRow = new Map();
  for (const r of rows) {
    const k = String(r[row]);
    if (!byRow.has(k)) byRow.set(k, { [row]: r[row] });
    const cur = byRow.get(k); const c = String(r[col]);
    cur[c] = agg === "sum" ? (Number(cur[c] || 0) + Number(r[val] || 0)) : r[val];
  }
  return { ok: true, columns: [row, ...cols], rows: [...byRow.values()] };
}

// ── P6: 화이트리스트 식별자 슬롯 (🔴 유일 고위험 — 기본 비활성) ────────────────
// `@{name}` 을 소비자가 고른 리터럴로 **치환**(bind 아님). 값이 allow 목록에 정확히 있을 때만.
// allow 미선언이면 거부. 치환 후 반드시 scopeGate 로 재감사(P0)한다 — 이 셋이 없으면 P0 문제가
// 그대로 터진다(`order_col="(SELECT key_hash FROM _keys)"`). 그래서 **적용은 P0 이후·보안 리뷰 후**.
export const P6_IDENTIFIER_SLOTS_ENABLED = false;   // 🔴 켜지 마라. 적용 결정 전까지 false.
export function resolveIdentifierSlots(sql, slots, supplied, { allowedTables, enabled = P6_IDENTIFIER_SLOTS_ENABLED } = {}) {
  if (!enabled) return problem(403, "identifier slots disabled", "P6 식별자 슬롯은 비활성이다(P0·보안 리뷰 전 적용 금지)");
  slots = slots && typeof slots === "object" ? slots : {};
  supplied = supplied && typeof supplied === "object" ? supplied : {};
  const wanted = [];
  String(sql || "").replace(/@\{([a-z_][a-z0-9_]*)\}/gi, (_, nm) => { wanted.push(nm); return _; });
  for (const nm of new Set(wanted)) {
    const slot = slots[nm];
    if (!slot || !Array.isArray(slot.allow) || slot.allow.length === 0) return problem(400, "identifier slot not allowlisted", `@{${nm}} 은 allow 목록이 선언돼야 한다`);
    const v = supplied[nm];
    if (v === undefined || v === null) return problem(400, "missing identifier slot", `@{${nm}} 값이 필요하다`);
    if (!slot.allow.includes(v)) return problem(400, "identifier not in allowlist", `@{${nm}}='${v}' 는 허용 목록 [${slot.allow.join(", ")}] 밖이다`);
  }
  const substituted = String(sql).replace(/@\{([a-z_][a-z0-9_]*)\}/gi, (_, nm) => String(supplied[nm]));
  const gate = scopeGate(substituted, allowedTables || []);   // 치환 후 재감사(3중 방어)
  if (!gate.ok) return gate;
  return { ok: true, sql: substituted };
}
