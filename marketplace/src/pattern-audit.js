// src/pattern-audit.js — 패턴 SQL 정적 감사 (#192 P0 · #217 결정 반영)
//
// #217 결정(2026-08-09)은 P0 을 두 단계로 갈랐다:
//   P0-a(1차·이 파일이 배선하는 것): 게이트웨이 자기 표 **거부 목록** — 게시자의 실수를 막는다.
//     계약 변경 없음. `denyGate(converted)` 가 `handleRunPattern` 의 실행 직전에 선다.
//   P0-b(2차·미배선): 패턴이 만질 수 있는 표 **허용 목록** — 게시 경로 침해를 막는다.
//     게시 계약(도메인별 allowlist 선언)이 선행이라 뒤로 뺐다. 코어(`auditPatternSql`/
//     `scopeGate`)는 이 파일에 이미 있으므로 계약이 서면 배선만 하면 된다.
//
// 거부 목록은 실수를 막지 침해를 막지 못한다(SQL 을 쓰는 쪽이 적이면 P0-b 가 진짜 통제다) —
// 결정 코멘트의 구분을 그대로 따른다.
//
// 출처: `marketplace/prep/pattern-audit.mjs`(PR #232) 이식. 적대적 검증 3라운드 통과본 —
//   ① 괄호 친 테이블(`FROM (_keys)`) 우회 → 스택 기반 추출기로 수정
//   ② 서브쿼리-로컬 `WITH _keys AS(…)` 로 진짜 내부표 가림 → 스코프 인식 CTE 로 수정
//   ③ sqlite3 set_authorizer 차등 오라클로 "실제 유출 ⟺ 차단" 불변식 확증(431 오탐 0)
// 참조 정본: ASAC-DAG `domains/commerce/include/gold/pattern_audit.py`(레드팀 검증 Python).
// 파싱이 애매하면 **과다 캡처(=거부) 쪽으로 fail-closed** 한다.

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
  "|(?<punct>[(),.;?])" +
  "|(?<other>[^\\s])", "y");
const TOKEN_KINDS = ["ws", "line_comment", "block_comment", "string", "dquote", "bquote",
  "bracket", "param", "number", "ident", "punct", "other"];

// FROM 자리에 허용하는 테이블값 함수 — 배열 IN 관용구(`IN (SELECT value FROM json_each(:list))`)
// 만. `pragma_*` 등 다른 TVF 는 내부/미지 참조로 잡힌다.
export const ALLOWED_TABLE_FUNCS = new Set(["json_each"]);
// 쓰기/DDL 문 **동사** — 문장 위치에서만 위험하다(컬럼/별칭 이름으로 쓰이면 무해).
// SELECT/WITH 단일문 보장 하에서 위험 경로는 둘뿐이라 그 자리만 본다(statementVerb):
//   ① 첫 토큰  ② `WITH <ctes> <VERB> …`(현행 `/^(select|with)/` 정규식이 못 잡는 구멍).
// ⚠️ '아무 데나 있는 토큰'을 막던 방식은 `SELECT x AS replace` 를 오탐했다(prep 레드팀).
export const WRITE_VERBS = new Set(["insert", "update", "delete", "replace", "drop", "alter",
  "create", "attach", "detach", "vacuum", "reindex", "analyze", "pragma"]);
// 표현식 어디에 있어도 위험한 함수 — 정당한 컬럼/함수로 쓰일 일이 없다.
export const DANGEROUS_FN = new Set(["load_extension"]);
// 내부/스키마 테이블 — 어느 dot-세그먼트든 `_` 또는 `sqlite_` 로 시작. 서빙표는 `d1_`/`gold_` 라 안 걸린다.
const INTERNAL_RE = /(^|\.)(_|sqlite_)/i;
export const isInternalRef = (r) => INTERNAL_RE.test(String(r));

// P0-a 거부 목록(#217 결정 코멘트의 표 그대로). `_` 접두는 INTERNAL_RE 가 이미 덮으므로
// 여기엔 **그 규칙이 못 잡는 이름만** 남긴다 — wrangler 마이그레이션 원장 `d1_migrations`.
export const GATEWAY_DENY_TABLES = new Set(["d1_migrations"]);

