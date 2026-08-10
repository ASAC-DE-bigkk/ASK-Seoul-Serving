// 카탈로그 목록 UX 4건(④ 스키마 접기 · ⑤ 정렬 · ⑥ 선택 고정 바 · ⑦ SQL 복사)의 계약.
//
// 여기서 지키는 것은 편의가 아니라 **기능을 깎지 않았는가**다:
//   ④ 접기는 보이는 것을 줄일 뿐, 검색은 접힘과 무관하게 전 컬럼을 뒤진다
//   ⑤ '기본'은 서버 순서를 덮지 않고, 없는 갱신값은 위로 올라오지 않는다
//   ⑥ 바는 고르기 전엔 없다 — 빈 바는 질문만 만든다
//   ⑦ 복사는 기존 부품(copyText)을 재사용한다 — 피드백 형식이 화면 안에서 갈리면 안 된다
//
// jsdom 없이 텍스트로 본다(catalog-loading.test.mjs 와 같은 방식).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = (await readFile(new URL("../public/catalog.html", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const between = (a, b) => HTML.slice(HTML.indexOf(a), HTML.indexOf(b));

// ── ④ 스키마 접기 + 컬럼 검색 ──────────────────────────────────────────────────

test("④ 문턱(20)과 표시 수(15)가 다르다 — 접는 순간엔 접을 만큼 접혀야 버튼이 값을 한다", () => {
  assert.match(HTML, /const COLS_FOLD_AT = 20, COLS_SHOW = 15;/);
  assert.match(HTML, /cols\.length > COLS_FOLD_AT && ci >= COLS_SHOW \? " fold" : ""/,
    "fold 클래스는 문턱 초과 + 표시 수 이후에만 붙는다");
});

test("④ 검색 칸·펼치기 버튼은 문턱 초과 상세에만 있다", () => {
  assert.match(HTML, /cols\.length > COLS_FOLD_AT\s*\? "<input class='colq'/);
  assert.match(HTML, /class='btn-g btn-sm morecols'[^>]*>나머지 " \+ \(cols\.length - COLS_SHOW\) \+ "개 펼치기/);
});

test("🔴 ④ 검색은 접힘과 무관하게 전 컬럼을 뒤진다 — 인라인 display 가 클래스를 덮는다", () => {
  const wire = between("// ④ 스키마 접기·검색", "// ⑦ SQL 복사 — pre");
  assert.match(wire, /it\.style\.display = it\.textContent\.toLowerCase\(\)\.includes\(t\) \? "grid" : "none"/);
  // 비우면 인라인을 걷어 접힘 상태로 되돌린다 — 검색 한 번에 91컬럼이 눌러앉으면 안 된다
  assert.match(wire, /if \(!t\) \{ items\.forEach\(\(it\) => \{ it\.style\.display = ""; \}\)/);
});

test("④ CSS — open 이 fold 를 이기는 건 특이도다(0,3,0 > 0,2,0). 둘 다 있어야 한다", () => {
  assert.match(HTML, /\.pdetail \.col-item\.fold \{ display:none; \}/);
  assert.match(HTML, /\.pdetail \.cols\.open \.col-item\.fold \{ display:grid; \}/);
});

test("④ 펼치기는 토글이다 — 다시 누르면 접힌다(같은 자리를 눌러 되돌리는 게 기본)", () => {
  const wire = between("// ④ 스키마 접기·검색", "// ⑦ SQL 복사 — pre");
  assert.match(wire, /colsBox\.classList\.toggle\("open"\)/);
  assert.match(wire, /on \? "컬럼 접기" : "나머지 " \+ foldN \+ "개 펼치기"/);
});

// ── ⑤ 목록 정렬 ────────────────────────────────────────────────────────────────

test("⑤ 정렬은 넷 — 기본·예시·갱신·행 수. '기본'은 서버 순서를 덮지 않는다", () => {
  const sel = between('<select id="sortSel"', "</select>");
  for (const v of ["default", "usage", "fresh", "rows"])
    assert.match(sel, new RegExp('value="' + v + '"'), v + " 옵션이 없다");
  assert.match(HTML, /return list;\s*\/\/ 기본 = 카탈로그 응답 순서/);
});

test("⑤ 갱신순 — 없는 값(빈 문자열)은 끝으로 간다. 모르는 것을 위로 올리지 않는다", () => {
  assert.match(HTML, /\(b\.exported_at \|\| ""\)\.localeCompare\(a\.exported_at \|\| ""\)/);
});

test("⑤ 예시 많은 순의 동률은 행 수로 가른다 — 0건끼리 무작위로 섞이지 않게", () => {
  assert.match(HTML, /\(\(b\.usage_patterns \|\| \[\]\)\.length\) - \(\(a\.usage_patterns \|\| \[\]\)\.length\) \|\| \(b\.row_count \|\| 0\) - \(a\.row_count \|\| 0\)/);
});

test("⑤ 정렬을 바꾸면 1쪽으로 돌아간다 — 순서가 바뀐 '3쪽'은 다른 제품들이다", () => {
  assert.match(HTML, /sortBy = \$\("sortSel"\)\.value; page = 1; renderList\(\);/);
  assert.match(HTML, /const list = sortList\(visible\(\)\);/, "renderList 가 정렬을 지나야 한다");
});

// ── ⑥ 선택 고정 바 ─────────────────────────────────────────────────────────────

test("🔴 ⑥ 바는 고르기 전엔 없다 — 빈 바는 질문만 만든다", () => {
  assert.match(HTML, /<button class="pickbar" id="pickBar" type="button" hidden>/);
  assert.match(HTML, /if \(!PICK\) \{ bar\.hidden = true; return; \}/);
});

test("⑥ 방향은 IntersectionObserver 가 정한다 — 위치 계산으로 번역하지 않는다", () => {
  assert.match(HTML, /new IntersectionObserver\(\(ents\) => \{ playInView = ents\[0\]\.isIntersecting; updatePickBar\(\); \}\)/);
  assert.match(HTML, /\.observe\(document\.querySelector\("\.play"\)\)/);
});

test("⑥ 두 방향 문구·두 목적지가 다 있다", () => {
  assert.match(HTML, /↑ 제품 목록으로 돌아가기/);
  assert.match(HTML, /선택됨 — 플레이그라운드로 ↓/);
  assert.match(HTML, /goHash\(playInView \? "#catalog" : "#playground"\)/);
});

test("⑥ 제품을 고르면 바가 갱신된다 — pickProduct 가 유일한 선택 입구다", () => {
  const pick = between("function pickProduct", "// ── ⑥ 선택 고정 바");
  assert.match(pick, /updatePickBar\(\);/);
});

// ── ⑦ SQL 복사 ────────────────────────────────────────────────────────────────

test("⑦ SQL 복사 — copyText 재사용, pre 는 버튼의 다음 형제다", () => {
  assert.match(HTML, /<button class='copybtn sqlcopy' type='button' title='SQL 복사'>복사<\/button>" \+\s*"<pre>" \+ esc\(u\.sql \|\| ""\)/);
  assert.match(HTML, /copyText\(b\.nextElementSibling\.textContent, b, "복사됨"\)/);
});
