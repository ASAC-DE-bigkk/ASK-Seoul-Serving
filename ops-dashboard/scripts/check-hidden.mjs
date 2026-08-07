#!/usr/bin/env node
/**
 * `hidden` 으로 감추는 요소 중 **실제로는 안 감춰지는** 것을 찾는다.
 *
 * 브라우저 기본 `[hidden]{display:none}` 은 **UA 스타일이라 author 규칙한테 진다.**
 * 그래서 `ui.css` 에 `.scopebar{display:flex}` 같은 규칙이 있으면, JS 가
 * `el.hidden = true` 를 걸어도 화면에는 **그대로 보인다.**
 *
 * 🔴 이건 `el.hidden` 을 읽는 검사로는 절대 안 잡힌다 — 속성은 제대로 걸려 있고,
 *    jsdom 도 이 캐스케이드를 계산하지 않는다. 실제로 그 사각지대 때문에 같은 결함을
 *    **JS 쪽에서 두 번 고치는 동안 원인이 CSS 에 남아 있었다**(#163 → #168).
 *    그래서 브라우저 없이 도는 정적 감사를 둔다.
 *
 *   npm run check:hidden        # 통과 기준: 0건
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
const css = readFileSync(resolve(ROOT, "public/ui.css"), "utf8");

// 인라인 <style> 도 본다 — 규약상 재사용 규칙은 ui.css 지만, 화면 전용 규칙이 남아 있을 수 있다.
const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const sheet = css + "\n" + inline;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 감출 대상: JS 가 `.hidden =` 을 세팅하는 id + 마크업에 hidden 을 달고 시작하는 id
const ids = new Set([...html.matchAll(/\$\("([\w-]+)"\)\.hidden\s*=/g)].map((m) => m[1]));
for (const m of html.matchAll(/<[^>]*id="([\w-]+)"[^>]*\shidden[^>]*>/g)) ids.add(m[1]);

/** 이 셀렉터에 display 를 주는 규칙이 있나(콤마로 묶인 규칙도 본다). */
const givesDisplay = (sel) =>
  new RegExp("(^|[,{}])\\s*" + esc(sel) + "\\s*(:[\\w-]+)?\\s*(,[^{]*)?\\{[^}]*display\\s*:", "m").test(sheet);
/** 그 셀렉터에 [hidden] 방어가 있나. */
const hasGuard = (sel) => new RegExp(esc(sel) + "\\s*\\[hidden\\]").test(sheet);

const bad = [];
for (const id of ids) {
  const tag = html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'));
  const cls = tag ? (tag[0].match(/class="([^"]+)"/) || [, ""])[1] : "";
  const sels = ["#" + id, ...cls.split(/\s+/).filter(Boolean).map((c) => "." + c)];
  const withDisplay = sels.filter(givesDisplay);
  if (withDisplay.length && !sels.some(hasGuard)) bad.push({ id, sels: withDisplay });
}

if (!bad.length) {
  console.log(`check-hidden: ${ids.size}개 요소 확인 — 전부 안전`);
  process.exit(0);
}
console.error("check-hidden: 🔴 hidden 이 안 먹는 요소가 있다\n");
for (const b of bad) {
  console.error(`  #${b.id}  —  ${b.sels.join(" ")} 가 display 를 주는데 [hidden] 규칙이 없다`);
  console.error(`     고치는 법: ui.css 에  ${b.sels[0]}[hidden] { display:none; }`);
}
console.error("\n  UA 기본 [hidden]{display:none} 은 author 규칙한테 진다 — 직접 꺼야 한다.");
process.exit(1);