// FROM 리스트를 **끝내는** 절 키워드(그 뒤 콤마는 테이블이 아니다).
const BOUNDARY_KW = new Set(["where", "group", "order", "having", "limit", "window", "union",
  "except", "intersect", "returning", "values"]);
// 조인 조건 시작 — 지금은 테이블을 안 기다리지만 **리스트는 살아 있다**(뒤의 콤마는 다시 테이블).
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

// (테스트·참고용) 전 WITH 절 CTE 이름 합집합 — **스코프 무시**. 실제 판정은 walkTableRefs 가
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

// FROM/JOIN 절의 테이블 참조 걷기 — 감사 판정의 공용 걸음.
// 🔴 괄호 프레임 스택으로 **괄호 친 테이블/조인**(`(_keys)`·`(a, _keys)`·`JOIN (_keys)`)까지 걷고
//    (prep 레드팀 ①), `WITH` 는 **현재 프레임**에 CTE 를 등록해 서브쿼리-로컬 CTE 가 바깥
//    이름을 못 가리게 한다(prep 레드팀 ② — `(WITH _keys AS(..) …) a, _keys b` 의 바깥 `_keys`).
// onRef(name, cteVisible) 를 테이블 자리 이름마다 부른다. name 은 소문자·dot 결합.
function walkTableRefs(toks, onRef) {
  const n = toks.length;
  const stack = [{ list: false, ctes: new Set() }];
  const top = () => stack[stack.length - 1];
  const visibleCte = (name) => stack.some((f) => f.ctes.has(name));
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
        stack.push({ list: !isSub, ctes: new Set() });        // 파생 테이블은 불투명, 괄호 리스트는 재귀
        expect = !isSub;
      } else stack.push({ list: false, ctes: new Set() });
      i += 1; continue;
    }
    if (kind === "punct" && val === ")") { if (stack.length > 1) stack.pop(); expect = false; i += 1; continue; }
    if (kind === "ident" && (low === "from" || JOIN_KW.has(low))) { top().list = true; expect = true; i += 1; continue; }
    if (kind === "punct" && val === ",") { if (top().list) expect = true; i += 1; continue; }
    if (kind === "ident" && BOUNDARY_KW.has(low)) { top().list = false; expect = false; i += 1; continue; }
    if (kind === "ident" && JOINCOND_KW.has(low)) { expect = false; i += 1; continue; }   // ON/USING: 리스트 유지
    if (kind === "ident" && JOINMOD_KW.has(low)) { i += 1; continue; }                    // 조인 수식어
    if (kind === "ident" && low === "as") { expect = false; i += 1; continue; }           // 별칭 마커
    if (expect && isName([kind, val])) {
      let name = stripIdent(val).toLowerCase(); let j = i + 1;
      while (j + 1 < n && toks[j][0] === "punct" && toks[j][1] === "." && isName(toks[j + 1])) {
        name += "." + stripIdent(toks[j + 1][1]).toLowerCase(); j += 2;
      }
      onRef(name, visibleCte(name));
      expect = false; i = j; continue;
    }
    i += 1;
  }
}

// (테스트·참고용) FROM/JOIN 의 모든 테이블 참조 — CTE 판정 없이 이름만.
export function tableRefs(toks) {
  const refs = [];
  walkTableRefs(toks, (name) => refs.push(name));
  return refs;
}

// P0-b 용: allowlist·json_each·시야에 든 CTE 밖의 테이블 참조를 모은다(스코프 인식).
export function collectExternal(toks, allowedTables) {
  const allowed = allowedTables instanceof Set ? allowedTables
    : new Set([...(allowedTables || [])].map((t) => String(t).toLowerCase()));
  const external = new Set();
  walkTableRefs(toks, (name, cteVisible) => {
    if (allowed.has(name) || ALLOWED_TABLE_FUNCS.has(name)) return;
    if (isInternalRef(name)) external.add(name);              // 내부/스키마는 CTE 로도 못 가린다
    else if (!cteVisible) external.add(name);                 // 시야 밖 이름 = 미지/외부 테이블
  });
  return [...external].sort();
}

