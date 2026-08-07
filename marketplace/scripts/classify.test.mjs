// classifyClient 단독 테스트 (#9 §3) — 실제 UA 문자열 기준. 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClient, clientAxes, refererHost, normalizeIntent, agentVerified, normalizeMcpClient } from "../src/shared.js";

const cases = [
  // AI — crawler (사전 수집)
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
    { ua_class: "ai_crawler", agent_name: "openai", agent_mode: "crawler" }],
  ["Mozilla/5.0; ClaudeBot/1.0; +claudebot@anthropic.com",
    { ua_class: "ai_crawler", agent_name: "anthropic", agent_mode: "crawler" }],
  ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    { ua_class: "ai_crawler", agent_name: "perplexity", agent_mode: "crawler" }],
  ["Mozilla/5.0 (compatible; Google-Extended/1.0)",
    { ua_class: "ai_crawler", agent_name: "google", agent_mode: "crawler" }],
  ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    { ua_class: "ai_crawler", agent_name: "meta", agent_mode: "crawler" }],
  ["CCBot/2.0 (https://commoncrawl.org/faq/)",
    { ua_class: "ai_crawler", agent_name: "commoncrawl", agent_mode: "crawler" }],

  // AI — on_demand (사용자 질문 대행) — 같은 벤더의 crawler 패턴에 오분류되지 않아야 한다
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    { ua_class: "ai_agent", agent_name: "openai", agent_mode: "on_demand" }],
  ["Mozilla/5.0; Claude-User/1.0; +Claude-User@anthropic.com",
    { ua_class: "ai_agent", agent_name: "anthropic", agent_mode: "on_demand" }],
  ["Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    { ua_class: "ai_agent", agent_name: "perplexity", agent_mode: "on_demand" }],

  // cli — MCP·에이전트 툴이 실제로 쓰고 오는 얼굴들 (#9 §3 'cli 가 함정')
  ["curl/8.4.0", { ua_class: "cli", agent_name: null, agent_mode: null }],
  ["python-httpx/0.27.0", { ua_class: "cli", agent_name: null, agent_mode: null }],
  ["node-fetch/1.0 (+https://github.com/bitinn/node-fetch)", { ua_class: "cli", agent_name: null, agent_mode: null }],
  ["Go-http-client/2.0", { ua_class: "cli", agent_name: null, agent_mode: null }],

  // 일반 bot — AI 목록에 없는 크롤러는 bot 으로만 남긴다 (Googlebot ≠ Google-Extended)
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    { ua_class: "bot", agent_name: null, agent_mode: null }],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    { ua_class: "bot", agent_name: null, agent_mode: null }],

  // browser
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    { ua_class: "browser", agent_name: null, agent_mode: null }],

  // no_ua — UA 헤더 자체가 없다 (#112). Node 18+ 의 global fetch 가 대표적이다
  ["", { ua_class: "no_ua", agent_name: null, agent_mode: null }],
  [null, { ua_class: "no_ua", agent_name: null, agent_mode: null }],
  [undefined, { ua_class: "no_ua", agent_name: null, agent_mode: null }],

  // unknown — UA 는 왔는데 못 알아봤다. 매칭 실패는 지어내지 않는다
  ["WeirdClient/0.1", { ua_class: "unknown", agent_name: null, agent_mode: null }],
  ["node", { ua_class: "unknown", agent_name: null, agent_mode: null }],
];

for (const [ua, expected] of cases) {
  test(`${JSON.stringify(ua)} → ${expected.ua_class}${expected.agent_name ? "/" + expected.agent_name : ""}`, () => {
    assert.deepEqual(classifyClient(ua), expected);
  });
}

// ── 요청 축 (#9 · agreement §3) ───────────────────────────────────────────────
// 여기서 지키는 건 정확도가 아니라 **원문이 안 남는다**는 것이다. 컬럼이 늘 때 원문 축이
// 섞여 들어오면 §3 대원칙이 조용히 깨지고, 같은 행의 key_hash 가 이메일과 1:1 이라
// 그 순간 "이메일에 연결된 이력"이 된다.

