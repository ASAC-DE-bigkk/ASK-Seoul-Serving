// prep/pattern-audit.mjs — P0 테이블 스코프 정적 감사 (#192 P0 · 이식 후보, 미배선)
//
// 🎯 목적: 게이트웨이(`src/index.js` `handleRunPattern`)는 저장 패턴 SQL 의 주석을 벗기고
//    SELECT/WITH 만 통과시킨 뒤 `:name` 을 prepared bind 한다(값 인젝션 차단). 그러나
//    **그 SQL 이 어느 테이블을 읽는지는 검사하지 않는다.** 저장 SQL 은 공유 D1 전체
//    (`_keys`·`_usage`·타 도메인 `d1_*`)에 verbatim 실행되므로, 콤마 조인 하나로 내부표를
//    붙여 읽을 수 있다(#192 §0 레드팀 확증). 이 모듈이 그 경계를 **실행 직전 기계 검사**로 만든다.
//
// 🔴 이식 지점(적용 시): `handleRunPattern` 의 `env.DB.prepare(converted).bind(...values).all()`
//    **직전**. `scopeGate(converted, allowedTables)` 가 위반을 주면 400 `pattern out of scope`.
//    지금은 **어디에도 import 되지 않는다** — `marketplace/prep/` 폴더를 지우면 사라진다.
//
// 참조 구현(정본): ASAC-DAG `domains/commerce/include/gold/pattern_audit.py`(토크나이저 기반).
//    정규식("FROM 뒤 첫 식별자")은 콤마 조인을 못 잡아 레드팀이 뚫었다 → 토크나이저로 교체.
//    파싱이 애매하면 **과다 캡처(=거부) 쪽으로 fail-closed** 한다.

// 토크나이저 — 문자열/주석/인용 식별자를 원자로 보므로 그 안의 `;`·키워드·콤마에 안 속는다.
// sticky(y) 로 좌→우 연속 매칭을 강제한다(`other`·`ws` 가 모든 문자를 덮어 빈틈이 없다).
const TOKEN_RE = new RegExp(
  "(?<ws>\\s+)" +
  "|(?<line_comment>--[^\\n]*)" +
  "|(?<block_comment>/\\*[\\s\\S]*?\\*/)" +
  "|(?<string>'(?:[^']|'')*')" +
  "|(?<dquote>\"(?:[^\"]|\"\")*\")" +
  "|(?<bquote>`(?:[^`]|``)*`)" +
  "|(?<bracket>\\[[^\\]]*\\])" +
  "|(?<param>:[a-zA-Z_][a-zA-Z0-9_]*)" +
  "|(?<number>\\d+\\.?\\d*)" +
  "|(?<ident>[a-zA-Z_][a-zA-Z0-9_]*)" +
  "|(?<punct>[(),.;])" +
  "|(?<other>[^\\s])", "y");
const TOKEN_KINDS = ["ws", "line_comment", "block_comment", "string", "dquote", "bquote",
  "bracket", "param", "number", "ident", "punct", "other"];

// FROM 자리에 허용하는 테이블값 함수 — 배열 IN 관용구(`IN (SELECT value FROM json_each(:list))`)
// 만. `pragma_*` 등 다른 TVF 는 아래 금지 접두사로 차단된다.
export const ALLOWED_TABLE_FUNCS = new Set(["json_each"]);
// 쓰기/DDL 문 **동사** — 문장 위치에서만 위험하다(컬럼/별칭 이름으로 쓰이면 무해).
// SELECT/WITH 단일문 보장 하에서 위험 경로는 둘뿐이라 그 자리만 본다(statementVerb):
//   ① 첫 토큰(=start 검사)  ② `WITH <ctes> <VERB> …`.
// ⚠️ '아무 데나 있는 토큰'을 막던 이전 방식은 `SELECT x AS replace`·`SELECT pragmatic` 을 오탐했다(레드팀).
export const WRITE_VERBS = new Set(["insert", "update", "delete", "replace", "drop", "alter",
  "create", "attach", "detach", "vacuum", "reindex", "analyze"]);
