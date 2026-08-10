// 랜딩 도메인 격자 → 카탈로그 분야 필터의 계약.
//
// 🐛 실사고(2026-08-10): 여섯 타일이 전부 `/catalog` 로 갔다. 타일마다 "제품 22개"·"제품 7개"
//    라고 적어 놓고 **어느 것을 눌러도 57종 전부**를 보여줬다. 화면이 약속한 것과 다른 것을
//    준 셈이라, 사용자는 필터가 걸린 줄 알고 남의 분야 제품을 그 분야로 읽는다.
//
// 지키는 것:
//   ① 제품이 있는 타일은 `?domain=` 을 싣는다 (준비 중 타일은 링크가 아니다)
//   ② 카탈로그가 그 값을 읽어 `activeDomain` 에 건다
//   ③ 🔴 **실재하는 분야일 때만 건다** — 없는 값을 걸면 목록이 0건이 되고 사용자는
//      "제품이 없다"로 읽는다. 링크가 깨진 것과 데이터가 없는 것은 다른 사실이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pub = async (f) =>
  (await readFile(new URL("../public/" + f, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const INDEX = await pub("index.html");
const CATALOG = await pub("catalog.html");

test("🔴 ① 제품이 있는 도메인 타일은 `?domain=` 을 싣는다", () => {
  assert.match(INDEX, /href='\/catalog\?domain=" \+\s*encodeURIComponent\(d\.id\)/,
    "타일이 분야를 안 실으면 어느 것을 눌러도 같은 화면이 나온다");
  assert.doesNotMatch(INDEX, /class='dom' data-dom='" \+ esc\(d\.id\) \+ "' href='\/catalog'>/,
    "필터 없는 옛 링크가 남아 있다");
});

test("① 준비 중(제품 0) 타일은 링크가 아니다 — 빈 목록으로 보내지 않는다", () => {
  assert.match(INDEX, /: "<div class='dom soon' data-dom='/,
    "제품 없는 분야는 div 로 그려야 한다");
});

test("🔴 ② 카탈로그가 `?domain=` 을 읽어 필터를 건다", () => {
  assert.match(CATALOG, /const dom0 = params\.get\("domain"\)/);
  assert.match(CATALOG, /activeDomain = dom0/);
});

test("🔴 ③ 실재하는 분야일 때만 건다 — 없는 값은 무시하고 전체를 보여준다", () => {
  assert.match(CATALOG, /PRODUCTS\.some\(\(p\) => domainOf\(p\) === dom0\)/,
    "실재 확인 없이 걸면 오타 하나에 목록이 0건이 되고 '제품이 없다'로 읽힌다");
});

test("③ 판정은 DOMAINS 상수가 아니라 실제 제품의 접두사다 — renderNav 와 같은 규약", () => {
  // DOMAINS 는 화면용 이름표라 실물보다 늦을 수 있다. 카탈로그가 새 접두사를 내보내면
  // renderNav 는 그 분야를 목록에 넣는데, 여기서 DOMAINS 로 판정하면 그 분야만 필터가
  // 안 걸린다 — 두 곳의 기준이 갈리면 화면이 스스로와 어긋난다.
  const boot = CATALOG.slice(CATALOG.indexOf('const dom0 = params.get("domain")'),
                             CATALOG.indexOf("renderNav(); renderStart()"));
  assert.doesNotMatch(boot, /DOMAINS\.some|DOMAINS\.find/,
    "DOMAINS 로 판정하면 카탈로그가 내보내는 새 분야를 못 건다");
});
