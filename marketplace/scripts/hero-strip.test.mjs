// 히어로 아래 계기 스트립의 계약.
//
// 이 스트립은 **첫 방문의 네 질문**에 답한다: 얼마나 있나 · 무슨 데이터가 있나 ·
// 뭘 물어볼 수 있나 · 살아 있나.
//
// 🔴 두 번째 칸(분야)은 **다섯 번째 시도**다. 앞의 넷은 전부 실패했다 —
//   ① 공간축·시간축: 스키마 사실이지 사용자의 질문이 아니다(24/57 이라 약점으로 읽혔다)
//   ② 미리보기 "무료": 전부 무료인 서비스라 정보가 없다
//   ③ 공공 원천: 세는 기준이 판단이고 attribution 이 손 사본이라 정본(D1)과 어긋난다
//   ④ 컬럼 설명·활용사례: 우리 자랑이지 방문자의 질문이 아니다
// 넷이 실패한 뒤 한 번은 칸을 비우기까지 했는데, 답은 **분야**였다(오너 제안) —
// 방문자의 첫 질문이 "무슨 데이터가 있나"인데 그 답이 한참 아래 도메인 격자에만 있었다.
// 🔑 실패한 넷의 공통점: **우리가 아는 사실**(스키마·품질·출처)이었지 방문자의 질문이 아니었다.
//
// 지키는 것:
//   ① 숫자를 HTML 에 박지 않는다 — 제품·질문 수는 늘고 준다(패턴 795 → 871 예정)
//   ② 네 칸이 전부 실측이다 — 하드코딩한 사실을 끼워 넣지 않는다
//   ③ 카탈로그 실패 강등이 살아 있는 id 만 만진다 — 없는 id 를 setStat 하면 화면이 죽는다
//   ④ 라벨이 사실을 말한다 — 초안이 섞이면 "검증됨"이라 부르지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = (await readFile(new URL("../public/index.html", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const STRIP = HTML.slice(HTML.indexOf('<div class="strip">'), HTML.indexOf('<main class="wrap">'));

test("네 칸이 첫 방문의 네 질문에 답한다", () => {
  for (const lab of ["데이터 제품", "분야", "질의 패턴", "갱신"])
    assert.match(STRIP, new RegExp('class="lab ko">' + lab + "<"), lab + " 칸이 없다");
  assert.equal((STRIP.match(/class="cell"/g) || []).length, 4,
    "칸을 늘릴 때는 그것이 **방문자의 질문**인지 먼저 본다 — 네 번 실패한 자리다");
});

test("🔴 분야 — 수는 카탈로그에서 세고 이름만 DOMAINS 에서 가져온다", () => {
  assert.match(HTML, /const domIds = new Set\(products\.map\(domainOf\)\)/,
    "도메인이 늘거나 줄면 수가 따라가야 한다");
  assert.match(HTML, /\(DOMAINS\.find\(\(d\) => d\.id === id\) \|\| \{\}\)\.short/);
  assert.match(HTML, /\.filter\(Boolean\)/,
    "목록에 없는 접두사는 이름에서 빠져야 한다 — 모르는 분야를 지어내지 않는다");
  for (const short of ["문화", "인구", "교통", "상권", "날씨", "도로"])
    assert.match(HTML, new RegExp('short:"' + short + '"'), short + " 짧은 이름이 없다");
});

test("🔴 ① 숫자를 HTML 에 박지 않는다 — 자리표시자만 두고 카탈로그에서 센다", () => {
  // 자리표시자(0종·0개)는 스켈레톤이 덮으므로 화면에 안 보인다. 진짜 값이 박혀 있으면 잡는다.
  const placeholders = STRIP.match(/class="v sk[^"]*"[^>]*>([^<]*)</g) || [];
  for (const p of placeholders)
    assert.match(p, /0종|0개|0시간 전/, "자리표시자가 아니라 실제 값이 박혀 있다: " + p);
  assert.doesNotMatch(STRIP, />\s*(57|640|871)\s*</, "제품·질문 수가 HTML 에 박혀 있다");
});

test("🔴 ① 제품·질문 수는 세어서 넣는다 (분야는 위 전용 검사)", () => {
  assert.match(HTML, /setStat\("statProducts", products\.length/);
  assert.match(HTML, /setStat\("statPatterns", nf\.format\(patterns\)/,
    "질문 수를 카탈로그에서 세지 않는다");
});

test("② 네 칸이 전부 실측이다 — 하드코딩한 사실을 끼워 넣지 않는다", () => {
  assert.equal((STRIP.match(/class="v sk/g) || []).length, 4,
    "실측이 아닌 값이 섞이면 '무료' 같은 빈 칸이 다시 생긴다");
});

// 🔴 말과 수를 같은 쪽에 맞춘다 — 설명이 "바로 물어볼 수 있는"이면 **실행되는 것만 세야** 한다.
//    한때 전체(초안 포함)를 세면서 "검증된 질문"이라 적었다가 초안이 섞인 날 거짓이 됐고
//    (795 중 73 미검증 — ASAC-DBT#489), 그 뒤 "행 수까지 확인함"으로 맞췄더니 이번엔 증명이
//    방문자의 언어가 아니었다(오너 결정 2026-08-11 — 방문자의 질문은 "뭘 물어볼 수 있나"다).
//    라벨은 설명("활용 질문")으로 바뀌었지만 세는 쪽은 그대로다: 미검증 초안은 실행하면
//    409 라, verified_at 필터를 빼는 순간 "물어볼 수 있는"이 거짓이 된다.
test("🔴 '바로 물어볼 수 있는'이라 말하면 실행되는 것(검증본)만 센다", () => {
  assert.match(HTML, /const patterns = products\.reduce\(\s*\(n, p\) => n \+ \(p\.usage_patterns \|\| \[\]\)\.filter\(\(u\) => u\.verified_at\)\.length, 0\)/,
    "verified_at 필터 없이 세면 초안이 '검증된'에 섞인다");
  assert.doesNotMatch(HTML, /n \+ \(\(p\.usage_patterns \|\| \[\]\)\.length\)/,
    "전체를 세는 옛 계산이 남아 있다");
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
