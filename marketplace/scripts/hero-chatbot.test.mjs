// 랜딩 히어로 챗봇(1단계)의 화면 계약.
//
// 지키는 것은 예쁨이 아니라 **거짓말하지 않는 것**이다:
//   ① LLM 을 부르지 않는다 — 랜딩은 방문자 전원이 지나므로 여기서 과금이 생기면 안 된다
//   ② "찾았다"와 "돌려봤다"를 섞지 않는다 — 안 밝히면 카드가 조회 결과로 읽힌다
//   ③ 0건을 "없다"로 단정하지 않는다 — 낱말이 안 겹쳤을 뿐일 수 있다
//   ④ 서버 응답은 전부 esc — 제목·질문은 공공 원천 텍스트다
//   ⑤ 질문을 두 번 치게 하지 않는다 — 카탈로그로 제품·패턴을 실어 넘긴다
//   ⑥ 화면 상한이 서버(200자)와 같다 — 느슨하면 눌러 놓고 400 을 받는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pub = async (f) =>
  (await readFile(new URL("../public/" + f, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const INDEX = await pub("index.html");
const CATALOG = await pub("catalog.html");
const ASK = INDEX.slice(INDEX.indexOf("async function askHero"), INDEX.indexOf('$("heroSearch").addEventListener'));

test("🔴 ① LLM 을 부르지 않는다 — 랜딩이 부르는 건 무인증 검색 하나뿐이다", () => {
  assert.match(ASK, /fetch\("\/api\/v1\/search\?q=" \+ encodeURIComponent\(query\)\)/);
  const hero = INDEX.slice(INDEX.indexOf("// ── 히어로 챗봇"), INDEX.indexOf("function setStat"));
  assert.doesNotMatch(hero, /\/api\/v1\/chat/,
    "랜딩에서 채팅 엔드포인트를 부르면 구경꾼이 무인증 몫(100/일)을 태운다");
});

test("🔴 ② '찾았다'와 '돌려봤다'를 섞지 않는다", () => {
  assert.match(INDEX, /데이터를 조회하지 않고/);
  assert.match(INDEX, /실제 숫자는 「돌려보기」에서 나옵니다/);
});

test("🔴 ③ 0건을 '없다'로 단정하지 않는다 — 다음 걸음을 준다", () => {
  assert.match(INDEX, /맞는 데이터를 못 찾았습니다 — 낱말을 바꿔 보시거나/);
  assert.match(INDEX, /카탈로그 전체<\/a>에서 직접 보실 수 있습니다/);
});

test("🔴 ④ 서버 응답은 전부 esc — 제목·검증 질문은 공공 원천 텍스트다", () => {
  assert.match(INDEX, /esc\(p\.title\)/);
  assert.match(INDEX, /esc\(x\.question_ko\)/);
  assert.match(INDEX, /terms\.map\(esc\)/);
  assert.match(INDEX, /esc\(b\.detail/, "오류 detail 도 서버 문자열이다");
});

test("🔴 ⑤ 질문을 두 번 치지 않는다 — 제품·패턴을 실어 넘기고 카탈로그가 받는다", () => {
  assert.match(INDEX, /\/catalog\?product=" \+ encodeURIComponent\(p\.product_id\)/);
  assert.match(INDEX, /"&pat=" \+ encodeURIComponent\(x\.pattern_id\)/);
  assert.match(CATALOG, /const pid = params\.get\("product"\)/);
  assert.match(CATALOG, /pickProduct\(carried, pat \|\| null\)/);
});

test("🔴 ⑤ 승계는 자동 실행하지 않는다 — 랜딩 트래픽이 쿼터를 저절로 태우면 안 된다", () => {
  const boot = CATALOG.slice(CATALOG.indexOf("const pid = params"), CATALOG.indexOf("renderNav(); renderStart()"));
  assert.doesNotMatch(boot, /runPattern|\brun\(\)|fetchData/,
    "승계 경로에서 실행이 일어난다 — 버튼은 사람이 눌러야 한다");
  assert.match(CATALOG, /else if \(carried\) goHash\("#playground", "auto"\)/,
    "승계로 왔으면 플레이그라운드로 데려간다");
});

test("⑥ 화면 상한이 서버와 같다 — 200자", () => {
  assert.match(INDEX, /id="heroQ" maxlength="200"/);
});

test("칩은 링크가 아니라 버튼이다 — 이 자리에서 묻는다(문서 이동이 아니다)", () => {
  const hot = INDEX.slice(INDEX.indexOf('<div class="hot" id="heroChips">'), INDEX.indexOf('id="heroAnswer"'));
  assert.doesNotMatch(hot, /<a /, "칩이 아직 링크다");
  assert.match(INDEX, /\$\("heroQ"\)\.value = b\.textContent/,
    "칩을 누르면 입력칸에도 남아야 고쳐 물을 수 있다");
});

test("답 자리는 질문 전에 자리도 안 차지한다 — 빈 상자가 먼저 뜨면 질문만 만든다", () => {
  assert.match(INDEX, /\.answer \{ display:none;/);
  assert.match(INDEX, /\.answer\.on \{ display:block; \}/);
});

test("도메인 점이 답에서도 같은 6색을 쓴다 — 색 체계가 여기서 한 번 더 일한다", () => {
  for (const d of ["culture", "citydata", "transit", "commerce", "weather", "traffic"])
    assert.match(INDEX, new RegExp("\\.answer \\.hit\\[data-dom=\"" + d + "\"\\]\\s+i\\.d"));
});
