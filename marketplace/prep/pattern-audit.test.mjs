// prep/pattern-audit.test.mjs — P0 감사기 회귀·레드팀 (미배선 · 실행: node --test marketplace/prep/pattern-audit.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditPatternSql, scopeGate, tableRefs, tokenize, cteNames } from "./pattern-audit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OK = new Set(["d1_ok", "d1_sibling"]);   // 이 패턴이 읽어도 되는 테이블

// ── 레드팀: 내부/타도메인 테이블에 닿는 페이로드는 전부 거부되어야 한다 ────────────────
const ATTACKS = [
  ["콤마 암시적 크로스 조인", "SELECT * FROM d1_ok, _keys"],
  ["명시적 JOIN 내부표", "SELECT * FROM d1_ok c JOIN _keys k ON 1=1"],
  ["파생 테이블 뒤 콤마", "SELECT * FROM (SELECT 1) x, _keys"],
  ["스칼라 서브쿼리 내부표", "SELECT (SELECT key_hash FROM _keys LIMIT 1) AS h FROM d1_ok"],
  ["스키마 한정 main._keys", "SELECT * FROM main._keys"],
  ["pragma TVF", "SELECT * FROM d1_ok c, pragma_table_info('_keys') t"],
  ["스택 쿼리(세미콜론)", "SELECT * FROM d1_ok; DROP TABLE _keys"],
  ["CTE 본문 내부표", "WITH x AS (SELECT * FROM _keys) SELECT * FROM x"],
  ["UNION 내부표", "SELECT a FROM d1_ok UNION ALL SELECT key_hash FROM _keys"],
  ["비-SELECT (DELETE)", "DELETE FROM d1_ok"],
  ["ATTACH", "ATTACH DATABASE 'x.db' AS y; SELECT 1"],
  ["인용 식별자 우회 시도", 'SELECT * FROM d1_ok, "_keys"'],
  ["대소문자 섞기", "SeLeCt * FrOm d1_ok , _KEYS"],
  ["주석으로 감춘 콤마조인", "SELECT * FROM d1_ok /* x */, _keys"],
  ["타 도메인 테이블", "SELECT * FROM d1_ok JOIN d1_other_domain ON 1=1"],
  // ── 레드팀(wf) 확증: 괄호 친 테이블 참조 계열 (SQLite 는 `(table)` 을 허용한다) ──
  ["괄호 친 테이블", "SELECT * FROM (_keys)"],
  ["공백 낀 괄호 테이블", "SELECT * FROM ( _keys )"],
  ["이중 괄호 테이블", "SELECT * FROM ((_keys))"],
  ["괄호 조인 피연산자", "SELECT * FROM d1_ok JOIN (_keys) ON 1=1"],
  ["콤마 + 괄호 테이블", "SELECT * FROM d1_ok, (_keys)"],
  ["괄호 테이블 먼저", "SELECT * FROM (_keys), d1_ok"],
  ["괄호 친 조인절", "SELECT * FROM (_keys JOIN d1_ok ON 1=1)"],
  ["괄호 친 콤마 리스트", "SELECT * FROM (d1_ok, _keys)"],
  ["LEFT JOIN 괄호", "SELECT * FROM d1_ok LEFT JOIN (_keys) ON 1=1"],
  ["CROSS JOIN 괄호 로그표", "SELECT * FROM d1_ok CROSS JOIN (_gateway_request_log)"],
  ["파생테이블 뒤 괄호조인", "SELECT * FROM (SELECT 1) t JOIN (_keys) ON 1=1"],
  ["별칭 붙은 괄호 테이블", "SELECT * FROM (_keys) a, d1_ok b"],
  ["괄호 테이블 UNION", "SELECT * FROM (_keys) UNION SELECT * FROM d1_ok"],
  ["파생테이블 안 괄호테이블", "SELECT * FROM (SELECT * FROM (_keys)) x"],
  ["CTE 본문 괄호테이블", "WITH x AS (SELECT * FROM (_keys)) SELECT * FROM x"],
  ["IN 서브쿼리 괄호테이블", "SELECT * FROM d1_ok WHERE id IN (SELECT id FROM (_keys))"],
  ["괄호 리스트에 TVF+금지", "SELECT * FROM (json_each(:list), _keys)"],
  ["ON 뒤 콤마 테이블", "SELECT * FROM d1_ok JOIN d1_ok ON 1=1, _keys"],
  ["schema 한정 괄호", "SELECT * FROM (main._keys)"],
  ["sqlite_master 괄호", "SELECT * FROM (sqlite_master)"],
  // ── 확인 레드팀(wf2) 확증: CTE 스코프 오염 (서브쿼리-로컬 CTE 로 진짜 내부표를 가림) ──
  ["CTE 스코프 오염 콤마", "SELECT * FROM (WITH _keys AS (SELECT 1 AS k) SELECT * FROM _keys) a, _keys b"],
  ["CTE 스코프 오염 UNION", "SELECT k,v FROM (WITH _keys AS (SELECT 1 AS k, 2 AS v) SELECT * FROM _keys) UNION ALL SELECT k,v FROM _keys"],
  ["CTE 스코프 오염 sqlite_master", "SELECT name,type FROM (WITH sqlite_master AS (SELECT 1 AS k) SELECT * FROM sqlite_master) a, sqlite_master b"],
  ["WITH 접두 DELETE", "WITH x AS (SELECT 1) DELETE FROM _keys"],
  ["WITH 접두 REPLACE INTO", "WITH x AS (SELECT 1) REPLACE INTO _keys VALUES (1)"],
];
for (const [name, sql] of ATTACKS) {
  test(`거부: ${name}`, () => {
    const findings = auditPatternSql(sql, OK);
    assert.ok(findings.length > 0, `막혀야 하는데 통과함: ${sql}\n→ ${JSON.stringify(findings)}`);
    assert.equal(scopeGate(sql, OK).ok, false);
  });
}

