import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runSkillDemo, SkillDemoError } from "../public/skill-demo.js";
import { runLiveSmoke } from "./skill-demo-live-smoke.mjs";

const HTML = await readFile(new URL("../public/skill-demo.html", import.meta.url), "utf8");
const CLIENT = await readFile(new URL("../public/skill-demo.js", import.meta.url), "utf8");
const INSTALL_GUIDE = await readFile(new URL("../../docs/k-skill-install-and-use.md", import.meta.url), "utf8");
const SITE_CSS = await readFile(new URL("../public/site.css", import.meta.url), "utf8");
const SYNC = await readFile(new URL("./sync-partials.mjs", import.meta.url), "utf8");
const FOOTER = await readFile(new URL("../partials/footer.html", import.meta.url), "utf8");
const OPENAPI = JSON.parse(await readFile(new URL("../public/skill-openapi.json", import.meta.url), "utf8"));
const EXPECTED_ARTIFACT_COMMIT = "7203c869380f2907175919733b3282742767cbc6";
const DEMO_QUERY_CONTEXT = {
  schema_version: "weather-risk-query-context/v1",
  place_id: "seoul_admd_1120069000",
  requested_from_at: "2026-08-14 00:00:00",
  requested_to_at: "2026-08-14 23:59:59",
  available_from_at: "2026-08-14 00:00:00",
  available_to_at: "2026-08-15 02:00:00",
  snapshot_as_of_hour: "2026-08-14 00:00:00",
  forecast_collected_at_min: "2026-08-14 08:00:00",
  forecast_collected_at_max: "2026-08-14 08:05:00",
  source_population_revision: `kma_admin_dong_grid_20260325:${"0".repeat(64)}`,
  publication_id: "pub-1",
  coverage_status: "covered",
  freshness_state: "fresh",
  zero_result_reason: null,
};

