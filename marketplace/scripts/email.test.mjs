// normalizeEmail 단독 테스트 (#109) — 실행: npm test
//
// 이 함수가 있는 이유: `_keys.email UNIQUE` 가 "이메일당 1키"를 지키는 **유일한 실질 장치**인데,
// 같은 메일함을 가리키는 두 문자열이 들어오면 그 제약이 통과된다. 실제로 prod 에서
// `qe@gg.gg.` 와 `qe@gg.gg` 가 각각 키를 받았다(2026-08-06, #109).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail } from "../src/shared.js";

// [입력, 기대 정규화 결과] — 통과해야 하는 것. 기존 이용자를 깨지 않는 게 조건이다.
const VALID = [
  ["qe@gg.gg", "qe@gg.gg"],
  ["  QE@GG.GG  ", "qe@gg.gg"],                              // trim + lowercase 는 기존 동작
  ["user+tag@example.co.kr", "user+tag@example.co.kr"],      // 플러스 주소는 제공자 소관 — 손대지 않는다
  ["a.b@sub-domain.example.com", "a.b@sub-domain.example.com"],
  ["x@a1.co", "x@a1.co"],
];

// 후행 점은 **거절이 아니라 정규화**다 — DNS 루트 표기(`example.com.`)라 같은 메일함을 가리킨다.
// 거절해도 우회는 막히지만, 정규화하면 이후에 같은 주소로 오는 요청이 409(재발급 확인)로
// 제대로 합류한다. 우리가 고치려는 건 "같은 사람이 두 신원을 갖는 것"이므로 합치는 쪽이 맞다.
const TRAILING_DOT = [
  ["qe@gg.gg.", "qe@gg.gg"],
  ["qe@gg.gg...", "qe@gg.gg"],
  ["  QE@GG.GG.  ", "qe@gg.gg"],
];

// null 을 돌려줘야 하는 것 — 정규화로 살릴 수 없는 형식들.
const INVALID = [
  "", "   ", null, undefined,
  "qe@gg..gg",     // 빈 레이블 — 후행 점과 달리 같은 도메인의 다른 표기가 아니다
  "qe@.gg.gg",     // 선행 점
  "qe@-gg.gg",     // 레이블이 하이픈으로 시작
  "qe@gg-.gg",     // 레이블이 하이픈으로 끝
  "qe@gg",         // 점 없음 — 기존 정규식도 막던 것
  "qe@.",
  "qe@",
  "@gg.gg",
  "q e@gg.gg",     // 로컬에 공백
  "qe@gg gg.gg",   // 도메인에 공백
  "qe@gg.gg@gg.gg",
];

test("정상 주소는 trim·lowercase 만 거쳐 그대로 통과한다", () => {
  for (const [input, expected] of VALID)
    assert.equal(normalizeEmail(input), expected, `입력: ${JSON.stringify(input)}`);
});

test("도메인 후행 점은 같은 메일함이므로 합쳐진다 — #109 우회 경로", () => {
  for (const [input, expected] of TRAILING_DOT)
    assert.equal(normalizeEmail(input), expected, `입력: ${JSON.stringify(input)}`);
});

test("정규화로 살릴 수 없는 형식은 null", () => {
  for (const input of INVALID)
    assert.equal(normalizeEmail(input), null, `입력: ${JSON.stringify(input)}`);
});

test("🔴 #109 재현 — 후행 점만 다른 두 입력이 같은 값으로 수렴한다", () => {
  // prod 에서 이 둘이 각각 키를 받았다(ask_6233 · ask_82aa). 같은 값이 되어야
  // `_keys.email UNIQUE` 가 두 번째를 409 로 돌려보낸다.
  assert.equal(normalizeEmail("qe@gg.gg."), normalizeEmail("qe@gg.gg"));
});

test("빈 레이블은 후행 점과 다르다 — 합치지 않고 거절한다", () => {
  // `gg..gg` 는 `gg.gg` 의 다른 표기가 아니라 그냥 잘못된 도메인이다.
  // 점을 전부 뭉개면 서로 다른 도메인이 같은 값으로 붙어 더 큰 사고가 된다.
  assert.notEqual(normalizeEmail("qe@gg..gg"), normalizeEmail("qe@gg.gg"));
  assert.equal(normalizeEmail("qe@gg..gg"), null);
});
