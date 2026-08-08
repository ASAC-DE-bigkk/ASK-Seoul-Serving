import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.js";
import {
  SKILL_BUNDLE_ID,
  SKILL_PRODUCT_IDS,
  freshnessAsOfMillis,
  freshnessState,
  handleSkillBundle,
  handleSkillData,
  handleSkillProduct,
} from "../src/skill.js";

const EXPECTED_PRODUCTS = [
  "weather_place_risk_window",
];

const OTHER_PUBLIC_PRODUCT = "culture_event_schedule";
const TEST_API_KEY = `ask_${"0".repeat(32)}`;
const SERVICE_API_KEY = `ask_${"1".repeat(32)}`;
const SERVICE_SCOPE = "skill:seoul-weather-risk:read";

const userKeyRow = {
  key_hash: "test-key-hash",
  key_prefix: "ask_0000",
  email: "skill-test@example.test",
  key_type: "user",
  service_name: null,
  scopes_json: null,
  status: "active",
  daily_quota: 1000,
};

function fixtureDb({
  metadataPublicationId = "active-publication",
  sourcePublicationId = "active-publication",
  qualityPublicationId = "active-publication",
  evidence = false,
  freshnessAsOf = new Date().toISOString(),
  freshnessSloMinutes = 240,
  measuredAt = new Date().toISOString(),
  coverage = {
    field: "admin_dong_code",
    expected_distinct_count: 427,
    observed_distinct_count: 427,
    minimum_ratio: 1,
    ratio: 1,
    status: "passed",
  },
  keyRow = userKeyRow,
} = {}) {
  let usage = 0;
  let burstWrites = 0;
  let usageWrites = 0;
  const catalog = new Map([...EXPECTED_PRODUCTS, OTHER_PUBLIC_PRODUCT].map((productId) => [productId, {
    name: `gold_${productId}`,
    product_id: productId,
    external: 1,
    serving_status: "published",
    publication_id: "active-publication",
    row_count: 427,
    freshness: freshnessAsOf,
    time_axis: "observed_at",
    columns: JSON.stringify([
      { name: "admin_dong_code", type: "TEXT" },
      { name: "observed_at", type: "TEXT" },
    ]),
    description: "fixture product",
    product_question: "fixture question",
  }]));

  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...bound) {
          params = bound;
          return this;
        },
        async first() {
          if (sql.includes("FROM _keys WHERE key_hash")) {
            return keyRow.key_type === "user" ? keyRow : null;
          }
          if (sql.includes("FROM _service_keys WHERE key_hash")) {
            return keyRow.key_type === "service" ? keyRow : null;
          }
          if (sql.includes("SELECT count FROM _burst")) return { count: 1 };
          if (sql.includes("FROM _catalog")) return catalog.get(params[0]) ?? null;
          if (sql.includes("FROM d1_catalog_ext")) {
            return {
              grain: "행정동×시각",
              primary_key: '["admin_dong_code","observed_at"]',
              time_axis: "observed_at",
              publication_id: metadataPublicationId,
            };
          }
          if (sql.includes("FROM d1_product_quality") && evidence) {
            return {
              product_id: params[0],
              source_row_count: 427,
              d1_row_count: 427,
              duplicate_primary_key_count: 0,
              null_primary_key_count: 0,
              freshness_as_of: freshnessAsOf,
              freshness_slo_minutes: freshnessSloMinutes,
              serving_status: "published",
              measured_at: measuredAt,
              projection_schema_version: "1.1.0",
              projection_schema_hash: "evidence-fixture-projection-hash",
              coverage_json: JSON.stringify(coverage),
              publication_id: qualityPublicationId,
            };
          }
          if (sql.includes("SELECT count FROM _usage")) return usage ? { count: usage } : null;
          return null;
        },
        async all() {
          if (sql.includes("FROM d1_catalog_columns")) {
            return {
              results: [
                { ordinal: 0, column_name: "admin_dong_code", type: "TEXT", description_ko: "행정동 코드", publication_id: metadataPublicationId },
                { ordinal: 1, column_name: "observed_at", type: "TEXT", description_ko: "관측 시각", publication_id: metadataPublicationId },
              ],
            };
          }
          if (sql.includes("FROM d1_catalog_sources")) {
            if (!evidence) throw new Error("evidence table is not published");
            return {
              results: [{
                source_id: "kma_vilage_fcst",
                source_url: "https://example.test/kma",
                license: "KOGL-1",
                license_url: "https://example.test/kogl",
                redistribution: "allowed_with_attribution",
                attribution: "기상청",
                rights_checked_at: "2026-08-04",
                publication_id: sourcePublicationId,
              }],
            };
          }
          if (sql.includes("SELECT rowid AS \"_rid\"") || sql.includes("SELECT rowid AS _rid")) {
            return {
              results: [
                { _rid: 7, admin_dong_code: "1111051500", observed_at: "2026-08-03T00:00:00+09:00" },
                { _rid: 8, admin_dong_code: "1111053000", observed_at: "2026-08-03T00:00:00+09:00" },
              ],
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO _usage")) {
            usage += 1;
            usageWrites += 1;
          }
          if (sql.includes("INSERT INTO _burst")) burstWrites += 1;
          return {};
        },
      };
    },
    stats: {
      get burstWrites() { return burstWrites; },
      get usageWrites() { return usageWrites; },
    },
  };
}

