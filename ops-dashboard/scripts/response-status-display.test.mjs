#!/usr/bin/env node
/**
 * 응답 상태 실패 목록은 제품의 사람 이름을 우선 보여 주되, 운영 진단용 물리 표명은 함께 남긴다.
 *
 * Worker와 인라인 UI가 한 파일씩인 구조라, 이 검사는 둘 사이의 응답 계약을 정적으로 고정한다.
 * D1이나 로컬 개발 서버를 열지 않는다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = readFileSync(resolve(ROOT, "src/index.js"), "utf8");
const page = readFileSync(resolve(ROOT, "public/index.html"), "utf8");

const failureQuery = worker.slice(
  worker.indexOf("// 🔴 실패 목록의 분야도 `product_id` 에서 뽑는다."),
  worker.indexOf("safeRows(env, topPerDomain(", worker.indexOf("// 🔴 실패 목록의 분야도 `product_id` 에서 뽑는다.")) + 500,
);
assert.match(
  failureQuery,
  /SELECT status, route, table_name, MAX\(product_id\) AS product_id,/,
  "실패 집계는 표시명 조회에 필요한 product_id를 보존해야 한다",
);

const summaryResponse = worker.slice(
  worker.indexOf("serving: { routes:"),
  worker.indexOf("usage: { funnel:"),
);
assert.match(
  summaryResponse,
  /failures: failures\.rows\.map\(\(r\) => \(\{[\s\S]*display_title: \(r\.product_id && udisp\.map\.get\(r\.product_id\)\?\.title\) \|\| null/,
  "요약 응답은 기존 표시명 맵으로 실패 행의 display_title을 붙여야 한다",
);

const failureView = page.slice(
  page.indexOf("const apiName = (r) =>"),
  page.indexOf("$(\"empty\").innerHTML", page.indexOf("const apiName = (r) =>")),
);
assert.match(
  failureView,
  /const apiName = \(r\) => r\.display_title[\s\S]*esc\(r\.display_title\)[\s\S]*pill dim[\s\S]*esc\(r\.table_name \|\| r\.product_id \|\| r\.product_key \|\| "—"\)/,
  "표시명이 있으면 제목과 물리 식별자 pill을 함께 보여야 한다",
);
assert.match(
  failureView,
  /: esc\(r\.table_name \|\| r\.product_id \|\| r\.product_key \|\| "—"\)/,
  "표시명이 없으면 기존 식별자로 폴백해야 한다",
);
assert.match(
  failureView,
  /\{ t:"대상 API", get:apiName, name:true \}/,
  "실패 목록도 제목 우선 표시 렌더러를 사용해야 한다",
);

console.log("response-status-display: product title, pill, and fallback contracts verified");
