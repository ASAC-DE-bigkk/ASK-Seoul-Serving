/**
 * `POST /api/v1/chat` — **문**을 고정한다 (#159 · decision/0006).
 *
 * 루프는 `chat.test.mjs` 가 이미 덮는다. 여기서 지키는 것은 문 쪽 계약이고 전부
 * 라우터에만 있다.
 *
 *   ① 무인증 상한 두 층 — 총량 100·IP 몫 5. **몫이 다 차면 429 가 아니라 강등**이다
 *   ② 키 사용자 — 채팅 1건이 기존 쿼터에서 1 을 쓴다 · 틀린 키는 익명 취급이 아니라 401
 *   ③ env.AI 없으면 후보 제시로 내려앉는다 (지금 배포 상태 — 바인딩은 별도 PR)
 *   ④ env.AI 있으면 채택 모델로 부른다 — 전 구간(문→루프→핸들러) 관통
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { LOG_COLUMNS } from "../src/index.js";
import { CHAT_MODEL } from "../src/chat.js";

const TEST_API_KEY = `ask_${"0".repeat(32)}`;
const RIGHTS_OK = [{ source_id: "seoul_open_data", redistribution: "allowed_with_attribution" }];

const PATTERN_ROW = {
  product_id: "p", pattern_id: "free_in_gu", question_ko: "강남구 무료 행사",
  axes: null, sql: "SELECT gu FROM t WHERE gu = :gu", requires: null,
  verified_rows: 10, verified_at: "2026-08-05", allow_empty: 0, insight_sample_ko: "예시",
};

/** 문이 지나는 표 전부를 흉내낸다 — 키·버스트(분/일)·쿼터·카탈로그·패턴·권리·로그.
 *  ⚠️ 카탈로그 목록은 `bind()` 없이 `.all()` 을 바로 부른다 — 응답기를 bind 안에만 두면
 *  거기서 TypeError 가 난다. 같은 응답기를 bind 유무 양쪽에 단다. */
function fixtureDb(seen = {}, opts = {}) {
  return {
    prepare(sql) {
      const stmt = (binds) => ({
            async first() {
              if (sql.includes("FROM _keys"))
                return opts.noKey ? null
                  : { key_hash: "h", key_prefix: "ask_0000", email: "t@e.st",
                      status: "active", daily_quota: 1000 };
              if (sql.includes("_service_keys")) return null;
              if (sql.includes("d1_usage_patterns")) return PATTERN_ROW;   // run_pattern 단건
              if (sql.includes("_catalog"))                                 // 실행 게이트(단건)
                return { name: "t", product_id: "p", publication_id: "pub1", exported_at: "s1" };
              if (sql.includes("_usage")) return { count: opts.quotaUsed ?? 1 };
              if (sql.includes("_burst")) {
                const b = String(binds[0] ?? "");
                if (b === "chatd:total") return { count: opts.totalUsed ?? 1 };
                if (b.startsWith("chatd:")) return { count: opts.ipUsed ?? 1 };
                return { count: 1 };
              }
              return null;
            },
            async all() {
              if (sql.includes("d1_catalog_sources")) return { results: RIGHTS_OK };
              if (sql.includes("d1_usage_patterns")) return { results: [PATTERN_ROW] };
              if (sql.includes("_catalog"))                                 // 카탈로그 목록
                return { results: [{ name: "t", product_id: "p", external: 1, description: "d",
                  product_question: "q", time_axis: "event_at",
                  columns: '[{"name":"gu","type":"varchar"}]',   // 실물은 JSON 문자열이다 — null 이면 buildCatalog 가 죽는다
                  row_count: 10, freshness: "f", publication_id: "pub1", exported_at: "s1" }] };
              if (sql.includes("d1_catalog_columns") || sql.includes("d1_catalog_display") ||
                  sql.includes("d1_catalog_ext")) return { results: [] };
              seen.dataSql = sql; seen.dataBinds = binds;
              return { results: [{ gu: "강남구" }] };
            },
            async run() {
              // 🔴 표 이름만 보면 안 된다 — `logRequest` 는 INSERT 말고 **낡은 행 청소
              //    DELETE 도 같은 표에** 쏜다(`Math.random() < 0.02`). 표 이름으로만
              //    잡으면 2% 확률로 청소의 바인딩(`[cutoff]` 한 개)이 INSERT 의 21개를
              //    덮어써, `logBinds[1]` 이 undefined 가 된다 — 같은 커밋인데 CI 가
              //    갈리는 간헐 실패의 정체였다(@kang-gyeongmin 제보, 2026-08-10).
              //    바로 아래 두 줄과 patterns-route.test.mjs 는 처음부터 INSERT 로
              //    좁혀 놨다. 이 줄만 빠져 있었다.
              if (sql.includes("INSERT INTO _gateway_request_log")) seen.logBinds = binds;
              if (sql.includes("INSERT INTO _usage")) seen.usageCharges = (seen.usageCharges || 0) + 1;
              if (sql.includes("INSERT INTO _burst")) (seen.burstBuckets ??= []).push(String(binds[0]));
              return {};
            },
      });
      return { bind: (...binds) => stmt(binds), ...stmt([]) };
    },
  };
}

