// 히어로 배경 격자(`bootField`)가 **차오르는지**를 고정한다.
//
// 🔴 이건 조용히 망가진다. 2026-08-03 에 한 번 정지시켰을 때(75d537f) 깨진 테스트가 0건이었다 —
//    배경 장식이라 화면이 멀쩡해 보이고 "원래 이런가"로 읽힌다. 파형에서 시간 항 하나가 빠지거나
//    `SEAT` 계획이 매 프레임 다시 짜이는 것만으로 뜻이 바뀌는데, 눈으로는 잘 안 보인다.
//
// 지키는 것은 넷이다:
//   ① 시간이 가면 그림이 바뀐다(정지 회귀 방지)
//   ② **단조롭게 차오른다** — 총량이 늘기만 하고 줄지 않는다. 되감으면 "쌓인 것이 사라진다"가
//      되어 눈썹줄(`Series`)이 하는 말과 배경이 어긋난다
//   ③ 다 차면 **머문다** — 리셋해서 처음부터 다시 채우지 않는다
//   ④ 애니메이션을 끈 사람에게는 **다 찬 한 장** — 텅 빈 배경이 남으면 안 된다
//
// jsdom 도 canvas 도 없으므로 `index.html` 에서 함수를 **뽑아** 가짜 캔버스로 돌린다.
// 사본을 만들지 않는 것이 요점이다 — 사본은 반드시 원본과 갈린다.
// (브라우저에서는 검증이 안 된다: 미리보기 패널이 숨겨져 있으면 `document.hidden` 이라 rAF 가
//  한 번도 안 돌고 — 실측 800ms 에 콜백 0 — 페이지 CSP 가 `unsafe-eval` 을 막아 in-page
//  하네스도 못 만든다. 그래서 Node 로 왔다.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const SRC = HTML.slice(HTML.indexOf("function bootField"), HTML.indexOf("async function bootDemo"));
assert.ok(SRC.includes("function bootField"), "bootField 를 index.html 에서 못 찾았다 — 이름이 바뀌었나");

// 칠해진 rgba 를 받아 적는 가짜 2D 컨텍스트. "얼마나 찼나"는 알파 합으로 잰다.
function fakeCanvas() {
  const fills = [];
  const ctx = {
    fillStyle: "",
    setTransform() {}, clearRect() { fills.length = 0; },
    beginPath() {}, roundRect() {}, fill() { fills.push(ctx.fillStyle); },
  };
  return {
    fills, style: {}, width: 0, height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 900, height: 400, top: 0, bottom: 400 }),
  };
}
const alphaOf = (f) => Number(f.slice(f.lastIndexOf(",") + 1, -1));
const alphaSum = (fills) => fills.reduce((s, f) => s + alphaOf(f), 0);
// 🔴 "얼마나 찼나"는 **밝기 합이 아니라 앉은 칸 수**로 잰다. 앉는 순간의 잔광이 사그라들면
//    밝기 합은 잠깐 줄어드는데(실측 12s→14s), 그건 되감기가 아니다. 아직 안 앉은 칸은
//    `amp.pre`(라이트 0.016 · 다크 0.022)이고 앉은 칸은 최소 `amp.base`(0.045)라 사이가 넓다.
const seated = (fills) => fills.filter((f) => alphaOf(f) > 0.03).length;

// bootField 가 바깥에서 쓰는 것들만 주입한다. 나머지(Math·JSON…)는 전역 그대로다.
function run({ reduced = false } = {}) {
  const cv = fakeCanvas();
  let frameCb = null;
  new Function(
    "$", "REDUCED", "requestAnimationFrame", "cancelAnimationFrame",
    "IntersectionObserver", "MutationObserver", "addEventListener", "document", "window", "performance",
    `${SRC}\nreturn bootField;`,
  )(
    () => cv,
    reduced,
    (cb) => { frameCb = cb; return 1; },
    () => { frameCb = null; },
    class { constructor(cb) { this.cb = cb; } observe() { this.cb([{ isIntersecting: true }]); } },
    class { observe() {} },
    () => {},
    { documentElement: { dataset: {} }, addEventListener() {} },
    { devicePixelRatio: 1 },
    { now: () => 0 },
  )();
  // t0 = performance.now() = 0 이므로 프레임 인자는 곧 밀리초 경과다
  return { cv, frame: (sec) => frameCb && frameCb(sec * 1000), hasLoop: () => !!frameCb,
           seated: () => seated(cv.fills), light: () => alphaSum(cv.fills) };
}

