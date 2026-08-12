// 플레이그라운드 채팅 UI 의 계약(#159 ⑤).
//
// 여기서 지키는 것은 화면이 예쁜 것이 아니라 **거짓말하지 않는 것**이다.
//   ① 데이터 없이 지은 답을 데이터 답처럼 그리지 않는다
//   ② 서버 응답(답변·후보 질문)은 전부 esc 를 태운다 — 패턴 질문은 공공 원천 텍스트다
//   ③ 질문 길이 상한이 서버(500자)와 같다 — 화면이 더 느슨하면 눌러 놓고 400 을 받는다
//   ④ 대기 표시는 #229 계약(busy/unbusy·생각 중 제거)을 따른다
//
// jsdom 이 없어 catalog.html 을 텍스트로 본다(catalog-loading.test.mjs 와 같은 방식).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = (await readFile(new URL("../public/catalog.html", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const between = (a, b) => HTML.slice(HTML.indexOf(a), HTML.indexOf(b));
const SEND = between("async function sendChat()", '$("chatLog").addEventListener');

test("채팅은 제품이 먼저다 — 안 골랐으면 칸 자체가 없다", () => {
  assert.match(HTML, /id="chatField" style="display:none"/, "초기엔 감춰져 있어야 한다");
  assert.match(HTML, /\$\("chatField"\)\.style\.display = "none";\s*\/\/ 채팅도 제품이 먼저다/);
  assert.match(SEND, /if \(!q \|\| !PICK\) return;/, "제품 없이 질문이 나가면 안 된다");
});

test("③ 질문 길이 상한이 서버와 같다 — maxlength 500", () => {
  assert.match(HTML, /id="chatQ" maxlength="500"/,
    "서버 상한(500자)보다 화면이 느슨하면 눌러 놓고 400 을 받는다");
});

test("🔴 ① 데이터 없이 지은 답은 그렇다고 말한다", () => {
  assert.match(SEND, /body\.steps && body\.steps\.length/,
    "실행 유무를 안 가르면 지은 문장이 데이터 답처럼 읽힌다");
  assert.match(SEND, /데이터 조회 없이 만든 답변/);
  assert.match(SEND, /검증된 질의 .*실행 결과/);
});

test("🔴 ② 서버 응답은 전부 esc — 답변·안내·후보 질문", () => {
  assert.match(SEND, /esc\(body\.answer\)/);
  assert.match(SEND, /esc\(body\.message/);
  const cands = between("function chatCandidates", "async function sendChat");
  assert.match(cands, /esc\(c\.pattern_id\)/);
  assert.match(cands, /esc\(c\.question_ko/, "패턴 질문은 공공 원천 텍스트다 — & 하나로 깨진다");
});

test("④ 대기 표시 — busy 는 글자와 함께, finally 에서 unbusy", () => {
  assert.match(SEND, /busy\(btn, "질문 중…"\)/);
  assert.match(SEND, /finally \{\s*unbusy\(btn\);/);
});

test("④ '생각 중' 은 성공·실패 양쪽에서 지워진다 — 남으면 멈춘 화면이다", () => {
  const tryBlock = SEND.slice(SEND.indexOf("try {"), SEND.indexOf("} finally"));
  const removes = (tryBlock.match(/thinking\.remove\(\)/g) || []).length;
  assert.ok(removes >= 2, "성공 경로와 catch 양쪽에 remove 가 있어야 한다 — 지금 " + removes);
  assert.match(SEND, /aria-hidden='true'/, "링은 낭독기에 안 읽힌다(#229)");
});

test("키가 있을 때만 Authorization 을 싣는다 — 무인증은 맛보기로 간다", () => {
  assert.match(SEND, /\.\.\.\(key \? \{ authorization: "Bearer " \+ key \} : \{\}\)/);
});

test("질문 후 쿼터를 새로고침한다 — 키 사용자는 질문 1건 = 쿼터 1", () => {
  assert.match(SEND, /finally \{[\s\S]*refreshQuota\(\)/);
});

test("제품이 바뀌면 대화를 비운다 — 이전 제품의 답이 새 제품 답처럼 읽힌다", () => {
  const pick = between("function pickProduct", "// ── 채팅(#159)");
  assert.match(pick, /PICK\.product !== p/, "같은 제품 안의 패턴 변경은 문맥이 같으니 둔다");
  assert.match(pick, /chatLog"\)\.innerHTML = ""/);
});

test("후보 칩 → 위 실행 UI 에 실린다 — 다음 걸음이 화면에 있다", () => {
  const wire = HTML.slice(HTML.indexOf('$("chatLog").addEventListener'));
  assert.match(wire, /data-chatpat/);
  assert.match(wire, /pickProduct\(PICK\.product, u\)/);
});

test("Enter 로도 보낸다 · 로그는 낭독기에 읽힌다", () => {
  assert.match(HTML, /chatQ"\)\.addEventListener\("keydown", \(e\) => \{ if \(e\.key === "Enter"\) sendChat/);
  assert.match(HTML, /id="chatLog" aria-live="polite"/);
});

// ── 채팅 칸의 표시 조건 (2026-08-12) ─────────────────────────────────────────
// 🔴 **답할 수 없으면 입구를 세우지 않는다.** `env.AI` 가 안 붙은 배포에서 이 칸은
//    `degraded: ai_unavailable` 을 받아 **답이 없고**(운영 실측: `answer` 늘 null), 질문이
//    그 제품과 안 맞으면 후보도 0건이라 라벨이 약속한 "추천"조차 안 나온다. 라벨은
//    "AI 가 검증된 질의 패턴을 골라 **실행합니다**"인데 실행이 없다 — 옛 이메일 발급 칸을
//    지운 것과 같은 이유다.
// 🔑 지우지 않고 **가리는** 이유: 바인딩은 켜기로 정해 둔 것이라(decision/0006), 켜는 날
//    이 조건이 참이 되면서 저절로 돌아온다. 되돌릴 코드가 0 이다.
test("🔴 서버가 켜졌다고 할 때만 질문 칸을 연다", () => {
  assert.match(HTML, /CHAT_ON = Boolean\(catalog\.chat && catalog\.chat\.enabled\)/,
    "카탈로그의 chat.enabled 를 안 본다");
  assert.match(HTML, /\$\("chatField"\)\.style\.display = CHAT_ON \? "" : "none";/,
    "제품만 고르면 무조건 여는 옛 배선이 남아 있다");
});

test("카탈로그가 말을 안 해 주면 닫힌 채로 둔다 — 답 못 하는 입구보다 없는 편이 낫다", () => {
  assert.match(HTML, /let CHAT_ON = false;/, "기본값이 false 가 아니면 옛 배포본에서 열린다");
});