// `cf` 는 Cloudflare 런타임이 Request 에 얹는 확장이라 Node 의 Request 로는 못 만든다
// (init 에 넣어도 무시된다 — 방금 이 테스트가 그걸로 한 번 깨졌다). `clientAxes` 가 쓰는
// 모양(`.cf` · `.headers.get`)만 갖춘 스텁을 쓴다.
//
// 참고: `wrangler dev` 는 로컬에서도 `cf` 를 채운다(실측 `country=KR · asn=4766`). 그래서
// 아래 "없으면 NULL" 은 로컬 동작이 아니라 **가드 자체**를 고정하는 것이다.
const req = (headers = {}, cf) => ({ cf, headers: new Headers(headers) });

test("UA 는 분류 상수만 남는다 — 원문이 축에 실리지 않는다", () => {
  const raw = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36";
  const axes = clientAxes(req({ "user-agent": raw }));
  assert.equal(axes.ua_class, "browser");
  for (const v of Object.values(axes)) assert.notEqual(v, raw);
});

test("Referer 는 호스트만 — 경로·쿼리는 남의 검색어가 섞여 온다", () => {
  assert.equal(refererHost("https://search.example.com/find?q=%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4"),
    "search.example.com");
  assert.equal(refererHost("https://x.test:8443/a/b"), "x.test:8443");
});

test("깨진 Referer 는 버린다 — 원문을 대신 남기지 않는다", () => {
  assert.equal(refererHost("not a url"), null);
  assert.equal(refererHost(""), null);
  assert.equal(refererHost(null), null);
});

test("request.cf 가 없으면 country·asn 은 NULL — 지어내지 않는다", () => {
  const axes = clientAxes(req({ "user-agent": "curl/8.4.0" }));
  assert.equal(axes.country, null);
  assert.equal(axes.asn, null);
  assert.equal(axes.ua_class, "cli");
});

test("asn 은 숫자로 오지만 TEXT 컬럼이라 문자열로 맞춘다", () => {
  const axes = clientAxes(req({}, { country: "KR", asn: 4766 }));
  assert.equal(axes.country, "KR");
  assert.equal(axes.asn, "4766");
});

// ── agent_verified (#111) ────────────────────────────────────────────────────
// `cf.verifiedBotCategory` 는 **Cloudflare 가 확인한 값**이라 UA 자기 신고와 층위가 다르다.
// prod 실측(2026-08-06, wrangler tail)에서 이 필드가 실제로 온다는 것을 확인했다 —
// curl 요청이라 값은 `""` 였다. `botManagement`(score·ja3)는 이 플랜에 없다.
test("검증 대상이 아니면 NULL — AI 에이전트가 아닌 클라이언트는 검증할 것이 없다", () => {
  assert.equal(agentVerified(null, ""), null);
  assert.equal(agentVerified(null, "Search Engine Crawler"), null);
});

test("자칭 AI 인데 CF 가 확인 못 하면 0 — 이건 진짜 '검증 실패'다", () => {
  assert.equal(agentVerified("anthropic", ""), 0);
  assert.equal(agentVerified("anthropic", "   "), 0);
});

test("CF 가 카테고리를 주면 1", () => {
  assert.equal(agentVerified("anthropic", "AI Crawler"), 1);
  assert.equal(agentVerified("openai", "Search Engine Crawler"), 1);
});

// ── MCP clientInfo (#111 후속) ───────────────────────────────────────────────
// UA 로는 MCP 클라이언트를 못 잡는다(공개 UA 규약이 없다). 프로토콜이 규격으로 주는
// 이름을 쓰되, `normalizeIntent` 와 같은 3분기를 지킨다.
test("안 보냄은 NULL — 못 알아봄(other)과 다르다", () => {
  assert.equal(normalizeMcpClient(null), null);
  assert.equal(normalizeMcpClient(undefined), null);
  assert.equal(normalizeMcpClient(""), null);
  assert.equal(normalizeMcpClient("   "), null);
});

test("모양이 맞으면 소문자 정규화해서 그대로", () => {
  assert.equal(normalizeMcpClient("claude-ai"), "claude-ai");
  assert.equal(normalizeMcpClient("Cursor"), "cursor");
  assert.equal(normalizeMcpClient("mcp-remote"), "mcp-remote");
  assert.equal(normalizeMcpClient("ExampleClient"), "exampleclient");
});

