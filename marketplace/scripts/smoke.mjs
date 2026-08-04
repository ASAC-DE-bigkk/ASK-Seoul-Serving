// 배포 스모크 — 올린 직후 "정말 서비스 가능한가"를 외부에서 본다.
// 로컬 검증(npm test·verify:log)은 코드가 맞는지를 보고, 이건 배포본이 맞는지를 본다.
// 쓰기를 하지 않는다: 키를 발급하면 그 환경 D1 에 이메일이 남는다. 인증 경로를 보려면
// 이미 있는 키를 SMOKE_KEY 로 넘긴다(없으면 그 항목만 건너뛰고 사유를 남긴다).
//
// 사용: node scripts/smoke.mjs https://<worker-host>          (무인증 항목만)
//       SMOKE_KEY=ask_… node scripts/smoke.mjs https://<host> (인증 항목까지)
const BASE = (process.argv[2] || process.env.SMOKE_BASE || "").replace(/\/$/, "");
if (!BASE) {
  console.error("사용법: node scripts/smoke.mjs <base-url>   예) node scripts/smoke.mjs https://ask-seoul-gateway.example.workers.dev");
  process.exit(2);
}
const KEY = process.env.SMOKE_KEY || "";

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
};
const skip = (name, why) => results.push({ name, skip: true, detail: why });
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// 1) 카탈로그 — 제품이 실제로 보이는가. 로컬 픽스처가 아니라 그 환경 D1 을 읽는지의 첫 증거다
let firstProduct = null;
await check("catalog 200 + 제품 존재", async () => {
  const r = await fetch(`${BASE}/api/catalog`);
  must(r.ok, `status ${r.status}`);
  const j = await r.json();
  must(Array.isArray(j.products) && j.products.length > 0, "products 비어 있음");
  must(j.attribution && j.docs, "attribution·docs 링크 누락");
  firstProduct = j.products[0].name;
  return `${j.products.length}종 · 첫 제품 ${firstProduct}`;
});

// 2) 요청 ID — 지원 문의의 유일한 열쇠(공통 계약 C-5). 없으면 추적이 끊긴다
await check("X-Request-Id 헤더", async () => {
  const r = await fetch(`${BASE}/api/catalog`);
  const id = r.headers.get("x-request-id");
  must(id && id.startsWith("req_"), `헤더 값 '${id}'`);
  return id;
});

// 3) 미리보기 — 무인증으로 실물이 보이는가(키 없이 판단할 수 있어야 한다)
await check("preview 200 + 행 반환", async () => {
  must(firstProduct, "카탈로그 실패로 대상 없음");
  const r = await fetch(`${BASE}/api/preview/${encodeURIComponent(firstProduct)}`);
  must(r.ok, `status ${r.status}`);
  const j = await r.json();
  must(j.row_count > 0, `row_count ${j.row_count}`);
  return `${j.row_count}행`;
});

// 4) 인증 게이트 — 키 없이 데이터가 나가면 안 된다
await check("data 401 (키 없음)", async () => {
  must(firstProduct, "카탈로그 실패로 대상 없음");
  const r = await fetch(`${BASE}/api/data/${encodeURIComponent(firstProduct)}`);
  must(r.status === 401, `status ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  must(ct.includes("problem+json"), `content-type ${ct}`);
  const j = await r.json();
  must(j.request_id, "오류 본문에 request_id 없음");
  return "401 problem+json + request_id";
});

// 5) 없는 제품 — 404 이고 problem+json 이어야 한다(비공개 제품도 404 로 답하는 설계)
await check("없는 제품 404", async () => {
  const r = await fetch(`${BASE}/api/data/gold_does_not_exist`);
  must([401, 404].includes(r.status), `status ${r.status}`);
  return `status ${r.status}`;
});

// 6) 정적 페이지 — 사람이 볼 문서가 같이 올라갔는가
for (const [name, path] of [["/legal", "/legal"], ["/llms.txt", "/llms.txt"], ["/openapi.json", "/openapi.json"]]) {
  await check(`정적 ${name}`, async () => {
    const r = await fetch(`${BASE}${path}`);
    must(r.ok, `status ${r.status}`);
    return `status ${r.status}`;
  });
}

// 7) 발급 경로가 닫혀 있지 않은가 — 솔트 미설정이면 503 이 난다(시크릿 누락 조기 발견).
//    실제로 발급하지 않고 잘못된 본문으로 400 을 유도해, 503 인지 아닌지만 구분한다.
await check("발급 경로 활성(솔트 설정 확인)", async () => {
  const r = await fetch(`${BASE}/api/keys`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  must(r.status !== 503, "503 issuance disabled — ISSUANCE_SALT 시크릿 미설정");
  must(r.status === 400, `기대 400(잘못된 본문), 실제 ${r.status}`);
  return "400 (솔트 설정됨, 발급 자체는 시도하지 않음)";
});

// 8) MCP 발견 단계 — PlayMCP·claude.ai 등록의 첫 관문(#26). 인증·쿼터 미소모 설계라
//    무인증으로 본다. run_worker_first 에 /mcp 가 빠지면 여기서 405/404 로 잡힌다.
const mcpRpc = (method, id) =>
  fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
  });
await check("MCP initialize", async () => {
  const r = await mcpRpc("initialize", 1);
  must(r.ok, `status ${r.status}`);
  const j = await r.json();
  must(j.result?.serverInfo?.name === "ask-seoul", "serverInfo 누락/불일치");
  return `protocol ${j.result.protocolVersion}`;
});
await check("MCP tools/list 5툴", async () => {
  const r = await mcpRpc("tools/list", 2);
  must(r.ok, `status ${r.status}`);
  const j = await r.json();
  must(Array.isArray(j.result?.tools) && j.result.tools.length === 5, `tools ${j.result?.tools?.length ?? "없음"}`);
  return j.result.tools.map((t) => t.name).join(",");
});

// 9) 인증 조회 — 키가 주어졌을 때만. 쿼터 헤더까지 확인한다
if (KEY) {
  await check("인증 data 200 + 쿼터 헤더", async () => {
    must(firstProduct, "카탈로그 실패로 대상 없음");
    const r = await fetch(`${BASE}/api/data/${encodeURIComponent(firstProduct)}?limit=1`,
      { headers: { authorization: `Bearer ${KEY}` } });
    must(r.ok, `status ${r.status}`);
    must(r.headers.get("x-ratelimit-limit"), "X-RateLimit-Limit 누락");
    const j = await r.json();
    return `${j.row_count}행 · 잔여 ${r.headers.get("x-ratelimit-remaining")}`;
  });
} else {
  skip("인증 data 200", "SMOKE_KEY 미지정 — 쓰기를 피하려 키를 발급하지 않는다");
}

const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].length));
console.log(`\n스모크 대상: ${BASE}\n`);
for (const r of results)
  console.log(`  ${r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 34)} ${r.detail}`);
const failed = results.filter((r) => !r.ok && !r.skip);
console.log(`\n${results.filter((r) => r.ok).length} PASS · ${failed.length} FAIL · ${results.filter((r) => r.skip).length} SKIP\n`);
process.exit(failed.length ? 1 : 0);
