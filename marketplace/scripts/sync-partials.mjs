#!/usr/bin/env node
/**
 * sync-partials — 머리(nav)·바닥(footer)을 partials/ 한 벌에서 8페이지로 퍼뜨린다.
 *
 * 왜 이게 필요했나: 같은 nav 마크업이 7개 파일에 복제돼 있어서, 테마 토글을 넣을 때
 * 7곳을 고쳐야 했다. 팔레트도 같은 이유로 갈라져 5페이지가 구 테라코타로 남았던
 * 사고가 있었다(2026-08-03). 복제가 원인이므로 정본을 하나로 둔다.
 *
 * 왜 정적 사이트 생성기가 아닌가: public/ 은 지금도 앞으로도 **그대로 서빙되는 정본**이다
 * (wrangler [assets] directory = "public"). 여기서 src/ → dist/ 를 만들기 시작하면
 * 배포 경로에 빌드 단계가 생기고 그건 결정 문서·멘토 게이트 영역이다(CLAUDE.md §6).
 * 이 스크립트는 렌더러가 아니라 **동기화기**다 — 결과물은 여전히 손으로 읽고 고칠 수
 * 있는 HTML 이고, 커밋 diff 에 그대로 드러난다.
 *
 *   node scripts/sync-partials.mjs          정본을 각 페이지에 적용
 *   node scripts/sync-partials.mjs --check  어긋난 페이지가 있으면 1 로 종료 (npm test 가 부른다)
 *
 * 페이지가 늘면 PAGES 에 한 줄 추가한다. catalog.html 은 머리가 사이드바라 대상이 아니다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(ROOT, "public");

/**
 * 페이지마다 다른 건 셋뿐이다:
 *   navIn  — 바깥 폭. 랜딩만 1140px(.wrap)이고 문서형은 1080px(.nav-in 자체)이다.
 *   active — 현재 위치를 굵게 표시할 링크. 없으면 어느 것도 표시하지 않는다.
 *   keep   — 760px 아래에서도 남길 링크(.keep). 랜딩만 카탈로그를 남긴다.
 *   cta    — 오른쪽 버튼. [href, 라벨] 또는 null.
 */
const PAGES = {
  "index.html":   { navIn: "wrap nav-in", active: null,      keep: ["/catalog"], cta: ["/catalog#auth", "시작하기"] },
  "docs.html":    { navIn: "nav-in",      active: "/docs",   keep: [],           cta: ["/catalog#auth", "키 발급"] },
  "guide.html":   { navIn: "nav-in",      active: "/guide",  keep: [],           cta: ["/catalog#auth", "시작하기"] },
  "status.html":  { navIn: "nav-in",      active: "/status", keep: [],           cta: null },
  "support.html": { navIn: "nav-in",      active: null,      keep: [],           cta: null },
  "legal.html":   { navIn: "nav-in",      active: null,      keep: [],           cta: null },
  "404.html":     { navIn: "nav-in",      active: null,      keep: [],           cta: null },
};

const NAV_RE = /<nav class="nav">[\s\S]*?<\/nav>/;
const FOOTER_RE = /<footer>[\s\S]*?<\/footer>/;

const navTpl = readFileSync(join(ROOT, "partials/nav.html"), "utf8").trimEnd();
const footerTpl = readFileSync(join(ROOT, "partials/footer.html"), "utf8").trimEnd();

function renderNav(cfg) {
  let out = navTpl.replace("{{NAV_IN}}", cfg.navIn);

  // nav-links 의 각 <a> 에 상태 클래스를 붙인다. 정본에는 클래스가 없고 여기서만 생긴다 —
  // 그래야 "어느 페이지가 어디를 활성으로 보는가"가 PAGES 한 곳에만 적힌다.
  out = out.replace(/<a href="([^"]+)">/g, (m, href) => {
    const cls = [];
    if (href === cfg.active) cls.push("active");
    if (cfg.keep.includes(href)) cls.push("keep");
    return cls.length ? `<a class="${cls.join(" ")}" href="${href}">` : m;
  });

  const cta = cfg.cta ? `    <a class="nav-cta" href="${cfg.cta[0]}">${cfg.cta[1]}</a>\n` : "";
  return out.replace("{{CTA}}", cta);
}

const check = process.argv.includes("--check");
const stale = [];
let written = 0;

for (const [name, cfg] of Object.entries(PAGES)) {
  const path = join(PUB, name);
  const src = readFileSync(path, "utf8");

  if (!NAV_RE.test(src)) throw new Error(`${name}: <nav class="nav"> 를 찾지 못했다`);
  if (!FOOTER_RE.test(src)) throw new Error(`${name}: <footer> 를 찾지 못했다`);

  // $ 를 특수문자로 해석하지 않도록 함수형 치환을 쓴다 — 마크업에 $& 가 들어가면 깨진다
  const nav = renderNav(cfg);
  const out = src.replace(NAV_RE, () => nav).replace(FOOTER_RE, () => footerTpl);

  if (out === src) continue;
  if (check) { stale.push(name); continue; }
  writeFileSync(path, out, "utf8");
  written++;
  console.log(`synced ${name}`);
}

if (check) {
  if (stale.length) {
    console.error(`partial 이 어긋난 페이지: ${stale.join(", ")}`);
    console.error("→ `npm run sync` 를 돌리고 결과를 커밋한다 (정본은 partials/).");
    process.exit(1);
  }
  console.log(`partials 정합 OK (${Object.keys(PAGES).length}페이지)`);
} else {
  console.log(written ? `${written}개 페이지 갱신` : "이미 정합 — 바뀐 페이지 없음");
}