// ── 정상: 자기 테이블·형제 서빙 테이블·json_each·CTE·자기조인은 통과해야 한다 ──────────
const LEGIT = [
  ["단순 필터+정렬+LIMIT :n", "SELECT a,b FROM d1_ok WHERE g = :gu ORDER BY a DESC LIMIT :n"],
  ["집계", "SELECT gu, SUM(x) AS s FROM d1_ok GROUP BY gu ORDER BY s DESC"],
  ["json_each 배열 IN", "SELECT * FROM d1_ok WHERE g IN (SELECT value FROM json_each(:gus))"],
  ["자기 테이블 CTE", "WITH t AS (SELECT * FROM d1_ok) SELECT * FROM t"],
  ["자기 조인", "SELECT * FROM d1_ok c JOIN d1_ok d ON c.id = d.id"],
  ["형제 서빙 테이블 조인", "SELECT * FROM d1_ok JOIN d1_sibling ON d1_ok.k = d1_sibling.k"],
  ["서브쿼리(자기 테이블)", "SELECT * FROM (SELECT a FROM d1_ok) x WHERE x.a > :min"],
  ["끝 세미콜론 하나", "SELECT * FROM d1_ok;"],
  // ── 레드팀(wf) 오탐 확증: 아래 정상 패턴을 잘못 막았었다 ──
  ["REPLACE() 스칼라 함수", "SELECT REPLACE(name, '_', ' ') AS clean FROM d1_ok"],
  ["재귀 CTE", "WITH RECURSIVE tree AS (SELECT id, parent FROM d1_ok WHERE parent IS NULL UNION ALL SELECT d.id, d.parent FROM d1_ok d JOIN tree ON d.parent = tree.id) SELECT * FROM tree"],
  ["재귀 카운터 CTE", "WITH RECURSIVE cnt AS (SELECT 1 AS x UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT o.id FROM d1_ok o JOIN cnt ON o.id = cnt.x"],
  ["컬럼목록 CTE", "WITH t(a, b) AS (SELECT category, COUNT(*) FROM d1_ok GROUP BY category) SELECT a, b FROM t WHERE b > 2"],
  ["형제 콤마 조인", "SELECT * FROM d1_ok, d1_sibling WHERE d1_ok.k = d1_sibling.k"],
  ["ON 뒤 콤마 정상 테이블", "SELECT * FROM d1_ok JOIN d1_sibling ON 1=1, d1_ok x"],
  // ── 확인 레드팀(wf2) 오탐 확증: 아래 정상 패턴을 잘못 막았었다 ──
  ["pragma 로 시작하는 컬럼", "SELECT pragmatic FROM d1_ok"],
  ["pragma_ 별칭", "SELECT x AS pragma_note FROM d1_ok"],
  ["replace 별칭", "SELECT x AS replace FROM d1_ok"],
  ["replace 스칼라 함수", "SELECT replace(a, '_', ' ') FROM d1_ok"],
];
for (const [name, sql] of LEGIT) {
  test(`통과: ${name}`, () => {
    const findings = auditPatternSql(sql, OK);
    assert.equal(findings.length, 0, `통과해야 하는데 막힘: ${sql}\n→ ${JSON.stringify(findings)}`);
  });
}

