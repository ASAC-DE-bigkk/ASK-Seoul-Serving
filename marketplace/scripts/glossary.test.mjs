// 용어 사전 문(#180)의 계약을 고정한다.
//
// 예전엔 `vocabulary_id` 없이 부르면 **400** 이었는데, 그 값을 알아낼 경로가 어디에도 없었다 —
// 컬럼이 자기 어휘를 선언하지 않으므로 소비자는 `<도메인>:<컬럼명>` 같은 규칙을 **지어내야**
// 했고 대부분 404 였다. 목록을 열어 추측을 없앤 자리다.
//
// 🔴 조용히 되돌아갈 수 있는 변경이다 — 목록 분기를 지워도 개별 조회는 멀쩡히 돌아서
//    "동작한다"로 보인다. 그래서 **파라미터 없는 호출**을 따로 단언한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGlossary } from "../src/v1.js";

/** `d1_catalog_glossary` 한 표만 흉내낸다. `rows === null` 은 "표가 없다"(→503)다. */
function envWith(rows) {
  return { DB: { prepare: () => ({
    bind: () => ({ all: async () => (rows === null ? Promise.reject(new Error("no table")) : { results: rows }) }),
    all: async () => (rows === null ? Promise.reject(new Error("no table")) : { results: rows }),
  }) } };
}

const LIST = [
  { vocabulary_id: "commerce:category", origin: "commerce", term_count: 12 },
  { vocabulary_id: "common:gu_code", origin: "asac_axes", term_count: 25 },
];

test("파라미터 없이 부르면 **어휘 목록**을 준다 — 400 이 아니다", async () => {
  const res = await handleGlossary(envWith(LIST), null, {});
  assert.equal(res.status, 200, "400 이면 소비자가 다시 id 를 지어내야 한다");
  const body = await res.json();
  assert.deepEqual(body.vocabularies, LIST);
  // 목록만 주고 끝내면 "그래서 어떻게 쓰나"가 남는다
  assert.match(body.next, /vocabulary_id=/);
});

test("빈 문자열도 목록으로 친다 — `?vocabulary_id=` 는 '모른다'는 뜻이다", async () => {
  const res = await handleGlossary(envWith(LIST), "", {});
  assert.equal(res.status, 200);
});

test("표가 없으면 목록도 503 — 개별 조회와 같은 어휘로 답한다", async () => {
  const res = await handleGlossary(envWith(null), null, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).title, "glossary unavailable");
});

test("아직 아무 어휘도 안 실렸으면 빈 목록 200 — 404 가 아니다", async () => {
  // 표는 있는데 행이 0 인 것과 표가 없는 것은 다르다(`safeRows` 가 그 둘을 가른다).
  const res = await handleGlossary(envWith([]), null, {});
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).vocabularies, []);
});

test("id 를 주면 예전 그대로 — 코드값을 준다", async () => {
  const terms = [{ code: "A", label_ko: "가", origin: "commerce", source_type: "seed" }];
  const res = await handleGlossary(envWith(terms), "commerce:category", {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.vocabulary_id, "commerce:category");
  assert.deepEqual(body.terms, terms);
});

test("없는 어휘는 404 — 목록이 열려도 지어낸 id 는 여전히 막힌다", async () => {
  const res = await handleGlossary(envWith([]), "commerce:nope", {});
  assert.equal(res.status, 404);
});

test("관측: 목록 조회도 표 이름과 행 수를 남긴다", async () => {
  const trace = {};
  await handleGlossary(envWith(LIST), null, trace);
  assert.equal(trace.table, "d1_catalog_glossary");
  assert.equal(trace.rows, 2);
});
