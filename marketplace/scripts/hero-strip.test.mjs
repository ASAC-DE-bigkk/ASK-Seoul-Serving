// 히어로 아래 계기 스트립의 계약.
//
// 이 스트립은 **첫 방문의 네 질문**에 답한다: 얼마나 있나 · 뭘 물어볼 수 있나 · 돈 드나 ·
// 살아 있나. 예전엔 가운데 둘이 공간축·시간축이었는데, 그건 스키마 사실이지 사용자의
// 질문이 아니었다(24/57 · 30/57 이라 분모를 아는 사람에겐 "절반도 안 되네"로 읽혔다).
//
// 지키는 것:
//   ① 숫자를 HTML 에 박지 않는다 — 제품·질문 수는 늘고 준다(패턴 640→871 예정)
//   ② '무료'는 카탈로그를 안 기다린다 — 사실이지 집계값이 아니다
//   ③ 카탈로그 실패 강등이 살아 있는 id 만 만진다 — 없는 id 를 setStat 하면 화면이 죽는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = (await readFile(new URL("../public/index.html", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const STRIP = HTML.slice(HTML.indexOf('<div class="strip">'), HTML.indexOf('<main class="wrap">'));

test("네 칸이 첫 방문의 네 질문에 답한다", () => {
  for (const lab of ["데이터 제품", "검증된 질문", "미리보기", "갱신"])
    assert.match(STRIP, new RegExp('class="lab ko">' + lab + "<"), lab + " 칸이 없다");
  assert.equal((STRIP.match(/class="cell"/g) || []).length, 4);
});

test("🔴 ① 숫자를 HTML 에 박지 않는다 — 자리표시자만 두고 카탈로그에서 센다", () => {
  // 자리표시자(0종·0개)는 스켈레톤이 덮으므로 화면에 안 보인다. 진짜 값이 박혀 있으면 잡는다.
  const placeholders = STRIP.match(/class="v sk[^"]*"[^>]*>([^<]*)</g) || [];
  for (const p of placeholders)
    assert.match(p, /0종|0개|0시간 전/, "자리표시자가 아니라 실제 값이 박혀 있다: " + p);
  assert.doesNotMatch(STRIP, />\s*(57|640|871)\s*</, "제품·질문 수가 HTML 에 박혀 있다");
});

test("🔴 ① 제품·질문·분야 수는 전부 세어서 넣는다", () => {
  assert.match(HTML, /setStat\("statProducts", products\.length/);
  assert.match(HTML, /products\.reduce\(\(n, p\) => n \+ \(\(p\.usage_patterns \|\| \[\]\)\.length\), 0\)/,
    "질문 수를 카탈로그에서 세지 않는다");
  assert.match(HTML, /new Set\(products\.map\(domainOf\)\)\.size/,
    "분야 수도 세어야 한다 — 도메인이 늘거나 줄면 따라가야 한다");
});

test("② '무료' 칸은 스켈레톤이 없다 — 사실이지 집계값이 아니다", () => {
  const cell = STRIP.slice(STRIP.indexOf('class="lab ko">미리보기<'));
  const v = cell.slice(cell.indexOf('class="v'), cell.indexOf("</div>", cell.indexOf('class="v')));
  assert.doesNotMatch(v, /\bsk\b/, "카탈로그를 기다릴 이유가 없는 값이다");
  assert.match(v, /무료/);
});

test("🔴 ③ 카탈로그 실패 강등이 살아 있는 id 만 만진다", () => {
  const fail = HTML.slice(HTML.indexOf("if (!products) {"), HTML.indexOf("failState(\"domains\""));
  const ids = [...fail.matchAll(/setStat\("(\w+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, "강등 경로가 통계를 안 비운다");
  for (const id of ids)
    assert.match(HTML, new RegExp('id="' + id + '"'), `강등이 없는 id 를 만진다: ${id}`);
});

test("걷어낸 공간축·시간축 잔재가 없다 — 죽은 id 는 강등 경로를 터뜨린다", () => {
  assert.doesNotMatch(HTML, /statDong|statTimed/);
});