// ── 유닛: 추출기 세부 ────────────────────────────────────────────────────────
test("tableRefs 가 콤마 조인의 두 번째 테이블을 잡는다", () => {
  const refs = tableRefs(tokenize("SELECT * FROM d1_ok, _keys")).map((r) => r.toLowerCase());
  assert.deepEqual(refs.sort(), ["_keys", "d1_ok"]);
});
test("cteNames 는 깊이 0 의 WITH 별칭만 잡는다", () => {
  const names = cteNames(tokenize("WITH t AS (SELECT x AS y FROM d1_ok) SELECT * FROM t"));
  assert.ok(names.has("t") && !names.has("y"));
});
test("LIMIT :비표준이름 은 상한 미적용으로 findings", () => {
  assert.ok(auditPatternSql("SELECT * FROM d1_ok LIMIT :maxrows", OK).some((f) => f.includes("LIMIT")));
  assert.equal(auditPatternSql("SELECT * FROM d1_ok LIMIT :n", OK).length, 0);
});

// ── 회귀: 실제 카탈로그 431 패턴 (오탐 0) ─────────────────────────────────────
test("실측 431 패턴: 서빙 테이블 allowlist 로 오탐 0 · 내부표 참조 0", () => {
  const snap = JSON.parse(readFileSync(join(HERE, "catalog-snapshot.json"), "utf8"));
  const serving = new Set(snap.servingTables.map((t) => t.toLowerCase()));
  let total = 0, clean = 0, external = 0;
  for (const p of snap.products) for (const pat of p.patterns) {
    total++;
    const f = auditPatternSql(pat.sql, serving);
    if (f.length === 0) clean++;
    if (f.some((x) => x.includes("allowlist 밖"))) external++;
  }
  assert.equal(total, 431);
  assert.equal(clean, 431, "실제 패턴이 오탐으로 막히면 안 된다");
  assert.equal(external, 0);
});

test("회귀: 실제 패턴이 쓰는 테이블에 _keys 를 콤마조인하면 전부 거부된다", () => {
  const snap = JSON.parse(readFileSync(join(HERE, "catalog-snapshot.json"), "utf8"));
  const serving = new Set(snap.servingTables.map((t) => t.toLowerCase()));
  let checked = 0;
  for (const p of snap.products) {
    for (const pat of p.patterns.slice(0, 1)) {
      // 패턴이 실제로 읽는 첫 테이블을 뽑아, 거기에 _keys 를 콤마조인한 well-formed 공격을 만든다
      const first = tableRefs(tokenize(pat.sql)).find((r) => serving.has(r.toLowerCase()));
      if (!first) continue;
      checked++;
      assert.equal(scopeGate(`SELECT 1 FROM ${first}, _keys`, serving).ok, false, `주입 미검출: ${pat.pattern_id}`);
    }
  }
  assert.ok(checked > 40, `검사 건수 부족: ${checked}`);
});
