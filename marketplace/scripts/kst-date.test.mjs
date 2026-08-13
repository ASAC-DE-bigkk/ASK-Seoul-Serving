// 검증·스냅샷 **날짜 표기**의 시간대를 고정한다 (2026-08-13 전수 조사).
//
// 🔴 이 결함은 **눈으로는 절대 안 보인다.** 화면에 `2026-07-31` 이라고 적혀 있고,
//    그 값은 실제로 응답에 있는 문자열의 앞 열 글자다 — 어디에도 깨진 데가 없다.
//    틀린 것은 **그 열 글자가 UTC 라는 사실**뿐이다: `2026-07-31T15:12:23Z` 는
//    한국에서 `2026-08-01 00:12` 다. 화면은 하루 전을 말하면서 멀쩡해 보인다.
//
// 얼마나 흔한가(2026-08-13 운영 실측, `verified_at` 884건):
//   · `YYYY-MM-DDTHH:MM:SSZ` 762건 — 그 중 **389건이 15:00Z 이후** = 한국 날짜로 다음 날
//   · `YYYY-MM-DD`          122건 — 시각이 없다. **이미 날짜라 옮길 순간이 없다**
// 그래서 한 필드 안에서 형태가 갈리고, 처방도 갈려야 한다. 날짜형을 굳이 변환하면
// 없는 정밀도를 지어내는 꼴이다(자정 기준을 우리가 고르는 셈이 된다).
//
// jsdom 이 없으므로 화면 소스에서 함수를 **뽑아** 시험한다(catalog-params.test.mjs 와 같은 방식).
// 사본을 만들지 않는 것이 요점이다 — 사본은 반드시 원본과 갈린다.
// ⚠️ `kstDate` 자체는 앱이 둘로 갈려 있어(랜딩 · QA Lab) **사본이 둘이다.**
//    그래서 마지막 시험이 "둘이 같은 답을 내는가"를 본다 — 한쪽만 고치는 것을 막는 장치다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (p) =>
  (await readFile(new URL(p, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const HTML = await read("../public/index.html");
const LAB = await read("../public/qa-lab/lab.js");

function extract(src, re, name, where) {
  const m = src.match(re);
  assert.ok(m, `${name} 를 ${where} 에서 못 찾았다 — 이름이나 모양이 바뀌었나`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}
const kstDate = extract(HTML, /\nfunction kstDate\(value\) \{[\s\S]*?\n\}/, "kstDate", "index.html");
const kstDateLab = extract(LAB, /\nconst kstDate = \(value\) => \{[\s\S]*?\n\};/, "kstDate", "qa-lab/lab.js");

// 전부 운영에 실제로 있는 값이다 — 지어낸 예시로 시간대를 시험하면 경계를 비껴간다.
const REAL = [
  ["2026-07-31T15:12:23Z", "2026-08-01", "15:00Z 이후 — 한국 날짜는 다음 날(실제 패턴 2건이 이 값)"],
  ["2026-08-12T22:15:01Z", "2026-08-13", "22:15Z = KST 07:15 다음 날"],
  ["2026-08-08T06:00:50Z", "2026-08-08", "이른 UTC — 같은 날 그대로(고쳐도 안 바뀌는 쪽)"],
  ["2026-08-10T11:10:00Z", "2026-08-10", "11:10Z = KST 20:10 같은 날"],
  ["2026-08-10", "2026-08-10", "날짜형 — 옮길 순간이 없다"],
  ["2026-08-04T01:22:59+00:00", "2026-08-04", "demo-samples.json 의 generated_at 모양(Z 가 아니라 +00:00)"],
];

test("운영에 있는 값들이 한국 날짜로 나온다", () => {
  for (const [input, want, why] of REAL)
    assert.equal(kstDate(input), want, `${input} → ${want} 여야 한다 (${why})`);
});

test("🔴 경계는 15:00Z 다 — 하루가 갈리는 자리", () => {
  assert.equal(kstDate("2026-08-12T14:59:59Z"), "2026-08-12", "14:59:59Z = KST 23:59:59 같은 날");
  assert.equal(kstDate("2026-08-12T15:00:00Z"), "2026-08-13", "15:00:00Z = KST 자정 정각 다음 날");
});

test("값이 없거나 못 읽으면 화면을 깨뜨리지 않는다", () => {
  // 각주 한 줄이라 실패해도 조용해야 한다 — 예외를 던지면 데모 전체가 멈춘다.
  for (const v of [null, undefined, ""]) assert.equal(kstDate(v), "", `${v} 는 빈 문자열`);
  assert.equal(kstDate("모르는 값"), "모르는 값", "파싱 실패는 원문 앞부분을 그대로 — 지어내지 않는다");
});

test("🔴 호출자가 원문을 그대로 자르지 않는다 — 이 결함이 있던 자리", () => {
  // 함수가 있어도 안 부르면 소용없다. 되돌아가기 쉬운 한 줄이라 자리를 못 박는다.
  assert.match(HTML, /const snap = kstDate\(SAMPLES && SAMPLES\.generated_at\)/,
    "미리보기 스냅샷 날짜가 kstDate 를 거치지 않는다");
  assert.match(HTML, /"답은 " \+ kstDate\(pat\.verified_at\)/,
    "검증 날짜가 kstDate 를 거치지 않는다");
  assert.match(LAB, /kstDate\(verified\.at\)/, "QA Lab 의 검증 날짜가 kstDate 를 거치지 않는다");
  for (const [src, where] of [[HTML, "index.html"], [LAB, "qa-lab/lab.js"]])
    assert.doesNotMatch(src, /(verified_at|verified\.at|generated_at)[^\n]*\.slice\(0, ?10\)/,
      `${where} 에서 시각 원문을 그대로 자르는 자리가 남아 있다`);
});

test("사본 둘이 같은 답을 낸다 — 한쪽만 고치는 것을 막는다", () => {
  for (const [input] of REAL) assert.equal(kstDateLab(input), kstDate(input), `${input} 에서 갈렸다`);
  assert.equal(kstDateLab("2026-08-12T15:00:00Z"), "2026-08-13", "경계도 같아야 한다");
});
