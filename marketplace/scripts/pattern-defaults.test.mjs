// 플레이그라운드가 질의 패턴 파라미터 칸을 **미리 채우는** 규칙(#218).
//
// 🔴 이 함수가 값을 못 찾으면 칸이 빈 채로 남고, 이용자가 그대로 「호출」을 누르면 값 없는
//    요청이 나가 400 이 된다 — 히어로 칩("요즘 뜨는 상권" 등)에서 들어온 사람이 만나던 벽이
//    정확히 이것이었다(2026-08-12 실측: 게시본 75건이 채워지지 않아 전부 그 길이었다).
//
// 계약은 `:이름=값` 이다(ASAC-DBT#499). 다만 게시본에 **옛 표기가 남아 있는 동안**은 그것도
// 읽는다 — 못 읽어서 빈 칸을 주는 것보다 낫고, 값은 이용자가 고쳐 쓸 수 있다. 게시본이
// 새 표기로 바뀌면 앞 갈래가 먼저 잡아 옛 갈래는 저절로 안 쓰인다.
//
// 옛 표기를 읽어도 안전한 근거: 구분자가 **리터럴 한국어**(`예시`·`예`)라 옆 파라미터의
// 숫자를 주워 올 수 없다. 검증기가 `=` 앵커로 좁힌 이유였던 사고(`:gu=종로구, :from=2026-07-01`
// → `:gu` 에 `2026`)는 이 형태에서 생기지 않는다 — 아래 테스트가 그것도 못박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = await readFile(new URL("../public/catalog.html", import.meta.url), "utf8");
const SRC = HTML.slice(HTML.indexOf("function patternDefaults"), HTML.indexOf("function pickProduct"));
const patternDefaults = new Function(SRC + "; return patternDefaults;")();

test("계약 표기 `:이름=값` 을 읽는다", () => {
  assert.deepEqual(patternDefaults("-- :n=10\nSELECT 1 LIMIT :n"), { n: "10" });
  assert.deepEqual(patternDefaults("-- :gu='강남구'\nSELECT :gu"), { gu: "강남구" });
});

test("옛 표기 `:이름 예시 값` 도 읽는다 — 안 읽으면 칸이 빈 채로 남는다", () => {
  assert.deepEqual(patternDefaults("-- :n 예시 10\nSELECT 1 LIMIT :n"), { n: "10" });
  assert.deepEqual(patternDefaults("-- :top_n 예 8\nSELECT 1 LIMIT :top_n"), { top_n: "8" });
  assert.deepEqual(patternDefaults("-- :category 예시 'food' (음식점)\nSELECT :category"),
    { category: "food" });
});

test("🔴 이름이 코드 쪽에 있고 주석엔 값만 있는 형 — 같은 줄의 파라미터에 붙인다", () => {
  // 실사례: `WHERE closed_category = :closed_category -- 예시 'food'`
  assert.deepEqual(patternDefaults("WHERE c = :closed_category -- 예시 'food'"),
    { closed_category: "food" });
  assert.deepEqual(patternDefaults("HAVING SUM(x) >= :min_active  -- 예: 500 (군소 동 컷)"),
    { min_active: "500" });
});

test("🔴 한 줄에 파라미터가 둘이면 붙이지 않는다 — 어느 것인지 알 수 없다", () => {
  // `WHERE gu IN (:gu_a, :gu_b)  -- 예: '강남구', '마포구'` — 위치로 추측하지 않는다.
  assert.deepEqual(patternDefaults("WHERE gu IN (:gu_a, :gu_b) -- 예: '강남구', '마포구'"), {});
});

test("🔴 옆 파라미터의 값을 훔치지 않는다 (검증기 #756 이 잡았던 사고)", () => {
  const d = patternDefaults("-- :gu=종로구, :from=2026-07-01, :to=2026-08-31");
  assert.equal(d.gu, "종로구", "옆칸 숫자(2026)를 물면 안 된다");
  assert.equal(d.from, "2026-07-01", "날짜가 잘리면 안 된다");
  assert.equal(d.to, "2026-08-31");
});

test("🔴 `예`로 시작하는 낱말을 예시 표시로 오인하지 않는다", () => {
  // `예보`·`예상` 뒤에 구분자(공백·`:`)가 없으므로 값으로 읽지 않는다. 안 막으면
  // `-- 예보 3시간 뒤` 에서 `보` 를 값으로 뽑아 **조용히 틀린 값**이 칸에 찬다.
  // 지금 게시본에는 그런 주석이 0건이지만, 날씨처럼 `예보` 를 쓰는 도메인이 달면 그날 터진다.
  for (const note of ["예보 3시간 뒤", "예상 강수 5mm", "예약 건수", "예정된 행사"])
    assert.deepEqual(patternDefaults("WHERE x = :n -- " + note), {}, note);
});

test("🔴 값이 undefined 로 들어가지 않는다 — 있는 값이 빈 칸으로 보인다", () => {
  // 갈래마다 캡처 그룹 오프셋이 다른데 번호를 손으로 세다 한 칸 밀린 적이 있다.
  // 키는 있는데 값이 undefined 면 화면에는 빈 칸이 뜨고 이 버그는 눈에 안 보인다.
  for (const sql of ["-- :n 예시 10", "WHERE x = :c -- 예시 'food'", "-- :n=10",
                     "HAVING y >= :m  -- 예: 500"])
    for (const [k, v] of Object.entries(patternDefaults(sql)))
      assert.notEqual(v, undefined, `${k} 값이 undefined 다 — 오프셋이 밀렸다: ${sql}`);
});

test("먼저 만난 값을 쓴다 — 뒤의 설명문이 덮어쓰지 않는다", () => {
  assert.deepEqual(patternDefaults("-- :n=10\n-- :n 예시 99\nLIMIT :n"), { n: "10" });
});

test("예시가 없으면 채우지 않는다 — 지어내지 않는다", () => {
  assert.deepEqual(patternDefaults("WHERE category = :category"), {});
  assert.deepEqual(patternDefaults("SELECT 1"), {});
});