// P0-a 용: 내부(`_`·`sqlite_` 접두)·`pragma_*` TVF·명시 거부 이름에 닿는 참조만 모은다.
// `pragma_*` 는 테이블 자리에서만 본다(표현식의 `pragmatic` 컬럼은 여기 안 온다) — allowlist
// 모드에선 "미지 테이블"로 잡히지만 거부 목록 모드엔 그 그물이 없어 명시로 막는다(스키마 정보 유출).
// 거부 이름은 CTE 로도 못 가린다(가리게 두면 `WITH d1_migrations AS(…)` 우회가 열린다 — fail-closed).
export function collectDenied(toks, denied = GATEWAY_DENY_TABLES) {
  const deny = denied instanceof Set ? denied
    : new Set([...(denied || [])].map((t) => String(t).toLowerCase()));
  const badSeg = (seg) => deny.has(seg) || /^pragma_/i.test(seg);
  const denyMatch = (name) => badSeg(name) || name.split(".").some(badSeg);
  const hit = new Set();
  walkTableRefs(toks, (name) => {
    if (ALLOWED_TABLE_FUNCS.has(name)) return;
    if (isInternalRef(name) || denyMatch(name)) hit.add(name);
  });
  return [...hit].sort();
}

// 구조 감사(공통) — 스코프 판정과 무관하게 항상 위험한 모양들.
function structuralFindings(toks) {
  const findings = [];
  if (!toks.length || !(toks[0][0] === "ident" && ["select", "with"].includes(toks[0][1].toLowerCase())))
    findings.push("SELECT/WITH 로 시작하지 않음(읽기 전용 아님)");
  // 단일 문장: 끝의 세미콜론 하나만 허용. 그 앞의 세미콜론은 스택 쿼리.
  const semis = [];
  for (let k = 0; k < toks.length; k++) if (toks[k][0] === "punct" && toks[k][1] === ";") semis.push(k);
  if (semis.length && !(semis.length === 1 && semis[0] === toks.length - 1))
    findings.push("세미콜론 내부 등장 — 복수 문장(스택 쿼리) 의심");
  // 쓰기/DDL: 문장 위치의 동사만 본다(컬럼/별칭 이름 오탐 방지). `WITH x AS(…) DELETE` 를 잡는다.
  const verb = statementVerb(toks);
  if (verb && WRITE_VERBS.has(verb)) findings.push(`쓰기/DDL 문 '${verb}' — 읽기 전용(SELECT/WITH) 아님`);
  for (const [kind, val] of toks)
    if (kind === "ident" && DANGEROUS_FN.has(val.toLowerCase())) { findings.push(`금지 함수 '${val.toLowerCase()}'`); break; }
  return findings;
}

// ── P0-b(미배선): allowlist 감사 — 게시 계약이 서면 scopeGate 를 배선한다 ─────────────
// 위반 사유 문자열 배열 반환(빈 배열 = 통과). allowedTables: 이 패턴이 읽어도 되는 테이블 집합.
export function auditPatternSql(sql, allowedTables) {
  const toks = tokenize(sql);
  const findings = structuralFindings(toks);
  const external = collectExternal(toks, allowedTables);
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

export function scopeGate(sql, allowedTables) {
  const findings = auditPatternSql(sql, allowedTables);
  if (!findings.length) return { ok: true };
  return { ok: false, findings, problem: { status: 400, title: "pattern out of scope", detail: findings.join(" · ") } };
}

// ── P0-a(배선): 거부 목록 게이트 — handleRunPattern 이 실행 직전에 부른다 ────────────
// 구조 감사 + 내부/거부 테이블 참조만 본다. 형제·타 도메인 서빙표(d1_*/gold_*)는 여기서
// 판정하지 않는다(그건 P0-b 의 몫 — 결정 코멘트의 "거부 목록은 실수 방어" 구분 그대로).
export function denyGate(sql, denied = GATEWAY_DENY_TABLES) {
  const toks = tokenize(sql);
  const findings = structuralFindings(toks);
  const hits = collectDenied(toks, denied);
  if (hits.length)
    findings.push(`게이트웨이 내부 표 참조: ${JSON.stringify(hits)} — 패턴 SQL 이 읽을 수 없는 표다`);
  if (!findings.length) return { ok: true };
  return { ok: false, findings, problem: { status: 400, title: "pattern out of scope", detail: findings.join(" · ") } };
}