async function fetchWorker(path, db, apiKey = TEST_API_KEY, method = "GET") {
  const pending = [];
  const response = await worker.fetch(
    new Request(`https://marketplace.example.test${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    { DB: db, ASK_ENV: "dev" },
    { waitUntil(promise) { pending.push(promise); } },
  );
  await Promise.all(pending);
  return response;
}

test("scoped K-Skill proxy service key is limited to its declared skill read scope", async () => {
  const scopedServiceKey = {
    ...userKeyRow,
    key_hash: "service-key-hash",
    key_prefix: "ask_1111",
    email: null,
    key_type: "service",
    service_name: "k-skill-proxy:seoul-weather-risk",
    scopes_json: JSON.stringify([SERVICE_SCOPE]),
  };
  const db = fixtureDb({ evidence: true, keyRow: scopedServiceKey });

  const skillResponse = await fetchWorker(
    "/skill/v1/products/weather_place_risk_window/data?limit=1",
    db,
    SERVICE_API_KEY,
  );
  assert.equal(skillResponse.status, 200);

  const marketplaceResponse = await fetchWorker("/api/v1/me", db, SERVICE_API_KEY);
  const marketplaceBody = await marketplaceResponse.json();
  assert.equal(marketplaceResponse.status, 403);
  assert.equal(marketplaceBody.code, "service_key_scope_required");
});

test("service key with a missing K-Skill scope is rejected before burst or quota accounting", async () => {
  const db = fixtureDb({
    evidence: true,
    keyRow: {
      ...userKeyRow,
      key_hash: "service-key-hash",
      email: null,
      key_type: "service",
      service_name: "k-skill-proxy:seoul-weather-risk",
      scopes_json: "[]",
    },
  });

  const response = await fetchWorker(
    "/skill/v1/bundles/seoul-weather-risk",
    db,
    SERVICE_API_KEY,
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "insufficient_scope");
  assert.equal(body.required_scope, SERVICE_SCOPE);
  assert.equal(db.stats.burstWrites, 0);
  assert.equal(db.stats.usageWrites, 0);
});

test("revoked K-Skill proxy service key is rejected immediately", async () => {
  const db = fixtureDb({
    keyRow: {
      ...userKeyRow,
      key_hash: "service-key-hash",
      email: null,
      key_type: "service",
      service_name: "k-skill-proxy:seoul-weather-risk",
      scopes_json: JSON.stringify([SERVICE_SCOPE]),
      status: "revoked",
    },
  });

  const response = await fetchWorker(
    "/skill/v1/bundles/seoul-weather-risk",
    db,
    SERVICE_API_KEY,
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "revoked_service_key");

  const revokeRouteResponse = await fetchWorker(
    "/api/v1/keys",
    db,
    SERVICE_API_KEY,
    "DELETE",
  );
  assert.equal(revokeRouteResponse.status, 403);
  assert.equal((await revokeRouteResponse.json()).code, "revoked_service_key");
});

test("skill bundle preserves the exact single-product allowlist and exposes blocked readiness", async () => {
  const response = await handleSkillBundle({ DB: fixtureDb() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bundle_id, "seoul-weather-risk");
  assert.equal(SKILL_BUNDLE_ID, "seoul-weather-risk");
  assert.deepEqual(SKILL_PRODUCT_IDS, EXPECTED_PRODUCTS);
  assert.deepEqual(body.products.map((product) => product.product_id), EXPECTED_PRODUCTS);
  assert.equal(body.registration_ready, false);
  assert.ok(body.products.every((product) => product.registration_ready === false));
  assert.ok(body.products.every((product) =>
    product.blockers.includes("source_rights_metadata_contract_unavailable")));
});

test("skill OpenAPI product enum stays identical to the server single-product allowlist", async () => {
  const openapi = JSON.parse(await readFile(
    new URL("../public/skill-openapi.json", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(openapi.components.parameters.ProductId.schema.enum, SKILL_PRODUCT_IDS);
});

test("the shared key can read another Marketplace product but skill routes reject it", async () => {
  const db = fixtureDb({ evidence: true });

  const marketplaceResponse = await fetchWorker(
    `/api/v1/data/${OTHER_PUBLIC_PRODUCT}?limit=1`,
    db,
  );
  const marketplaceBody = await marketplaceResponse.json();
  assert.equal(marketplaceResponse.status, 200);
  assert.equal(marketplaceBody.product_id, OTHER_PUBLIC_PRODUCT);
  assert.equal(marketplaceBody.row_count, 1);

  for (const suffix of ["", "/data"]) {
    const skillResponse = await fetchWorker(
      `/skill/v1/products/${OTHER_PUBLIC_PRODUCT}${suffix}`,
      db,
    );
    const skillBody = await skillResponse.json();

    assert.equal(skillResponse.status, 404);
    assert.equal(skillBody.code, "unknown_product");
    assert.equal(skillBody.product_id, OTHER_PUBLIC_PRODUCT);
    assert.match(skillBody.request_id, /^req_[0-9a-f]{16}$/);
  }

  const usageResponse = await fetchWorker("/api/v1/me", db);
  const usageBody = await usageResponse.json();
  assert.equal(usageResponse.status, 200);
  assert.equal(usageBody.used_today, 1, "rejected skill requests must not consume daily quota");
});

test("skill product marks a publisher-classified previous metadata publication without treating it as an error", async () => {
  const response = await handleSkillProduct(
    { DB: fixtureDb({ metadataPublicationId: "previous-publication" }) },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.product_id, "weather_place_risk_window");
  assert.equal(body.publication_id, "active-publication");
  assert.equal(body.metadata.publication_id, "previous-publication");
  assert.equal(body.metadata.meta_of, "previous_publication");
  assert.equal(body.registration_ready, false);
});

test("skill data fails closed while required product evidence is unavailable", async () => {
  const response = await handleSkillData(
    { DB: fixtureDb() },
    "weather_place_risk_window",
    new URLSearchParams(),
    { key_hash: "test-key", daily_quota: 1000 },
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "product_not_ready");
  assert.equal(body.product_id, "weather_place_risk_window");
  assert.ok(body.blockers.includes("source_rights_metadata_contract_unavailable"));
});

test("skill product becomes registration-ready only when publication-bound source and quality evidence pass", async () => {
  const response = await handleSkillProduct(
    { DB: fixtureDb({ evidence: true }) },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.registration_ready, true);
  assert.deepEqual(body.blockers, []);
  assert.equal(body.metadata.sources[0].attribution, "기상청");
  assert.equal(body.metadata.quality.coverage.status, "passed");
});

test("freshness parsing applies Seoul time to naive Publisher values and respects the SLO boundary", () => {
  const nowMs = Date.parse("2026-08-04T12:00:00Z"); // 21:00 KST

  assert.equal(
    freshnessAsOfMillis("2026-08-04 20:00:00"),
    Date.parse("2026-08-04T20:00:00+09:00"),
  );
  assert.equal(freshnessState("2026-08-04 20:00:00", 60, nowMs), "fresh");
  assert.equal(freshnessState("2026-08-04 19:59:59", 60, nowMs), "stale");
  assert.equal(freshnessState("2026-08-04", 1260, nowMs), "fresh");
  assert.equal(freshnessState("2026-07", 89280, nowMs), "fresh");
  assert.equal(freshnessState("not-a-timestamp", 60, nowMs), "incomplete");
});

test("skill product blocks complete but wall-clock-stale freshness evidence", async () => {
  const staleAsOf = new Date(Date.now() - 241 * 60_000).toISOString();
  const response = await handleSkillProduct(
    { DB: fixtureDb({ evidence: true, freshnessAsOf: staleAsOf, freshnessSloMinutes: 240 }) },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.registration_ready, false);
  assert.ok(body.blockers.includes("quality_freshness_stale"));
  assert.ok(!body.blockers.includes("quality_freshness_evidence_incomplete"));
});

test("skill product accepts explicit not-applicable coverage with a reason", async () => {
  const response = await handleSkillProduct(
    {
      DB: fixtureDb({
        evidence: true,
        coverage: {
          status: "not_applicable",
          reason: "최근 24시간 유효 관측 지점 집합이 매 게시마다 변동",
        },
      }),
    },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.registration_ready, true);
  assert.deepEqual(body.blockers, []);
  assert.equal(body.metadata.quality.coverage.status, "not_applicable");
});

test("skill product rejects not-applicable coverage without a reason", async () => {
  const response = await handleSkillProduct(
    {
      DB: fixtureDb({
        evidence: true,
        coverage: { status: "not_applicable", reason: "" },
      }),
    },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(body.registration_ready, false);
  assert.ok(body.blockers.includes("quality_coverage_not_passing"));
});

test("skill data serves only declared public columns with a publication-bound cursor after readiness passes", async () => {
  const response = await handleSkillData(
    { DB: fixtureDb({ evidence: true }) },
    "weather_place_risk_window",
    new URLSearchParams("admin_dong_code=1111051500&limit=1"),
    { key_hash: "test-key", daily_quota: 1000 },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.publication_id, "active-publication");
  assert.equal(body.row_count, 1);
  assert.deepEqual(body.rows, [{ admin_dong_code: "1111051500", observed_at: "2026-08-03T00:00:00+09:00" }]);
  assert.equal(body.has_more, true);
  assert.ok(body.next_cursor);
  assert.equal(response.headers.get("x-ratelimit-remaining"), "999");
});

test("skill product stays blocked when even one source evidence row belongs to another publication", async () => {
  const response = await handleSkillProduct(
    { DB: fixtureDb({ evidence: true, sourcePublicationId: "previous-publication" }) },
    "weather_place_risk_window",
  );
  const body = await response.json();

  assert.equal(body.registration_ready, false);
  assert.ok(body.blockers.includes("source_rights_publication_mismatch"));
});

test("skill data rejects a cursor from a prior publication before consuming quota", async () => {
  const staleCursor = btoa(JSON.stringify({ publication_id: "previous-publication", rowid: 7 }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const response = await handleSkillData(
    { DB: fixtureDb({ evidence: true }) },
    "weather_place_risk_window",
    new URLSearchParams(`cursor=${staleCursor}`),
    { key_hash: "test-key", daily_quota: 1000 },
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.publication_id, "active-publication");
});