// 표현식 어디에 있어도 위험한 함수 — 정당한 컬럼/함수로 쓰일 일이 없다.
export const DANGEROUS_FN = new Set(["load_extension"]);
// 내부/스키마 테이블 이름 — 어느 dot-세그먼트든 `_` 또는 `sqlite_` 로 시작. 서빙표는 `d1_`/`gold_` 라 안 걸린다.
// `PRAGMA 문` 은 start 검사가, `pragma_*` TVF 는 테이블 스코프 검사가 잡는다(접두사 매칭은 오탐이라 안 쓴다).
const INTERNAL_RE = /(^|\.)(_|sqlite_)/i;
export const isInternalRef = (r) => INTERNAL_RE.test(String(r));
// FROM 리스트를 **끝내는** 절 키워드(그 뒤 콤마는 테이블이 아니다).
const BOUNDARY_KW = new Set(["where", "group", "order", "having", "limit", "window", "union",
  "except", "intersect", "returning", "values"]);
// 조인 조건 시작 — 지금은 테이블을 안 기다리지만 **리스트는 살아 있다**(뒤의 콤마는 다시 테이블).
// 예: `FROM a JOIN b ON x=y, c` 의 c 를 놓치지 않기 위해 BOUNDARY 와 분리한다(레드팀 확증).
const JOINCOND_KW = new Set(["on", "using"]);
const JOIN_KW = new Set(["join"]);
const JOINMOD_KW = new Set(["cross", "inner", "left", "right", "full", "outer", "natural"]);
const LIMIT_PARAM_RE = /^(n|limit|top_n)$/i;

