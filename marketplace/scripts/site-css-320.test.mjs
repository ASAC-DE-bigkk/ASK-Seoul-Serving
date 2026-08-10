// site.css 의 320px 계약 — 문서형 9페이지가 공유하는 뼈대라 여기가 무너지면 전부 밀린다.
//
// 실사고(2026-08-10): `.ep .p`(엔드포인트 경로)가 공백 없는 한 토큰(332px)이라 flex 항목의
// min-width:auto 가 축소를 막아 **docs 가 320px 에서 36px 밀렸다** — CLAUDE.md §5 가
// "대부분의 원인"이라고 경고한 바로 그 패턴. 처방 두 개가 세트다:
//   min-width:0          — flex 항목이 내용보다 좁아질 수 있게
//   overflow-wrap:anywhere — 토큰 중간 줄바꿈을 허락(필요할 때만 꺾여 넓은 화면 무변화)
// 하나만 있으면 안 된다: min-width:0 만으로는 글자가 상자를 뚫고, anywhere 만으로는
// flex 가 애초에 안 줄어든다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CSS = (await readFile(new URL("../public/site.css", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("🔴 .ep .p — min-width:0 + overflow-wrap:anywhere 세트가 유지된다", () => {
  const i = CSS.indexOf(".ep .p {");
  assert.ok(i >= 0, ".ep .p 규칙이 없다");
  const rule = CSS.slice(i, CSS.indexOf("}", i));
  assert.match(rule, /min-width:0/, "min-width:0 이 빠졌다 — flex 항목이 도로 안 줄어든다");
  assert.match(rule, /overflow-wrap:anywhere/, "overflow-wrap:anywhere 가 빠졌다 — 긴 경로가 도로 페이지를 민다");
});
