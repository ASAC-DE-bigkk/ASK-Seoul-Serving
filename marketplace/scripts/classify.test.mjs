// classifyClient 단독 테스트 (#9 §3) — 실제 UA 문자열 기준. 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClient } from "../src/index.js";

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

  // unknown — 매칭 실패는 지어내지 않는다
  ["", { ua_class: "unknown", agent_name: null, agent_mode: null }],
  [null, { ua_class: "unknown", agent_name: null, agent_mode: null }],
  ["WeirdClient/0.1", { ua_class: "unknown", agent_name: null, agent_mode: null }],
];

for (const [ua, expected] of cases) {
  test(`${JSON.stringify(ua)} → ${expected.ua_class}${expected.agent_name ? "/" + expected.agent_name : ""}`, () => {
    assert.deepEqual(classifyClient(ua), expected);
  });
}
