// 플레이그라운드 키 기억(#218 후속)의 **저장 계약**을 고정한다.
//
// 이 판단은 조용히 틀리면 사고다 — `localStorage` 로 바뀌면 브라우저를 닫아도 키가 살아남아
// 공용 PC 에서 다음 사람에게 넘어간다. 두 코드는 눈으로 보면 똑같이 "동작"하므로,
// 테스트가 유일한 신호다.
//
// jsdom 이 없어 `catalog.html` 을 텍스트로 읽어 구조를 본다(`mcp.test.mjs` 의 재결합 회귀
// 검사와 같은 방식).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const HTML = await readFile(new URL("../public/catalog.html", import.meta.url), "utf8");

test("🔴 키는 sessionStorage 에만 둔다 — localStorage 면 탭을 닫아도 남는다", () => {
  const store = HTML.slice(HTML.indexOf("const KEY_STORE"));
  assert.match(store, /sessionStorage\.setItem\(KEY_STORE/);
  assert.doesNotMatch(store, /localStorage\.(set|get)Item\(KEY_STORE/,
    "키가 localStorage 로 갔다 — 브라우저를 닫아도 살아남는다");
});

test("저장이 막혀도 화면은 돈다 — 프라이빗 모드", () => {
  // storage 접근은 차단 설정에서 던진다. **기억을 못 하는 것과 화면이 죽는 것은 다르다.**
  const fn = HTML.slice(HTML.indexOf("function rememberKey"), HTML.indexOf('$("keyForget")'));
  assert.match(fn, /try \{[\s\S]*catch/, "storage 접근에 try/catch 가 없다");
});

test("폐기·삭제하면 기억도 지운다 — 죽은 키가 되살아나지 않게", () => {
  assert.match(HTML, /if \(purge\) \{ \$\("pKey"\)\.value = ""; rememberKey\(""\); \}/,
    "purge 가 칸만 비우고 저장을 남기면 다음 새로고침에 401 이 난다");
});

test("입력이 바뀌면 기억도 따라간다 — 칸만 비우고 저장이 남으면 되살아난다", () => {
  assert.match(HTML, /\$\("pKey"\)\.addEventListener\("input", \(\) => rememberKey/);
});

test("기억 중이라는 사실을 화면이 말한다 — 지우는 길도 같은 자리에", () => {
  assert.match(HTML, /id="keyMem"/, "기억 상태 표시가 없다");
  assert.match(HTML, /id="keyForget"/, "지우는 버튼이 없다");
  assert.match(HTML, /탭에서만<\/b> 기억합니다/, "어디에 저장하는지 말하지 않는다");
});

test("복원은 렌더 뒤에 돈다 — 미리보기·쿼터가 복원된 키를 반영해야 한다", () => {
  const boot = HTML.slice(HTML.indexOf("async function boot"), HTML.indexOf("if (location.hash) goHash"));
  assert.ok(boot.indexOf("updatePreview()") < boot.indexOf("restoreKey()"),
    "restoreKey 가 렌더보다 먼저면 복원된 키가 화면에 안 붙는다");
});
