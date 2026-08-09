// 한글 정적 텍스트의 **charset 계약**을 고정한다 (llms.txt 깨짐 제보, 2026-08-09).
//
// 이 결함은 로컬에서 재현되지 않는다 — 로컬 workerd 는 `.txt` 에 charset 을 알아서 붙이고,
// 운영 엣지는 안 붙인다. 즉 **개발자가 눈으로 확인해도 안 보인다.** 그래서 테스트가
// 지키는 것은 응답 헤더가 아니라 **그 헤더가 나오게 하는 배선** 셋이다.
//   ① 두 환경 모두 `run_worker_first` 에 있다
//   ② 두 환경 모두 `[*.assets]` 에 `binding` 이 있다  ← 빠지면 그 파일이 500 이 된다
//   ③ 워커가 charset 을 실제로 덮어쓴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const TOML = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const SRC = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const PATHS = ["/llms.txt", "/robots.txt"];

// `[assets]` 와 `[env.production.assets]` 처럼 **환경별로 따로 쓰는** 블록을 꺼낸다.
function tomlBlock(name) {
  const i = TOML.indexOf(`\n${name}\n`);
  assert.notEqual(i, -1, `${name} 블록이 없다`);
  const j = TOML.indexOf("\n[", i + 1);
  return TOML.slice(i, j === -1 ? undefined : j);
}
const BLOCKS = [["[assets]", "로컬"], ["[env.production.assets]", "운영"]];

test("🔴 두 환경 모두 ASSETS 바인딩이 있다 — env 섹션은 상속되지 않는다", () => {
  for (const [name, label] of BLOCKS)
    assert.match(tomlBlock(name), /binding\s*=\s*"ASSETS"/,
      `${label}(${name})에 바인딩이 없다 — 배포본에서 env.ASSETS 가 undefined 라 ` +
      "그 경로가 그대로 던지고 고치려던 파일이 500 이 된다");
});

test("두 환경 모두 워커를 먼저 태운다 — 한쪽만이면 운영에서만 깨진다", () => {
  for (const [name, label] of BLOCKS) {
    const blk = tomlBlock(name);
    for (const p of PATHS)
      assert.ok(blk.includes(`"${p}"`), `${label}의 run_worker_first 에 ${p} 가 없다`);
  }
});

test("워커가 charset 을 덮어쓴다 — `_headers` 로는 못 한다(덮지 않고 덧붙인다)", () => {
  const fn = SRC.slice(SRC.indexOf("async function serveTextAsset"), SRC.indexOf("async function route"));
  assert.match(fn, /env\.ASSETS\.fetch\(request\)/, "자산을 안 꺼내면 본문이 없다");
  assert.match(fn, /headers\.set\("content-type", "text\/plain; charset=utf-8"\)/);
  // `set` 이어야 한다. `append` 면 값이 콤마로 붙어 망가진 헤더가 된다 — `_headers` 가
  // 정확히 그래서 못 쓰는 방법이었다.
  assert.doesNotMatch(fn, /headers\.append\(\s*"content-type"/);
});

test("원본 응답을 버리지 않는다 — 보안 헤더·상태가 같이 살아야 한다", () => {
  const fn = SRC.slice(SRC.indexOf("async function serveTextAsset"), SRC.indexOf("async function route"));
  // `new Response(res.body, res)` 라야 `_headers` 의 nosniff·CSP·상태 코드가 따라온다.
  assert.match(fn, /new Response\(res\.body, res\)/,
    "헤더를 새로 만들면 _headers 의 보안 헤더가 통째로 사라진다");
});

test("라우터가 게이트보다 앞에서 받는다 — 공개 문서라 키도 쿼터도 없다", () => {
  const router = SRC.slice(SRC.indexOf("async function route(request"));
  const guard = router.indexOf("TEXT_ASSETS.has(path)");
  assert.notEqual(guard, -1, "라우터에 분기가 없다 — run_worker_first 에만 넣으면 404 가 된다");
  assert.ok(guard < router.indexOf("authenticate("), "인증보다 뒤에 있으면 공개 문서가 아니다");
});

test("HEAD 도 받는다 — 크롤러가 robots.txt 를 HEAD 로 두드린다", () => {
  const router = SRC.slice(SRC.indexOf("async function route(request"));
  const line = router.slice(router.indexOf("TEXT_ASSETS.has(path)"), router.indexOf("TEXT_ASSETS.has(path)") + 200);
  assert.match(line, /"HEAD"/);
});

test("대상은 한글이 든 텍스트뿐이다 — 캐시를 잃는 대가가 있다", async () => {
  const set = SRC.slice(SRC.indexOf("const TEXT_ASSETS"), SRC.indexOf("async function serveTextAsset"));
  for (const p of PATHS) assert.ok(set.includes(`"${p}"`));
  // 실제로 한글이 들어 있는지 확인 — 없는 파일을 넣으면 캐시만 잃고 얻는 게 없다.
  for (const p of PATHS) {
    const body = await readFile(new URL(`../public${p}`, import.meta.url), "utf8");
    assert.match(body, /[가-힣]/, `${p} 에 한글이 없다 — 워커를 태울 이유가 없다`);
  }
});