test("🔴 시간이 가면 다시 그린다 — 정지 회귀 방지", () => {
  const f = run();
  assert.ok(f.hasLoop(), "프레임 루프가 등록되지 않았다 — 배경이 정지 상태다");
  const a = f.cv.fills.join("|");
  f.frame(2);
  assert.notEqual(f.cv.fills.join("|"), a, "2초 뒤에도 그림이 같다 — 시간 항이 빠졌나");
  assert.equal(f.cv.fills.length, 426, "칸 수는 426(행정동)으로 고정이다");
});

test("🔴 단조롭게 차오른다 — 앉은 칸이 도로 일어서면 안 된다", () => {
  const f = run();
  const seen = [];
  for (const s of [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]) { f.frame(s); seen.push(f.seated()); }
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] >= seen[i - 1],
      `${(i - 1) * 2}s → ${i * 2}s 에서 앉은 칸이 줄었다(${seen[i - 1]} → ${seen[i]})`);
  // 🔴 **빈 격자로 시작하지 않는다.** 앞 3초가 0칸이면 로드 직후 배경이 텅 빈 채로 멈춰
  //    보인다(실측으로 잡아 `HEAD` 를 넣었다). 반대로 이미 다 차 있으면 차오르는 게 안 보인다.
  assert.ok(seen[0] > 40, `빈 격자로 시작한다 — 로드 직후 배경이 죽어 보인다(${seen[0]}칸)`);
  assert.ok(seen[0] < 220, `시작이 너무 차 있다 — 차오르는 게 안 보인다(${seen[0]}칸)`);
  assert.equal(seen.at(-1), 426, `18초 안에 다 차야 한다(${seen.at(-1)}칸)`);
});

test("🔴 다 차면 머문다 — 되감아 처음부터 다시 채우지 않는다", () => {
  // 되감으면 "쌓인 것이 사라진다"가 되어 눈썹줄(`Series`)과 배경이 어긋난다.
  const f = run();
  f.frame(20);
  for (const s of [40, 80, 160, 600]) {
    f.frame(s);
    assert.equal(f.seated(), 426, `${s}초에 칸이 비었다 — 주기적으로 리셋되고 있다`);
  }
});

test("🔴 애니메이션을 끈 사용자에게는 **다 찬** 한 장 — 텅 빈 배경이 남으면 안 된다", () => {
  const f = run({ reduced: true });
  assert.equal(f.hasLoop(), false, "prefers-reduced-motion 인데 프레임 루프가 돈다");
  assert.equal(f.cv.fills.length, 426, "한 장은 그려야 한다");
  assert.equal(f.seated(), 426, "정지 화면이 비어 있다 — 첫 프레임 시각(0초)으로 그렸나");
  // 밝은 칸을 미리 심어 정지 화면에서도 리듬이 보인다
  assert.ok(new Set(f.cv.fills).size > 1, "전부 같은 색이다 — 밝은 칸이 안 심겼다");
});

test("🔴 안 보는 프레임은 그리지 않는다 — 배경 장식이 배터리를 태우면 안 된다", () => {
  assert.match(SRC, /IntersectionObserver/, "화면 밖에서 멈출 장치가 없다");
  assert.match(SRC, /visibilitychange/, "탭이 가려져도 계속 돈다");
  assert.match(SRC, /cancelAnimationFrame/, "멈추는 길이 없다");
});
