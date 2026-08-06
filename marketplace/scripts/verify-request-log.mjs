// 요청 로그 유실 검증 (공통 계약 C-10) — "관측 실패는 응답에 영향 없이 버려진다"의 대가로
// 유실이 눈에 안 보이므로, 요청 N건 → _gateway_request_log 행 N건 증가를 실측으로 확인한다.
// 배경: 시드 체인에서 0004(request_id) 가 빠져 INSERT 가 조용히 전량 실패한 실사고.
// 사용: 게이트웨이(:8787) 를 띄운 상태에서  npm run verify:log
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 127.0.0.1 고정 — localhost 는 환경에 따라 ::1 로 풀려 wrangler dev 와 어긋날 수 있다
const BASE = process.env.MARKETPLACE_BASE || "http://127.0.0.1:8787";

// `fetch` 를 쓰지 않는다 — Node 의 fetch(undici)는 연결을 풀에 넣어 재사용하는데,
// wrangler dev(workerd)가 응답마다 연결을 닫아서 두 번째 요청이 **ECONNRESET** 으로 죽는다
// (curl 로는 같은 요청이 전부 200 인데 이 스크립트만 실패해, 원인을 게이트웨이 쪽에서
// 찾게 만드는 함정이었다). node:http 로 `agent:false` + `connection: close` 를 쓰면
// 매 요청이 새 연결이라 재현되지 않는다.
const get = (url) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { agent: false, headers: { connection: "close" } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject);
  req.end();
});
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function d1(sql) {
  // 단일 문자열 + shell 실행 — Windows 에서 인자 배열이 재파싱되며 공백·괄호가 깨지는 것을 피한다
  const cmd = `npx wrangler d1 execute ask-seoul-dev-d1 --local --json --command "${sql}"`;
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`wrangler d1 execute 실패:\n${r.stderr || r.stdout}`);
  // wrangler 는 배너를 섞어 내보낼 수 있다 — JSON 배열 시작점부터 파싱
  const text = r.stdout.slice(r.stdout.indexOf("["));
  return JSON.parse(text)[0].results;
}

const fail = (msg) => { console.error(`\nFAIL — ${msg}`); process.exit(1); };

// 0) 서버 확인
let catalog;
try {
  catalog = JSON.parse((await get(`${BASE}/api/v1/catalog`)).text);
} catch {
  fail(`게이트웨이(${BASE})에 연결할 수 없다 — npm run dev 로 띄운 뒤 다시 실행할 것`);
}

// 1) 사전 스키마 진단 — 유실의 최다 원인(코드가 아는 컬럼 ≠ 로컬 스키마)을 먼저 짚는다
const cols = new Set(d1("PRAGMA table_info(_gateway_request_log)").map((c) => c.name));
// 코드가 아는 컬럼 목록을 그대로 대조한다 — 하나라도 없으면 INSERT 가 통째로 실패하고,
// 그 실패는 catch 에 먹혀 **로그가 조용히 전량 사라진다**(0004 미적용으로 실제로 겪었다).
const { LOG_COLUMNS } = await import("../src/index.js");
const missing = LOG_COLUMNS.filter((c) => !cols.has(c));
if (missing.length)
  fail(`_gateway_request_log 에 ${missing.join(", ")} 컬럼이 없다 — 시드 체인에 0005 미적용. ` +
    "INSERT 가 조용히 전량 실패하는 상태다(실사고 재현). npm run migrate:apply 후 재실행할 것");

// 2) 실측: 기록 대상 요청 3건 (200 · 200 · 401 — 오류 응답도 기록되는 게 계약이다)
const before = d1("SELECT COUNT(*) AS n FROM _gateway_request_log")[0].n;
const table = catalog.products?.[0]?.name;
if (!table) fail("카탈로그가 비어 있다 — 운영 D1 에 붙었는지(기동 로그의 Mode: remote) 확인할 것");
await get(`${BASE}/api/v1/catalog`);
await get(`${BASE}/api/v1/preview/${table}`);
await get(`${BASE}/api/v1/data/${table}`);              // 키 없음 → 401, 그래도 기록되어야 한다
await new Promise((r) => setTimeout(r, 1500));        // waitUntil 비동기 기록 대기

// 3) 판정
const after = d1("SELECT COUNT(*) AS n FROM _gateway_request_log")[0].n;
const delta = after - before;
if (delta !== 3)
  fail(`요청 3건을 보냈는데 로그가 ${delta}건 늘었다 (${before} → ${after}) — 조용한 유실. ` +
    "logRequest 의 INSERT 컬럼 목록과 로컬 스키마(마이그레이션·시드 체인)를 대조할 것");

const last = d1("SELECT route, status, request_id, env FROM _gateway_request_log ORDER BY ts DESC LIMIT 3");
if (last.some((r) => !r.request_id))
  fail("최근 행에 request_id 가 NULL 이다 — 추적(C-5)이 끊긴다. 헤더·기록 배선을 확인할 것");
// env 는 wrangler.toml `[vars]` 에서 온다. NULL 이면 배선이 끊긴 것이고, 그대로 두면
// 개발·운영 지표가 섞인 채로 한 표에 쌓인다(agreement §6-2).
if (last.some((r) => !r.env))
  fail("최근 행에 env 가 NULL 이다 — wrangler.toml 의 [vars] ASK_ENV 배선을 확인할 것");

console.log(`PASS — 요청 3건 → 로그 +3 (${before} → ${after}), request_id·env 전부 기록됨`);
console.log(last.map((r) => `  ${r.route} ${r.status} ${r.request_id}`).join("\n"));
