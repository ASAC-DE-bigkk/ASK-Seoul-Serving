// 도메인 6색의 계약 — **두 파일의 사본이 같은가**를 지킨다.
//
// index.html 과 catalog.html 은 site.css 를 안 읽는다(각자 자기 CSS). 그래서 도메인 색
// 토큰이 두 벌인데, 이 구조는 팔레트 사고의 재발 조건이다 — 페이지 복제로 5페이지가
// 구 테라코타에 남았던 사고(CLAUDE.md §5)와 같은 종류. 사본을 없앨 수 없다면
// 어긋나는 순간 시끄럽게 만든다.
//
// 지키는 것:
//   ① 6도메인 토큰이 두 파일의 라이트·다크 블록에 전부 있다
//   ② 같은 테마의 같은 토큰은 두 파일에서 **같은 값**이다
//   ③ 토큰 이름은 두 파일 DOMAINS 의 id 와 1:1 이다 — 도메인이 늘면 여기서 걸린다
//   ④ 색을 쓰는 자리(격자·사이드바·제품 행)에 data-dom 훅이 실제로 있다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (f) =>
  (await readFile(new URL("../public/" + f, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const INDEX = await read("index.html");
const CATALOG = await read("catalog.html");

const DOMS = ["culture", "citydata", "transit", "commerce", "weather", "traffic"];

// 라이트 = 문서 첫 :root 블록, 다크 = :root[data-theme="dark"] 블록.
// 정규식이 아니라 중괄호 짝으로 자른다 — 블록 안 주석의 중괄호는 없다는 전제(현행 사실).
function block(html, sel) {
  const i = html.indexOf(sel);
  assert.ok(i >= 0, sel + " 블록이 없다");
  return html.slice(i, html.indexOf("}", i));
}
const tokens = (css) =>
  Object.fromEntries([...css.matchAll(/--dom-([a-z]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

for (const [name, html] of [["index.html", INDEX], ["catalog.html", CATALOG]]) {
  test(`① ${name} — 라이트·다크 양쪽에 6토큰이 다 있다`, () => {
    for (const b of [":root {", ':root[data-theme="dark"]']) {
      const t = tokens(block(html, b));
      assert.deepEqual(Object.keys(t).sort(), [...DOMS].sort(),
        `${name} ${b} 의 토큰이 6도메인과 다르다 — 도메인을 늘렸으면 두 파일 두 블록 전부에 넣는다`);
    }
  });
}

test("② 같은 테마의 같은 토큰은 두 파일에서 같은 값이다", () => {
  for (const b of [":root {", ':root[data-theme="dark"]']) {
    const a = tokens(block(INDEX, b));
    const c = tokens(block(CATALOG, b));
    for (const d of DOMS)
      assert.equal(a[d], c[d],
        `--dom-${d} (${b}) 가 두 파일에서 다르다 — 한쪽만 고치면 랜딩과 카탈로그가 다른 서비스로 보인다`);
  }
});

test("③ 토큰 이름은 두 파일 DOMAINS 의 id 와 1:1 이다", () => {
  for (const [name, html] of [["index.html", INDEX], ["catalog.html", CATALOG]]) {
    const arr = html.slice(html.indexOf("const DOMAINS = ["));
    const ids = [...arr.slice(0, arr.indexOf("];")).matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.sort(), [...DOMS].sort(), name + " 의 DOMAINS id 가 토큰과 어긋난다");
  }
});

test("④ 색을 쓰는 세 자리에 data-dom 훅이 있다 — 토큰만 있고 안 쓰이면 죽은 색이다", () => {
  assert.match(INDEX, /data-dom='" \+ esc\(d\.id\)/, "랜딩 도메인 격자");
  assert.match(CATALOG, /li\.dataset\.dom = d\.id/, "카탈로그 사이드바");
  assert.match(CATALOG, /class='ddot' data-dom='" \+\s*esc\(domainOf\(p\)\)/, "카탈로그 제품 행");
});

test("soon(제품 0) 회색이 고유색을 이기는 순서가 유지된다 — 특이도가 같아 순서가 곧 우선", () => {
  // 랜딩: .dom.soon .t i 규칙이 마지막 고유색 규칙보다 뒤에 있어야 한다
  assert.ok(INDEX.indexOf(".dom.soon .t i") > INDEX.indexOf('.dom[data-dom="traffic"]'),
    "index.html: soon 규칙이 고유색보다 앞으로 올라갔다 — 빈 도메인에 색이 켜진다");
  assert.ok(CATALOG.indexOf(".dnav li.soon .dot") > CATALOG.indexOf('.dnav li[data-dom="traffic"]'),
    "catalog.html: soon 규칙이 고유색보다 앞으로 올라갔다");
});

test("카드 신선도 — exported_at 없으면 통째로 생략한다(모른다 ≠ 오래됨)", () => {
  assert.match(INDEX, /p\.exported_at \? relTime\(p\.exported_at\) : null/);
  const i = INDEX.indexOf("const freshHtml");
  assert.match(INDEX.slice(i, i + 400), /48 \* 3600000/,
    "켜짐 경계는 48시간 — relTime 이 시간 단위로 말하는 구간과 같은 경계여야 점과 글자가 같은 말을 한다");
});
