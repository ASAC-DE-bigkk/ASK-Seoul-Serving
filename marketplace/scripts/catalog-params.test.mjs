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
const patternDefaults = extract("patternDefaults");
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
  assert.match(render, /patternDefaults\(u\.sql\)/, "renderPick 이 기본값을 안 읽는다");
  assert.match(render, /value='"\s*\+\s*esc\(defs\[nm\]\)/, "읽어 놓고 input value 에 안 넣는다");
});