const stripIdent = (v) => v.replace(/^["`[\]]+/, "").replace(/["`[\]]+$/, "");

export function tokenize(sql) {
  const toks = [];
  const s = sql || "";
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < s.length) {
    const m = TOKEN_RE.exec(s);
    if (!m) break;                       // 이론상 도달 안 함(other 가 모든 비공백을 덮는다)
    let kind = "other";
    for (const k of TOKEN_KINDS) { if (m.groups[k] !== undefined) { kind = k; break; } }
    if (kind === "ws" || kind === "line_comment" || kind === "block_comment") continue;
    toks.push([kind, m[0]]);
  }
  return toks;
}

// `(` 위치에서 시작하는 균형 괄호를 건너뛴 다음 인덱스.
function skipParens(toks, j) {
  let depth = 0;
  for (; j < toks.length; j++) {
    if (toks[j][0] === "punct" && toks[j][1] === "(") depth += 1;
    else if (toks[j][0] === "punct" && toks[j][1] === ")") { depth -= 1; if (depth === 0) return j + 1; }
  }
  return j;
}
const isName = (t) => t && ["ident", "dquote", "bquote", "bracket"].includes(t[0]);

// 단일 WITH 절의 CTE 이름 집합과 절이 끝나는 인덱스. toks[i] 는 'with'.
// `WITH [RECURSIVE] NAME [(cols)] AS [NOT] [MATERIALIZED] ( body ) [, …]` 를 파싱한다.
function withCtesAt(toks, i) {
  const names = new Set(); const n = toks.length;
  let j = i + 1;
  if (j < n && toks[j][0] === "ident" && toks[j][1].toLowerCase() === "recursive") j += 1;
  while (j < n) {
    if (!isName(toks[j])) break;
    const name = stripIdent(toks[j][1]).toLowerCase(); j += 1;
    if (j < n && toks[j][0] === "punct" && toks[j][1] === "(") j = skipParens(toks, j);   // 선택 컬럼목록
    if (!(j < n && toks[j][0] === "ident" && toks[j][1].toLowerCase() === "as")) break;
    j += 1;
    if (j < n && toks[j][0] === "ident" && toks[j][1].toLowerCase() === "not") j += 1;
    if (j < n && toks[j][0] === "ident" && toks[j][1].toLowerCase() === "materialized") j += 1;
    if (!(j < n && toks[j][0] === "punct" && toks[j][1] === "(")) break;
    names.add(name); j = skipParens(toks, j);
    if (j < n && toks[j][0] === "punct" && toks[j][1] === ",") { j += 1; continue; }
    break;
  }
  return { names, end: j };
}

// (테스트·참고용) 전 WITH 절 CTE 이름 합집합 — **스코프 무시**. 실제 판정은 collectExternal 이
// 스코프로 한다(전역 합집합은 서브쿼리-로컬 CTE 오염에 취약해 직접 쓰면 안 된다).
export function cteNames(toks) {
  const names = new Set();
  for (let i = 0; i < toks.length; i++)
    if (toks[i][0] === "ident" && toks[i][1].toLowerCase() === "with")
      for (const c of withCtesAt(toks, i).names) names.add(c);
  return names;
}

// 문장 동사 — SELECT/WITH 단일문에서 실제 쓰기가 될 수 있는 유일한 자리.
// `WITH <ctes> <VERB>` 의 VERB 를 돌려준다(CTE 절을 건너뛴 뒤 첫 토큰). WITH 가 아니면 첫 토큰.
export function statementVerb(toks) {
  if (!toks.length) return null;
  if (!(toks[0][0] === "ident" && toks[0][1].toLowerCase() === "with"))
    return toks[0][0] === "ident" ? toks[0][1].toLowerCase() : null;
  const { end } = withCtesAt(toks, 0);
  return end < toks.length && toks[end][0] === "ident" ? toks[end][1].toLowerCase() : null;
}

// FROM/JOIN 절의 **모든** 테이블 참조를 열거한다.
// 🔴 괄호 프레임 스택으로 **괄호 친 테이블/조인**(`(_keys)`·`(a, _keys)`·`JOIN (_keys)`)까지 잡는다.
//    이전 판(참조 구현 포함)은 FROM 뒤 `(` 를 무조건 서브쿼리로 보고 건너뛰어, SQLite 문법상
//    허용되는 괄호 친 테이블을 놓쳤다(레드팀 확증 — `SELECT * FROM (_keys)` 가 통과했다).
//    판별: `(` 다음이 SELECT/WITH/VALUES 면 서브쿼리(불투명), 아니면 **괄호 친 테이블 리스트**(재귀).
export function tableRefs(toks) {
  const refs = [];
  const n = toks.length;
  const stack = [{ list: false }];                     // 괄호 프레임. list = 이 프레임이 FROM 리스트 수집 중인가
  const top = () => stack[stack.length - 1];
  let expect = false;                                  // 다음 이름 토큰이 테이블인가
  let i = 0;
  while (i < n) {
    const [kind, val] = toks[i];
    const low = kind === "ident" ? val.toLowerCase() : null;
    if (kind === "punct" && val === "(") {
      if (expect) {
        const nxt = toks[i + 1];
        const isSub = nxt && nxt[0] === "ident" && ["select", "with", "values"].includes(nxt[1].toLowerCase());
        if (isSub) { stack.push({ list: false }); expect = false; }   // 파생 테이블 — 내부 FROM 은 선형 스캔이 잡는다
        else { stack.push({ list: true }); expect = true; }           // 괄호 친 테이블 리스트 — 안쪽도 테이블
      } else stack.push({ list: false });              // 표현식/함수 인자 괄호
      i += 1; continue;
    }
    if (kind === "punct" && val === ")") {
      if (stack.length > 1) stack.pop();
      expect = false;                                  // 테이블/서브쿼리 뒤엔 별칭이 올 수 있다
      i += 1; continue;
    }
    if (kind === "ident" && (low === "from" || JOIN_KW.has(low))) { top().list = true; expect = true; i += 1; continue; }
    if (kind === "punct" && val === ",") { if (top().list) expect = true; i += 1; continue; }
    if (kind === "ident" && BOUNDARY_KW.has(low)) { top().list = false; expect = false; i += 1; continue; }
    if (kind === "ident" && JOINCOND_KW.has(low)) { expect = false; i += 1; continue; }   // ON/USING: 리스트 유지
    if (kind === "ident" && JOINMOD_KW.has(low)) { i += 1; continue; }                    // 조인 수식어
    if (kind === "ident" && low === "as") { expect = false; i += 1; continue; }           // 별칭 마커
    if (expect && isName([kind, val])) {
      let name = stripIdent(val); let j = i + 1;
      while (j + 1 < n && toks[j][0] === "punct" && toks[j][1] === "." && isName(toks[j + 1])) {
        name += "." + stripIdent(toks[j + 1][1]); j += 2;
      }
      refs.push(name); expect = false; i = j; continue;
    }
    i += 1;
  }
  return refs;
}

// 🔴 **스코프 인식** 외부 테이블 수집기 — allowlist·json_each·**시야에 든 CTE** 밖의 테이블 참조를 모은다.
//    괄호 프레임 스택으로 CTE 가시성을 추적한다: `WITH` 는 **현재 프레임**에 CTE 이름을 등록하고,
//    서브쿼리(`(`)로 들어가면 새 프레임을 쌓아 부모 CTE 는 물려받되(상관 서브쿼리) **자식이 만든
//    CTE 는 프레임이 닫히면 사라진다.** 그래서 `(WITH _keys AS(..) SELECT..) a, _keys b` 의 바깥
//    `_keys` 는 시야 밖이라 진짜 테이블로 잡힌다(레드팀 확증 — 전역 CTE 합집합은 이걸 놓쳤다).
export function collectExternal(toks, allowedTables) {
  const allowed = allowedTables instanceof Set ? allowedTables : new Set([...(allowedTables || [])].map((t) => String(t).toLowerCase()));
  const n = toks.length;
  const stack = [{ list: false, ctes: new Set() }];
  const top = () => stack[stack.length - 1];
  const visibleCte = (name) => stack.some((f) => f.ctes.has(name));
  const external = new Set();
  let expect = false, i = 0;
  while (i < n) {
    const [kind, val] = toks[i];
    const low = kind === "ident" ? val.toLowerCase() : null;
    if (kind === "ident" && low === "with") {                 // 현재 프레임에 CTE 이름 등록
      for (const c of withCtesAt(toks, i).names) top().ctes.add(c);
      i += 1; continue;
    }
    if (kind === "punct" && val === "(") {
      if (expect) {
        const nxt = toks[i + 1];
        const isSub = nxt && nxt[0] === "ident" && ["select", "with", "values"].includes(nxt[1].toLowerCase());
        stack.push({ list: !isSub, ctes: new Set() });
        expect = !isSub;
      } else stack.push({ list: false, ctes: new Set() });
      i += 1; continue;
    }
    if (kind === "punct" && val === ")") { if (stack.length > 1) stack.pop(); expect = false; i += 1; continue; }
    if (kind === "ident" && (low === "from" || JOIN_KW.has(low))) { top().list = true; expect = true; i += 1; continue; }
    if (kind === "punct" && val === ",") { if (top().list) expect = true; i += 1; continue; }
    if (kind === "ident" && BOUNDARY_KW.has(low)) { top().list = false; expect = false; i += 1; continue; }
    if (kind === "ident" && JOINCOND_KW.has(low)) { expect = false; i += 1; continue; }
    if (kind === "ident" && JOINMOD_KW.has(low)) { i += 1; continue; }
    if (kind === "ident" && low === "as") { expect = false; i += 1; continue; }
    if (expect && isName([kind, val])) {
      let name = stripIdent(val).toLowerCase(); let j = i + 1;
      while (j + 1 < n && toks[j][0] === "punct" && toks[j][1] === "." && isName(toks[j + 1])) {
        name += "." + stripIdent(toks[j + 1][1]).toLowerCase(); j += 2;
      }
      if (!(allowed.has(name) || ALLOWED_TABLE_FUNCS.has(name))) {
        if (isInternalRef(name)) external.add(name);          // 내부/스키마는 CTE 로도 못 가린다
        else if (!visibleCte(name)) external.add(name);       // 시야 밖 이름 = 미지/외부 테이블
      }
      expect = false; i = j; continue;
    }
    i += 1;
  }
  return [...external].sort();
}

// 패턴 SQL 하나를 감사한다. 위반 사유 문자열 배열 반환(빈 배열 = 통과).
// allowedTables: 이 패턴이 읽어도 되는 테이블 집합(제품 선언 d1_table ± 명시 공용 축). 소문자로 맞춘다.
export function auditPatternSql(sql, allowedTables) {
  const allowed = new Set([...(allowedTables || [])].map((t) => String(t).toLowerCase()));
  const findings = [];
  const toks = tokenize(sql);
  if (!toks.length || !(toks[0][0] === "ident" && ["select", "with"].includes(toks[0][1].toLowerCase())))
    findings.push("SELECT/WITH 로 시작하지 않음(읽기 전용 아님)");
  // 단일 문장: 끝의 세미콜론 하나만 허용. 그 앞의 세미콜론은 스택 쿼리.
  const semis = [];
  for (let k = 0; k < toks.length; k++) if (toks[k][0] === "punct" && toks[k][1] === ";") semis.push(k);
  if (semis.length && !(semis.length === 1 && semis[0] === toks.length - 1))
    findings.push("세미콜론 내부 등장 — 복수 문장(스택 쿼리) 의심");
  // 쓰기/DDL: 문장 위치의 동사만 본다(컬럼/별칭 이름 오탐 방지).
  const verb = statementVerb(toks);
  if (verb && WRITE_VERBS.has(verb)) findings.push(`쓰기/DDL 문 '${verb}' — 읽기 전용(SELECT/WITH) 아님`);
  // 표현식 어디에 있든 위험한 함수(load_extension 등).
  for (const [kind, val] of toks) if (kind === "ident" && DANGEROUS_FN.has(val.toLowerCase())) { findings.push(`금지 함수 '${val.toLowerCase()}'`); break; }

  const external = collectExternal(toks, allowed);   // 스코프 인식(서브쿼리-로컬 CTE 오염 방어)
  if (external.length)
    findings.push(`allowlist 밖 테이블 참조: ${JSON.stringify(external)} — 선언 제품 테이블만 허용(내부/타도메인 차단)`);
  // 행수 상한이 상한이려면 파라미터 이름이 n/limit/top_n 여야 게이트웨이가 clamp 한다.
  for (let k = 0; k < toks.length - 1; k++) {
    if (toks[k][0] === "ident" && toks[k][1].toLowerCase() === "limit" && toks[k + 1][0] === "param") {
      const pname = toks[k + 1][1].slice(1);
      if (!LIMIT_PARAM_RE.test(pname)) findings.push(`LIMIT :${pname} — 행수 파라미터는 n/limit/top_n 이름만 상한(5000)이 걸린다`);
    }
  }
  return findings;
}

// 게이트웨이 이식용 얇은 래퍼 — problem+json 모양으로 돌려준다(적용 시 handleRunPattern 에서 사용).
// { ok:true } | { ok:false, problem:{status,title,detail}, findings:[...] }
export function scopeGate(sql, allowedTables) {
  const findings = auditPatternSql(sql, allowedTables);
  if (!findings.length) return { ok: true };
  return { ok: false, findings, problem: { status: 400, title: "pattern out of scope", detail: findings.join(" · ") } };
}

// 여러 패턴 일괄 — (pattern_id → 위반 배열). 위반 없는 것은 넣지 않는다.
export function auditPatterns(patterns, allowedTables) {
  const out = {};
  for (const p of patterns || []) {
    const f = auditPatternSql(p.sql || "", allowedTables);
    if (f.length) out[String(p.pattern_id)] = f;
  }
  return out;
}