test("API key stays in a password field and module memory only", () => {
  assert.match(HTML, /<input[^>]+id="skillApiKey"[^>]+type="password"/);
  assert.doesNotMatch(CLIENT, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(CLIENT, /console\.(?:log|info|debug|warn|error)/);
  assert.match(CLIENT, /let sessionApiKey = ""/);
  assert.match(CLIENT, /beforeunload/);
});

test("copied install commands and natural-language prompt cannot contain a key", () => {
  assert.doesNotMatch(HTML + CLIENT, /ask_[a-zA-Z0-9]{16,}/);
  assert.match(HTML, /성수2가3동의 이번 주 기상 위험 시간대를 알려줘/);
  assert.match(CLIENT, /clipboard\.writeText\(text\)/);
  assert.match(HTML, /data-copy-source="codexInstall"/);
  assert.match(HTML, /data-copy-source="claudeInstall"/);
});

test("install commands pin one reachable Serving artifact commit", () => {
  const source = HTML + INSTALL_GUIDE;
  assert.doesNotMatch(source, /ARTIFACT_COMMIT_PLACEHOLDER/);
  const refs = [...source.matchAll(/ASK-Seoul-Serving\/archive\/([0-9a-f]{40})\.tar\.gz/g)]
    .map((match) => match[1]);
  assert.equal(refs.length, 4);
  assert.equal(new Set(refs).size, 1);
  assert.deepEqual([...new Set(refs)], [EXPECTED_ARTIFACT_COMMIT]);
});

test("install commands use a skills-cli-compatible commit archive", () => {
  const source = HTML + INSTALL_GUIDE;
  const refs = [...source.matchAll(/ASK-Seoul-Serving\/archive\/([0-9a-f]{40})\.tar\.gz/g)]
    .map((match) => match[1]);
  assert.equal(refs.length, 4);
  assert.equal(new Set(refs).size, 1);
  assert.doesNotMatch(source, /ASK-Seoul-Serving\/tree\/[0-9a-f]{40}\/skills\/seoul-weather-risk/);
});

test("readiness runs bundle, product, then one-row data and preserves request ids", () => {
  assert.match(CLIENT, /\/skill\/v1\/bundles\/seoul-weather-risk/);
  assert.match(CLIENT, /\/skill\/v1\/products\/weather_place_risk_window/);
  assert.match(CLIENT, /\/skill\/v1\/products\/weather_place_risk_window\/data\?place_id=\$\{DEMO_PLACE_ID\}&limit=1/);
  assert.match(CLIENT, /response\.headers\.get\("x-request-id"\)/i);
  assert.match(CLIENT, /Authorization: `Bearer \$\{apiKey\}`/);
});

test("stale/not-ready and zero rows block the live handoff", () => {
  for (const marker of ["401", "403", "404", "429", "503", "network_error", "zero_rows"]) {
    assert.match(CLIENT, new RegExp(marker));
  }
  assert.match(CLIENT, /registration_ready/);
  assert.match(CLIENT, /liveHandoff\.hidden = true/);
});

test("missing key returns keyboard focus to the credential field", () => {
  const handler = CLIENT.slice(
    CLIENT.indexOf('verifyButton.addEventListener("click"'),
    CLIENT.indexOf('document.querySelectorAll("[data-copy-source]"'),
  );
  const guardIndex = handler.indexOf("if (!sessionApiKey.trim())");
  const disableIndex = handler.indexOf("verifyButton.disabled = true");
  assert.notEqual(guardIndex, -1);
  assert.ok(guardIndex < disableIndex);
  assert.match(handler, /keyInput\.focus\(\);\s*return;/);
});

test("successful responses document X-Request-Id for all K-Skill operations", () => {
  for (const path of Object.values(OPENAPI.paths)) {
    const response = path.get.responses["200"];
    assert.equal(response.headers["X-Request-Id"].schema.type, "string");
  }
});

test("page participates in shared chrome without crowding the primary nav", () => {
  assert.match(SYNC, /"skill-demo\.html"/);
  assert.match(FOOTER, /href="\/skill-demo"/);
  assert.doesNotMatch(FOOTER, /API Key[^<]*ask_/);
  assert.match(HTML, /<nav class="nav">/);
  assert.match(HTML, /<footer>/);
});

test("skill demo script uses an explicit cache-busting asset version", () => {
  assert.match(HTML, /<script type="module" src="\/skill-demo\.js\?v=\d{8}"><\/script>/);
});

test("page exposes accessibility and responsive contracts", () => {
  assert.match(HTML, /aria-live="polite"/);
  assert.match(HTML, /aria-describedby="skillKeyHelp"/);
  assert.match(HTML, /<label[^>]+for="skillApiKey"/);
  assert.match(HTML, /@media \(max-width:760px\)/);
  assert.match(HTML, /prefers-reduced-motion/);
});

test("page uses the shared document header and exposes the visitor journey first", () => {
  assert.match(HTML, /<header class="page">\s*<div class="wrap wide">/s);
  assert.match(HTML, /<nav class="toc"[^>]+aria-label="사용 방법"/);
  assert.match(HTML, /href="#install"[^>]*>1\. AI에 설치하기</);
  assert.match(HTML, /href="#connect"[^>]*>2\. 내 API 키 연결</);
  assert.match(HTML, /href="#verify"[^>]*>3\. 연결 상태 확인</);
  assert.doesNotMatch(HTML, /class="skill-hero"/);
});

test("first screen presents Seoul-wide coverage before implementation terms", () => {
  assert.match(HTML, /<h1>서울, 언제 날씨를 조심해야 할까\?<\/h1>/);
  assert.match(HTML, /서울 행정동 이름으로 물어보면, 더위·비·강풍에 주의할 시간대를 알려드려요\./);
  assert.doesNotMatch(HTML, /내 동네, 언제 날씨를 조심해야 할까/);
  assert.doesNotMatch(HTML, /성수2가3동처럼 서울 행정동 이름으로 물어보면/);
  assert.match(HTML, /href="#install"[^>]*>1\. AI에 설치하기</);
  assert.match(HTML, /href="#connect"[^>]*>2\. 내 API 키 연결</);
  assert.match(HTML, /href="#verify"[^>]*>3\. 연결 상태 확인</);
  assert.doesNotMatch(HTML, /ASK 서울의 실제 publication을 읽어 자연어 질문에 답합니다\./);
});

test("successful verification reveals technical evidence through a disclosure", () => {
  assert.match(HTML, /<details class="verification-details" id="verificationDetails" hidden>/);
  assert.match(HTML, /<summary>데이터·검증 정보 보기<\/summary>/);
  assert.match(CLIENT, /verificationDetails\.hidden = false/);
  assert.match(CLIENT, /verificationDetails\.open = true/);
});

test("install commands use full-width document rows instead of nested choice cards", () => {
  assert.match(HTML, /\.install-list\s*\{[^}]*display:grid/s);
  assert.match(HTML, /\.install-row\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/s);
  assert.match(HTML, /<div class="install-list">/);
  assert.match(HTML, /<article class="install-row">/);
  assert.doesNotMatch(HTML, /choice-grid|install-box/);
});

test("page inherits the shared light and dark tokens without private colors", () => {
  const pageStyle = HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  assert.match(SITE_CSS, /:root\s*\{[^}]*--bg:/s);
  assert.match(SITE_CSS, /\[data-theme="dark"\]\s*\{[^}]*--bg:/s);
  assert.match(pageStyle, /\.action-btn\.primary\s*\{[^}]*color:var\(--accent-ink\)/s);
  assert.doesNotMatch(pageStyle, /#[0-9a-f]{3,8}\b/i);
});

test("repeated controls have specific names and touch-sized targets", () => {
  assert.match(HTML, /\.copy-btn, \.action-btn\s*\{[^}]*min-height:44px/s);
  assert.match(HTML, /aria-label="Codex 설치 명령 복사"/);
  assert.match(HTML, /aria-label="Claude Code 설치 명령 복사"/);
  assert.match(HTML, /aria-label="로컬 환경 변수 예시 복사"/);
  assert.match(HTML, /aria-label="자연어 질문 예시 복사"/);
  assert.match(HTML, /@media \(max-width:640px\)[\s\S]*?\.actions \.action-btn\s*\{[^}]*width:100%/s);
});

test("verification is a distinct step that names all three readiness checks", () => {
  assert.match(HTML, /<section class="demo-card" id="verify"[^>]*aria-labelledby="verifyTitle"/);
  assert.match(HTML, /<ol class="readiness-checks" aria-label="검증 항목">/);
  assert.match(HTML, /<code>bundle<\/code>.*registration_ready=true/s);
  assert.match(HTML, /<code>product<\/code>.*registration_ready=true/s);
  assert.match(HTML, /<code>data<\/code>.*query_context=covered\/fresh/s);
});

test("supporting guidance is one flat information region instead of three cards", () => {
  assert.match(HTML, /<aside class="support-panel" aria-labelledby="supportTitle">/);
  assert.match(HTML, /<div class="support-grid">/);
  assert.equal((HTML.match(/<article class="support-item/g) ?? []).length, 3);
  assert.doesNotMatch(HTML, /class="demo-side"/);
});

test("task sections match the shared document density and card radius", () => {
  assert.match(HTML, /\.demo-card\s*\{[^}]*border-radius:9px[^}]*padding:17px/s);
  assert.match(HTML, /\.demo-card h2\s*\{[^}]*font-size:18px/s);
  assert.match(HTML, /\.demo-main\s*\{[^}]*gap:14px/s);
});

test("live runner preserves the three successful request ids", async () => {
  const calls = [];
  const payloads = [
    { bundle_id: "seoul-weather-risk", registration_ready: true, products: [{ product_id: "weather_place_risk_window", registration_ready: true, blockers: [], publication_id: "pub-1" }] },
    { bundle_id: "seoul-weather-risk", product_id: "weather_place_risk_window", registration_ready: true, blockers: [], publication_id: "pub-1", metadata: {} },
    { bundle_id: "seoul-weather-risk", product_id: "weather_place_risk_window", publication_id: "pub-1", row_count: 1, query_context: DEMO_QUERY_CONTEXT, rows: [{ place_id: "seoul_admd_1120069000" }] },
  ];
  const fetchImpl = async (path, options) => {
    calls.push({ path, authorization: options.headers.Authorization });
    const index = calls.length - 1;
    return new Response(JSON.stringify(payloads[index]), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req-${index + 1}` },
    });
  };

  const result = await runSkillDemo({ apiKey: "secret-in-memory", fetchImpl });
  assert.deepEqual(calls.map(({ path }) => path), [
    "/skill/v1/bundles/seoul-weather-risk",
    "/skill/v1/products/weather_place_risk_window",
    "/skill/v1/products/weather_place_risk_window/data?place_id=seoul_admd_1120069000&limit=1",
  ]);
  assert.ok(calls.every(({ authorization }) => authorization === "Bearer secret-in-memory"));
  assert.deepEqual(result.requestIds, { bundle: "req-1", product: "req-2", data: "req-3" });
  assert.equal(result.publicationId, "pub-1");
  assert.equal(result.rowCount, 1);
  assert.equal(result.noCandidate, false);
});

test("live runner blocks not-ready and zero-row responses", async () => {
  const notReady = async () => new Response(JSON.stringify({
    registration_ready: false,
    products: [{ product_id: "weather_place_risk_window", registration_ready: false, blockers: ["quality_freshness_stale"] }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    runSkillDemo({ apiKey: "secret", fetchImpl: notReady }),
    (error) => error instanceof SkillDemoError && error.code === "product_not_ready",
  );

  let call = 0;
  const zeroRows = async () => {
    call += 1;
    const body = call === 1
      ? { registration_ready: true, products: [{ product_id: "weather_place_risk_window", registration_ready: true, blockers: [] }] }
      : call === 2
        ? { registration_ready: true, blockers: [], product_id: "weather_place_risk_window", metadata: {} }
        : { publication_id: "pub-1", row_count: 0, query_context: { ...DEMO_QUERY_CONTEXT, zero_result_reason: null }, rows: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    runSkillDemo({ apiKey: "secret", fetchImpl: zeroRows }),
    (error) => error instanceof SkillDemoError && error.code === "zero_rows",
  );
});

test("live runner accepts a covered fresh no-candidate result but rejects evidence-free empty data", async () => {
  let call = 0;
  const validEmpty = async () => {
    call += 1;
    const body = call === 1
      ? { registration_ready: true, products: [{ product_id: "weather_place_risk_window", registration_ready: true, blockers: [] }] }
      : call === 2
        ? { registration_ready: true, blockers: [], product_id: "weather_place_risk_window", metadata: {} }
        : { publication_id: "pub-1", row_count: 0, query_context: { ...DEMO_QUERY_CONTEXT, zero_result_reason: "no_upcoming_weather_risk_candidate" }, rows: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runSkillDemo({ apiKey: "secret", fetchImpl: validEmpty });
  assert.equal(result.noCandidate, true);
  assert.equal(result.rowCount, 0);
  assert.equal(result.sample, null);
});

test("CLI smoke targets the configured HTTPS origin without exposing its key", async () => {
  const urls = [];
  let call = 0;
  const bodies = [
    { registration_ready: true, products: [{ product_id: "weather_place_risk_window", registration_ready: true, blockers: [] }] },
    { registration_ready: true, product_id: "weather_place_risk_window", blockers: [], metadata: {} },
    { publication_id: "pub-live", row_count: 1, query_context: { ...DEMO_QUERY_CONTEXT, publication_id: "pub-live" }, rows: [{ place_id: "seoul_admd_1120069000" }] },
  ];
  const result = await runLiveSmoke({
    apiKey: "never-print-this",
    baseUrl: "https://ask-seoul.kr",
    fetchImpl: async (url) => {
      urls.push(url);
      const body = bodies[call++];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": `live-${call}` },
      });
    },
  });
  assert.ok(urls.every((url) => url.startsWith("https://ask-seoul.kr/skill/v1/")));
  assert.equal(result.publicationId, "pub-live");
  assert.doesNotMatch(JSON.stringify(result), /never-print-this/);
});
