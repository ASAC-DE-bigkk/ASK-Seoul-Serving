// OG 카드의 계약 — 링크 공유가 이 프로젝트가 가장 많이 평가받는 순간이다.
//
//   ① og.png 가 실재하고, 규격(1200×630 PNG)이 맞다 — 메타만 있고 파일이 없으면
//      스크레이퍼가 캐시한 "깨진 카드"가 한동안 남는다
//   ② og:image 는 **절대 URL** 이다 — 스크레이퍼는 상대 경로를 못 푼다
//   ③ 큰 카드 규격 세트(width·height·alt + summary_large_image)가 함께 있다 —
//      이미지만 있고 카드 타입이 summary 면 트위터가 작은 카드로 구겨 넣는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pub = (f) => new URL("../public/" + f, import.meta.url);
const INDEX = (await readFile(pub("index.html"), "utf8")).replace(/\r\n/g, "\n");
const CATALOG = (await readFile(pub("catalog.html"), "utf8")).replace(/\r\n/g, "\n");

test("① og.png — 실재 · PNG 시그니처 · 1200×630 · 300KB 이하", async () => {
  const buf = await readFile(pub("og.png"));
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG 시그니처가 아니다");
  // IHDR: 폭·높이는 16~24바이트의 빅엔디언 32비트 둘
  assert.equal(buf.readUInt32BE(16), 1200, "폭이 1200 이 아니다 — OG 큰 카드 규격");
  assert.equal(buf.readUInt32BE(20), 630, "높이가 630 이 아니다");
  assert.ok(buf.length < 300 * 1024,
    "300KB 를 넘었다 — 공유 카드가 이 무게일 이유가 없다(현행 62KB)");
});

for (const [name, html] of [["index.html", INDEX], ["catalog.html", CATALOG]]) {
  test(`②③ ${name} — 절대 URL + 큰 카드 규격 세트`, () => {
    assert.match(html, /property="og:image" content="https:\/\/ask-seoul\.kr\/og\.png"/,
      "og:image 는 절대 URL 이어야 한다 — 스크레이퍼는 상대 경로를 못 푼다");
    assert.match(html, /property="og:image:width" content="1200"/);
    assert.match(html, /property="og:image:height" content="630"/);
    assert.match(html, /property="og:image:alt"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/,
      "summary 로 남으면 트위터가 작은 카드로 구겨 넣는다");
  });
}

test("재생성 문서가 실재한다 — index.html 주석이 가리키는 곳", async () => {
  const doc = await readFile(new URL("../docs/og-image.md", import.meta.url), "utf8");
  assert.match(doc, /og-maker\.mjs/, "재생성 스크립트가 문서에 없다");
});