test("공백은 하이픈으로 접는다 — 띄어 쓰는 구현이 흔하고, 버리면 이름을 잃는다", () => {
  assert.equal(normalizeMcpClient("Example Client"), "example-client");
  assert.equal(normalizeMcpClient("Visual  Studio   Code"), "visual-studio-code");
});

test("모양이 아니면 other — 자유 문자열을 로그에 그대로 싣지 않는다", () => {
  assert.equal(normalizeMcpClient("사용자 질문: 강남구 인구는?"), "other");
  assert.equal(normalizeMcpClient("a".repeat(41)), "other");     // 40자 상한
  assert.equal(normalizeMcpClient("-leading-hyphen"), "other");  // 첫 글자는 영숫자
  assert.equal(normalizeMcpClient("has/slash"), "other");
});

test("40자 경계는 통과한다", () => {
  assert.equal(normalizeMcpClient("a".repeat(40)), "a".repeat(40));
});

// 🔴 이게 이 축의 핵심이다. `""`(CF 가 봤고 아니라고 했다) 와 필드 부재(못 물어봤다)는
// 다른 사실이다. 후자를 0 으로 적으면 "모른다"가 "검증 실패"로 굳는다(§4-3 · #78 F-3).
test("cf 가 필드를 안 주면 NULL — 모른다를 검증 실패로 만들지 않는다", () => {
  assert.equal(agentVerified("anthropic", undefined), null);
  assert.equal(agentVerified("anthropic", null), null);
});

test("clientAxes 가 agent_verified 를 싣는다 — 세 결과가 각각 나온다", () => {
  const ai = clientAxes(req({ "user-agent": "ClaudeBot/1.0" }, { verifiedBotCategory: "AI Crawler" }));
  assert.equal(ai.agent_name, "anthropic");
  assert.equal(ai.agent_verified, 1);

  const spoofed = clientAxes(req({ "user-agent": "ClaudeBot/1.0" }, { verifiedBotCategory: "" }));
  assert.equal(spoofed.agent_verified, 0);

  // 브라우저는 CF 가 카테고리를 줘도 검증 대상이 아니다 — agent_name 이 없으면 NULL.
  const human = clientAxes(req({ "user-agent": "Mozilla/5.0 (Windows NT 10.0)" }, { verifiedBotCategory: "" }));
  assert.equal(human.agent_name, null);
  assert.equal(human.agent_verified, null);
});

test("intent — 슬러그는 그대로, 자유 문장은 other, 없으면 NULL", () => {
  assert.equal(normalizeIntent("dong_activity_rank"), "dong_activity_rank");
  // 문장을 그대로 실으면 질문 원문이 로그에 남는다(§3-6) — 그래서 뭉갠다.
  assert.equal(normalizeIntent("강남구 문화행사 뭐 있어?"), "other");
  assert.equal(normalizeIntent("A".repeat(65)), "other");
  assert.equal(normalizeIntent("  "), null);
  assert.equal(normalizeIntent(undefined), null);
});

test("안 보낸 것과 못 알아본 것은 다르다 — NULL 과 other 를 섞지 않는다", () => {
  assert.notEqual(normalizeIntent(""), normalizeIntent("!!!"));
});

// #112 — 위 원칙을 ua_class 에도 적용한다. 40줄 거리에서 두 축이 다른 규칙을 쓰고 있었다.
test("ua_class 도 안 보낸 것과 못 알아본 것을 가른다 — no_ua ≠ unknown", () => {
  assert.notEqual(classifyClient(null).ua_class, classifyClient("WeirdClient/0.1").ua_class);
  assert.equal(classifyClient(null).ua_class, "no_ua");
  assert.equal(classifyClient("WeirdClient/0.1").ua_class, "unknown");
});

// NULL 이 아니라 **값**이어야 하는 이유 — 콘솔이 `ua_class IS NULL` 로 "게이트웨이가 아직
// 이 축을 안 싣는다"(axes_unfilled)를 판정한다. NULL 로 두면 UA 없는 요청 하나가
// "축 미배선"으로 읽혀 카드가 통째로 '미발행'을 말한다.
test("no_ua 는 NULL 이 아니라 값이다 — 콘솔의 미배선 판정과 섞이지 않게", () => {
  assert.equal(typeof classifyClient(null).ua_class, "string");
  assert.notEqual(classifyClient(null).ua_class, null);
});
