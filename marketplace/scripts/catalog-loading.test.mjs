// 플레이그라운드 **대기 표시**의 계약을 고정한다(#218 후속).
//
// 원래 결함은 "느리다"가 아니라 **느린 동안 화면이 아무 말도 안 한다**였다. 호출을 눌러도
// 버튼은 흐려지기만 하고 응답 칸에는 직전 결과가 그대로 남아, 이미 끝난 화면처럼 읽혔다.
//
// 여기서 지키는 것은 링(spinner)의 모양이 아니라 **거짓말하지 않는 것** 셋이다.
//   ① 켰으면 끈다      — 끊긴 요청·실패한 부팅에 "불러오는 중…"이 남으면 안 된다
//   ② 남의 결과를 안 남긴다 — 새 호출이 나갔는데 옛 상태 배지가 붙어 있으면 안 된다
//   ③ 움직임을 끈 사람에게도 말한다 — 링은 감춰지므로 글자가 유일한 신호다
//
// jsdom 이 없어 `catalog.html` 을 텍스트로 읽는다(`catalog-key-memory.test.mjs` 와 같은 방식).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = await readFile(new URL("../public/catalog.html", import.meta.url), "utf8");
const between = (a, b) => HTML.slice(HTML.indexOf(a), HTML.indexOf(b));

test("🔴 움직임을 끄면 링을 감춘다 — 한 바퀴 돌다 멈춘 링은 '멈춘 화면'이다", () => {
  assert.match(HTML, /@media \(prefers-reduced-motion: reduce\) \{ \.spin \{ display:none/,
    "reduced-motion 처리가 없다 — 억제 규칙이 걸리면 링이 돌다 만다");
});

test("🔴 busy() 는 글자를 반드시 바꾼다 — 링이 안 보이는 사람에게 남는 유일한 신호다", () => {
  const fn = between("function busy(btn, label)", "function unbusy");
  assert.match(fn, /esc\(label\)/, "label 을 안 쓰면 링만 얹힌다");
  // 호출부가 label 을 빼먹으면 그 버튼은 reduced-motion 에서 아무 반응이 없다.
  // 인자 하나짜리 호출만 본다 — 산문 속 `busy()` 까지 세면 주석을 고칠 때마다 깨진다.
  const bare = HTML.match(/\bbusy\(\s*[A-Za-z_$][\w$]*\s*\)/g) || [];
  assert.equal(bare.length, 0, "글자 없이 busy() 를 부른 곳: " + bare.join(" · "));
});

test("① 켠 것은 끈다 — busy 를 건 함수마다 finally 에 unbusy 가 있다", () => {
  for (const [name, from, to] of [
    ["run", "async function run(useCursor)", "// 이메일 발급 배선"],
    ["callRevoke", "async function callRevoke(purge)", '$("revokeBtn").addEventListener'],
  ]) {
    const fn = between(from, to);
    assert.match(fn, /busy\(btn,/, name + " 에 대기 표시가 없다");
    assert.match(fn, /finally \{[^}]*unbusy\(btn\)/, name + " 이 대기 표시를 안 되돌린다");
  }
});

test("① 끊긴 요청에 대기 문구가 남지 않는다 — 응답이 없으면 상자가 열린 채다", () => {
  const fn = between("async function run(useCursor)", "// 이메일 발급 배선");
  assert.match(fn, /finally \{[^}]*respEmpty"\)\.textContent = RESP_IDLE/,
    "fetch 가 던지면 '불러오는 중…'이 영원히 남는다");
});

test("① 목록을 못 불러와도 대기 문구로 안 끝난다", () => {
  assert.match(HTML, /boot\(\)\.catch\(/, "boot 실패가 처리되지 않는다");
  assert.match(HTML, /제품 목록을 불러오지 못했습니다/, "실패했다는 말이 화면에 없다");
});

test("① 되돌릴 글자는 DOM 이 아니라 WeakMap 에 — dataset 은 이미 다른 상태가 쓴다", () => {
  const fn = between("const BUSY = new WeakMap()", "// 컬럼 설명은");
  assert.doesNotMatch(fn, /dataset\./,
    "원래 글자를 dataset 에 넣으면 revokeBtn 의 dataset.confirm 과 섞인다");
});

test("② 새 호출은 직전 결과의 상태 배지를 지운다 — 안 온 응답을 받은 것처럼 읽는다", () => {
  const fn = between("function respLoading(keepTable)", "// 페이지 상태 —");
  assert.ok(fn.indexOf('respStatus"').valueOf() < fn.indexOf("if (keepTable) return"),
    "상태 배지 지우기가 keepTable 뒤로 가면 다음 페이지에서 옛 배지가 남는다");
  assert.match(fn, /respMeta"\)\.textContent = ""/);
});

test("② 다음 페이지는 표를 남긴다 — 지우면 방금 누른 자리가 접혀 사라진다", () => {
  const run = between("async function run(useCursor)", "// 이메일 발급 배선");
  assert.match(run, /respLoading\(useCursor\)/,
    "useCursor 를 안 넘기면 다음 페이지에서도 표가 지워진다");
  const fn = between("function respLoading(keepTable)", "// 페이지 상태 —");
  assert.match(fn, /if \(keepTable\) return;/);
  // 페이저는 건드리지 않는다 — 실패하면 '다음 페이지' 버튼이 사라져 재시도할 길이 없어진다
  assert.doesNotMatch(fn, /\$\("pager"\)/,
    "대기 중 페이저를 감추면 실패했을 때 재시도 버튼이 사라진다");
});

test("안내 문구는 마크업과 같은 말이다 — 되돌릴 때 다른 문장이 되면 안 된다", () => {
  const idle = HTML.match(/const RESP_IDLE = "([^"]+)"/);
  assert.ok(idle, "RESP_IDLE 이 없다");
  assert.match(HTML, new RegExp('id="respEmpty"[^>]*>' + idle[1] + "</div>"),
    "마크업의 첫 문구와 되돌릴 문구가 다르다 — 한 번 호출하면 말이 바뀐다");
});

test("링은 낭독기에서 감춘다 — 대신 문구가 읽히게 표시한다", () => {
  const spins = HTML.match(/class=['"]spin['"][^>]*/g) || [];
  assert.ok(spins.length >= 3, "대기 표시가 붙은 곳이 너무 적다");
  for (const s of spins)
    assert.match(s, /aria-hidden/, "낭독기에 빈 요소가 읽힌다: " + s);
  assert.match(HTML, /id="respEmpty" aria-live="polite"/);
  assert.match(HTML, /id="respMeta" aria-live="polite"/);
});
