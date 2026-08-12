// 플레이그라운드 파라미터 기본값(#218)의 파싱을 고정한다.
//
// 이 로직이 틀리면 **조용히 실패한다** — 칸이 안 채워지면 사용자가 값을 지어내야 하고,
// 잘못 채워지면 `:metric` 처럼 `CASE … WHEN 'rename' … ELSE …` 로 갈리는 자리에서
// **200 을 받으면서 다른 답**을 얻는다(#179 와 같은 실패 방식).
//
// jsdom 이 없으므로 `catalog.html` 에서 함수를 **뽑아** 시험한다. 사본을 만들지 않는 것이
// 요점이다 — 사본은 반드시 원본과 갈린다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = await readFile(new URL("../public/catalog.html", import.meta.url), "utf8");

function extract(name) {
  const m = HTML.match(new RegExp(`\\nfunction ${name}\\(sql\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} 를 catalog.html 에서 못 찾았다 — 이름이 바뀌었나`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}
// `patternDefaults` 는 값 갈래 헬퍼들과 한 묶음이다(검증기 규칙을 옮겨 온 자리) — 블록째 뽑는다.
const DEFAULTS_BLOCK = HTML.slice(HTML.indexOf("function exampleValue"), HTML.indexOf("function pickProduct"));
assert.ok(DEFAULTS_BLOCK.includes("function patternDefaults"), "patternDefaults 블록을 못 찾았다 — 이름이 바뀌었나");
const patternDefaults = new Function(`${DEFAULTS_BLOCK}\nreturn patternDefaults;`)();
const patternParams = extract("patternParams");

// 실제 운영 패턴(commerce_change_activity / above_avg_multiple)의 첫 줄이다.
const REAL = "-- :metric='rename', :factor=2, :min_biz=100, :n=10\nWITH bench AS (\n" +
  "  SELECT CASE :metric WHEN 'rename' THEN a ELSE b END AS seoul_avg FROM t)\n" +
  "SELECT x FROM t, bench b WHERE businesses >= :min_biz\n" +
  "  AND ratio >= b.seoul_avg * :factor LIMIT :n";

test("주석의 예시값을 읽는다 — 이 화면이 지금까지 버리던 것", () => {
  assert.deepEqual(patternDefaults(REAL),
    { metric: "rename", factor: "2", min_biz: "100", n: "10" });
});

test("🔴 따옴표를 벗긴다 — 서버는 값을 바인딩한다", () => {
  // `'rename'` 을 그대로 보내면 따옴표까지 값이 되어 CASE 의 ELSE 로 떨어진다.
  assert.equal(patternDefaults("-- :metric='rename'").metric, "rename");
  assert.equal(patternDefaults('-- :who="kim"').who, "kim");
  assert.equal(patternDefaults("-- :n=10").n, "10");
});

test("파라미터 목록과 기본값이 같은 이름을 가리킨다", () => {
  // 이름이 어긋나면 칸은 뜨는데 안 채워진다 — 사용자에겐 '그냥 빈 칸'으로 보인다.
  const names = patternParams(REAL);
  assert.deepEqual(names.sort(), ["factor", "metric", "min_biz", "n"]);
  for (const nm of names) assert.ok(nm in patternDefaults(REAL), `${nm} 기본값 없음`);
});

test("주석에만 있고 본문엔 없는 이름은 칸이 안 생긴다 — 유령 입력칸 방지", () => {
  // 칸 목록은 **본문**이 정한다. 주석에 낡은 이름이 남아 있어도 화면에 뜨지 않아야 한다.
  const sql = "-- :gone=1, :n=10\nSELECT x FROM t LIMIT :n";
  assert.deepEqual(patternParams(sql), ["n"]);
  assert.equal(patternDefaults(sql).gone, "1");   // 읽히긴 하지만 쓰이지 않는다
});

test("주석에 값이 없으면 조용히 비운다 — 없는 값을 지어내지 않는다", () => {
  assert.deepEqual(patternDefaults("-- :from, :to\nSELECT :from"), {});
  assert.deepEqual(patternDefaults("SELECT :gu"), {});
  assert.deepEqual(patternDefaults(null), {});
});

test("본문의 `=` 는 기본값이 아니다 — 주석만 읽는다", () => {
  // WHERE 절의 `gu = :gu` 를 기본값으로 읽으면 엉뚱한 값이 칸에 박힌다.
  assert.deepEqual(patternDefaults("SELECT * FROM t WHERE gu = :gu AND n = :n"), {});
});

test("렌더가 기본값을 실제로 쓴다 — 함수만 있고 안 쓰면 소용없다", () => {
  const render = HTML.slice(HTML.indexOf("function renderPick"));
  assert.match(render, /patternDefaults\(u\.sql,/, "renderPick 이 기본값을 안 읽는다");
  assert.match(render, /if \(has\) input\.value = defs\[nm\];/, "읽어 놓고 input value 에 안 넣는다");
  // 🔴 힌트도 넘겨야 한다 — 검증기(`_hint_of`)와 같은 세 필드다. 빼면 예시값을 인사이트
  //    문장에 적어 둔 패턴(commerce 9건)만 빈 칸으로 남는다.
  assert.match(render, /u\.question_ko, u\.axes, u\.insight_sample_ko/, "힌트를 안 넘긴다");
});

test("🔴 값은 속성 문자열이 아니라 프로퍼티로 넣는다 — `'` 하나에 속성이 끊긴다", () => {
  // `esc` 는 홑따옴표를 안 바꾸는데 value 는 홑따옴표 속성이다. 값에 `'` 가 들어오면
  // 거기서 속성이 끝나고 뒷부분이 마크업으로 읽힌다.
  const render = HTML.slice(HTML.indexOf("function renderPick"));
  assert.doesNotMatch(render, /value='"\s*\+\s*esc\(defs\[nm\]\)/, "값을 속성 문자열로 넣고 있다");
});

// ── 필터 값 후보 (#218 나머지) ────────────────────────────────────────────────
// 컬럼은 골라 주면서 값은 지어내게 두던 것을 고친 자리다. 재료는 무인증 `preview` 5행이고,
// 조용히 틀리는 방식은 둘이다: ① 제품마다 계속 부르거나 ② 컬럼을 바꿔도 옛 후보가 남는 것.
// 후자는 **다른 컬럼의 값을 권하게** 되어 400 을 부른다.
test("값 후보는 무인증 preview 에서 온다 — 새 API·키가 필요 없다", () => {
  const fn = HTML.slice(HTML.indexOf("async function loadFilterValues"), HTML.indexOf("function fillValueHints"));
  assert.match(fn, /\/api\/v1\/preview\//, "preview 를 안 쓴다");
  assert.doesNotMatch(fn, /authorization|Bearer/i, "값 후보에 키를 쓰면 무인증 방문자가 못 본다");
});

test("제품당 한 번만 부른다 — 익명 경로라 IP 버스트를 쓴다", () => {
  const fn = HTML.slice(HTML.indexOf("async function loadFilterValues"), HTML.indexOf("function fillValueHints"));
  assert.match(fn, /if \(!table \|\| FILTER_VALUES\.has\(table\)\) return;/, "캐시 확인이 없다");
  // 🔴 실패해도 다시 안 부르게 **먼저** 박아 둔다 — 안 그러면 404·429 때 매번 재요청한다
  assert.ok(fn.indexOf("FILTER_VALUES.set(table, {})") < fn.indexOf("await fetch"),
    "실패 시 무한 재요청이 된다");
});

test("컬럼이 바뀌면 후보도 간다 — 안 갈면 다른 컬럼 값을 권한다", () => {
  const add = HTML.slice(HTML.indexOf("function addFilterRow"), HTML.indexOf("$(\"addFilter\")"));
  assert.match(add, /\[data-fcol\]"\)\.addEventListener\("change", \(\) => fillValueHints/);
  assert.match(add, /list='" \+ listId/, "input 이 datalist 에 안 묶였다");
});

test("후보를 못 얻어도 입력은 된다 — 편의가 없어질 뿐", () => {
  const fn = HTML.slice(HTML.indexOf("async function loadFilterValues"), HTML.indexOf("function fillValueHints"));
  assert.match(fn, /try \{[\s\S]*catch/, "preview 실패가 화면을 죽인다");
});