async function call(body, { key, env: extraEnv, opts } = {}, seen = {}) {
  const pending = [];
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await worker.fetch(
    new Request("https://marketplace.example.test/api/v1/chat", {
      method: "POST", headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { DB: fixtureDb(seen, opts ?? {}), ASK_ENV: "dev", ...extraEnv },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

/** 대본형 가짜 Workers AI — 부른 모델명을 기록한다. */
function fakeAI(...turns) {
  let i = 0;
  const ai = { models: [], payloads: [] };
  ai.run = async (model, payload) => {
    ai.models.push(model); ai.payloads.push(payload);
    return turns[Math.min(i++, turns.length - 1)];
  };
  return ai;
}

// ── ③ 지금 배포 상태 — AI 미연결 ────────────────────────────────────────────────

test("③ env.AI 없음 — 죽지 않고 후보 제시로 내려앉으며, 그렇게 말한다", async () => {
  const res = await call({ product_id: "p", question: "강남구 무료 행사 알려줘" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.degraded, true);
  assert.equal(body.reason, "ai_unavailable");
  assert.match(body.message, /아직 연결되지 않았습니다/);
  assert.equal(body.candidates[0].pattern_id, "free_in_gu");
});

// ── ① 무인증 상한 ──────────────────────────────────────────────────────────────

test("① 무인증도 문을 지난다 — 하루 버킷 두 개(IP 몫·총량)가 실제로 세어진다", async () => {
  const seen = {};
  await call({ product_id: "p", question: "q" }, {}, seen);
  const daily = seen.burstBuckets.filter((b) => b.startsWith("chatd:"));
  assert.equal(daily.length, 2, "IP 몫과 총량이 각각 세어져야 한다");
  assert.ok(daily.includes("chatd:total"));
  const ipBucket = daily.find((b) => b !== "chatd:total");
  assert.doesNotMatch(ipBucket, /\d+\.\d+\.\d+\.\d+/, "원문 IP 가 하루짜리 버킷에 남으면 안 된다");
});

test("🔴 ① 총량 소진 — 429 가 아니라 강등이고, 로그인 안내를 말한다", async () => {
  const res = await call({ product_id: "p", question: "무료 행사" }, { opts: { totalUsed: 101 } });
  assert.equal(res.status, 200, "몫이 다 찼다고 채팅이 죽으면 안 된다(0006)");
  const body = await res.json();
  assert.equal(body.reason, "anon_quota_exhausted");
  assert.match(body.message, /로그인하시면/);
  assert.ok(Array.isArray(body.candidates), "LLM 없이도 후보는 준다");
});

test("① IP 몫 소진 — 총량이 남아 있어도 같은 강등이다 (한 명이 다 쓰지 못하게)", async () => {
  const res = await call({ product_id: "p", question: "무료 행사" }, { opts: { ipUsed: 6 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, "anon_quota_exhausted");
});

// ── ② 키 사용자 ────────────────────────────────────────────────────────────────

test("② 키 사용자 — 채팅 1건이 기존 쿼터에서 1 을 쓴다", async () => {
  const seen = {};
  await call({ product_id: "p", question: "q" }, { key: TEST_API_KEY }, seen);
  assert.equal(seen.usageCharges, 1, "질문 자체가 LLM 비용이므로 유효한 서빙이다");
  assert.ok(seen.burstBuckets.some((b) => b.startsWith("k:")), "키 버킷 버스트가 앞에 선다");
  assert.ok(!seen.burstBuckets.some((b) => b.startsWith("chatd:")),
    "키 사용자는 맛보기 몫을 먹지 않는다 — 익명 20명의 몫이 줄어든다");
});

test("② 키 쿼터 소진 — 429 + Retry-After (맛보기 강등이 아니라 자기 한도의 문제다)", async () => {
  const res = await call({ product_id: "p", question: "q" },
    { key: TEST_API_KEY, opts: { quotaUsed: 1001 } });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
});

test("🔴 ② 틀린 키는 401 이다 — 조용히 익명 취급하면 키가 죽은 걸 모른다", async () => {
  const res = await call({ product_id: "p", question: "q" },
    { key: TEST_API_KEY, opts: { noKey: true } });
  assert.equal(res.status, 401);
});

// ── 입력 검증 ──────────────────────────────────────────────────────────────────

test("본문이 JSON 이 아니면 400 — 무엇이 필요한지 말한다", async () => {
  const res = await call("not-json{");
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /product_id, question/);
});

test("필수 조각이 빠지면 400", async () => {
  for (const bad of [{}, { product_id: "p" }, { question: "q" }])
    assert.equal((await call(bad)).status, 400);
});

test("질문 500자 상한 — LLM 비용은 넣는 길이로도 자란다", async () => {
  const res = await call({ product_id: "p", question: "가".repeat(501) });
  assert.equal(res.status, 400);
});

test("없는 제품은 404 — 카탈로그로 안내한다", async () => {
  const res = await call({ product_id: "nope", question: "q" });
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /catalog/);
});

// ── ④ AI 연결 시 전 구간 ───────────────────────────────────────────────────────

test("④ env.AI 가 있으면 채택 모델로 부르고, 패턴 실행까지 관통한다", async () => {
  const ai = fakeAI(
    { tool_calls: [{ id: "c1", function: { name: "run_pattern",
        arguments: JSON.stringify({ product_id: "p", pattern_id: "free_in_gu", params: { gu: "강남구" } }) } }] },
    { response: "강남구 무료 행사는 1건입니다." },
  );
  const seen = {};
  const res = await call({ product_id: "p", question: "강남구 무료 행사?" },
    { env: { AI: ai } }, seen);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answer, "강남구 무료 행사는 1건입니다.");
  assert.deepEqual(body.steps.map((s) => s.name), ["run_pattern"]);
  assert.equal(ai.models[0], CHAT_MODEL, "결정 문서의 채택 모델과 다른 모델을 부르면 안 된다");
  assert.equal(seen.dataBinds?.[0], "강남구", "패턴 SQL 이 실제로 바인딩돼 돌았다");
});

// ── 관측 ──────────────────────────────────────────────────────────────────────

test("route 값은 'chat' 으로 남는다 — MCP 값에 섞지 않는다(0006 관측 절)", async () => {
  const seen = {};
  await call({ product_id: "p", question: "q" }, {}, seen);
  assert.ok(seen.logBinds, "요청 로그가 안 남았다");
  // 잡은 게 정말 로그 INSERT 인지 먼저 못 박는다 — 아니면 다음 사람도 `undefined` 하나만
  // 보고 "로깅이 안 됐다"로 읽는다(실제로 그렇게 읽혔다). 길이가 어긋나면 그렇게 말한다.
  assert.equal(seen.logBinds.length, LOG_COLUMNS.length,
    "로그 INSERT 가 아닌 문을 잡았다 — 픽스처가 같은 표의 다른 문까지 삼키고 있다");
  assert.equal(seen.logBinds[1], "chat");   // LOG_COLUMNS 순서: ts, route, …
});
