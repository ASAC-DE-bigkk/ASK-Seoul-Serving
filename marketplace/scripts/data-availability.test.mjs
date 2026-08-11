import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { evaluateCurrentProductAvailability } from "../src/product-availability.js";

const TEST_API_KEY = `ask_${"0".repeat(32)}`;
const PRODUCT_ID = "weather_place_precipitation_window";
const PUBLICATION_ID = "weather-publication-1";

const declaredEmptyResult = {
  schema_version: "mcp-product-projection/v1",
  empty_result: {
    state: "valid_empty",
    code: "no_upcoming_precipitation_forecast",
    message_ko: "현재 수집된 유효 단기예보에는 향후 강수(비·눈) 구간이 없습니다.",
  },
};

const declaredCurrentness = {
  schema_version: "mcp-product-projection/v1",
  currentness: {
    field: "forecast_at",
    minimum: "current_kst_hour",
  },
};

function fixtureDb({
  rowCount = 0,
  mcpProjection = JSON.stringify(declaredEmptyResult),
  productId = PRODUCT_ID,
  tableName = "gold_weather_place_precipitation_window",
  currentnessAsOf = null,
  quality = {
    source_row_count: 80,
    d1_row_count: 0,
    duplicate_primary_key_count: 0,
    null_primary_key_count: 0,
    freshness_as_of: new Date().toISOString(),
    freshness_slo_minutes: 240,
    serving_status: "published",
    measured_at: new Date().toISOString(),
    publication_id: PUBLICATION_ID,
  },
  dataRows = [],
} = {}) {
  let usageWrites = 0;

  const catalog = {
    name: tableName,
    product_id: productId,
    external: 1,
    serving_status: "published",
    publication_id: PUBLICATION_ID,
    exported_at: "2026-08-11T00:00:00+09:00",
    row_count: rowCount,
    freshness: "2026-08-11T00:00:00+09:00",
    time_axis: "window_start_at",
    mcp_projection: mcpProjection,
    columns: JSON.stringify([
      { name: "place_id", type: "TEXT" },
      { name: "window_start_at", type: "TEXT" },
    ]),
  };

  return {
    prepare(sql) {
      return {
        bind(..._params) {
          return {
            async first() {
              if (sql.includes("FROM _keys")) {
                return {
                  key_hash: "availability-test-key",
                  key_prefix: "ask_0000",
                  email: "availability@example.test",
                  key_type: "user",
                  status: "active",
                  daily_quota: 1000,
                };
              }
              if (sql.includes("SELECT count FROM _burst")) return { count: 1 };
              if (sql.includes("FROM _catalog")) return catalog;
              if (sql.includes("FROM d1_product_quality")) return quality;
              if (sql.includes("AS currentness_as_of")) {
                return currentnessAsOf === null ? null : { currentness_as_of: currentnessAsOf };
              }
              if (sql.includes("SELECT count FROM _usage")) return { count: usageWrites };
              return null;
            },
            async all() {
              if (sql.includes("FROM d1_catalog_sources")) {
                return { results: [{ source_id: "kma", redistribution: "allowed_with_attribution" }] };
              }
              if (sql.includes("SELECT rowid AS _rid")) return { results: dataRows };
              if (sql.includes("SELECT * FROM \"gold_weather_place_precipitation_window\"")) {
                return { results: dataRows };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO _usage")) usageWrites += 1;
              return {};
            },
          };
        },
        async all() {
          if (sql.includes("SELECT * FROM \"gold_weather_place_precipitation_window\"")) {
            return { results: dataRows };
          }
          return { results: [] };
        },
      };
    },
    stats: {
      get usageWrites() { return usageWrites; },
    },
  };
}

async function fetchWorker(path, db, { method = "GET", body } = {}) {
  const pending = [];
  const headers = { authorization: `Bearer ${TEST_API_KEY}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await worker.fetch(
    new Request(`https://marketplace.example.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: db, ASK_ENV: "dev" },
    { waitUntil: (promise) => pending.push(promise) },
  );
  await Promise.all(pending);
  return response;
}

test("fresh zero-row precipitation catalog returns valid_empty without consuming daily quota", async () => {
  const db = fixtureDb();
  const response = await fetchWorker(`/api/v1/data/${PRODUCT_ID}`, db);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.rows, []);
  assert.equal(body.row_count, 0);
  assert.deepEqual(body.availability, declaredEmptyResult.empty_result);
  assert.equal(body.quota_charged, false);
  assert.equal(db.stats.usageWrites, 0);
});

test("preview and MCP query preserve the same valid_empty availability", async () => {
  const previewDb = fixtureDb();
  const preview = await fetchWorker(`/api/v1/preview/${PRODUCT_ID}`, previewDb);
  const previewBody = await preview.json();

  assert.equal(preview.status, 200);
  assert.deepEqual(previewBody.availability, declaredEmptyResult.empty_result);
  assert.equal(previewDb.stats.usageWrites, 0);

  const mcpDb = fixtureDb();
  const mcp = await fetchWorker("/mcp", mcpDb, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query_product", arguments: { product_id: PRODUCT_ID } },
    },
  });
  const mcpBody = await mcp.json();
  const result = JSON.parse(mcpBody.result.content[0].text);

  assert.deepEqual(result.availability, declaredEmptyResult.empty_result);
  assert.equal(mcpDb.stats.usageWrites, 0);
});

test("zero-row catalog fails closed when the empty-result declaration is missing or malformed", async () => {
  for (const mcpProjection of [null, "{not-json}", JSON.stringify({ empty_result: { state: "valid_empty" } })]) {
    const db = fixtureDb({ mcpProjection });
    const response = await fetchWorker(`/api/v1/data/${PRODUCT_ID}`, db);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "product_not_ready");
    assert.equal(db.stats.usageWrites, 0);
  }
});

test("zero-row catalog fails closed when quality is stale, missing, or from another publication", async () => {
  const scenarios = [
    {
      quality: {
        source_row_count: 80,
        d1_row_count: 0,
        duplicate_primary_key_count: 0,
        null_primary_key_count: 0,
        freshness_as_of: new Date(Date.now() - 241 * 60_000).toISOString(),
        freshness_slo_minutes: 240,
        serving_status: "published",
        measured_at: new Date().toISOString(),
        publication_id: PUBLICATION_ID,
      },
      blocker: "quality_freshness_stale",
    },
    { quality: null, blocker: "quality_metadata_contract_unavailable" },
    {
      quality: {
        source_row_count: 80,
        d1_row_count: 0,
        duplicate_primary_key_count: 0,
        null_primary_key_count: 0,
        freshness_as_of: new Date().toISOString(),
        freshness_slo_minutes: 240,
        serving_status: "published",
        measured_at: new Date().toISOString(),
        publication_id: "previous-publication",
      },
      blocker: "quality_publication_mismatch",
    },
  ];

  for (const { quality, blocker } of scenarios) {
    const db = fixtureDb({ quality });
    const response = await fetchWorker(`/api/v1/data/${PRODUCT_ID}`, db);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "product_not_ready");
    assert.ok(body.blockers.includes(blocker));
    assert.equal(db.stats.usageWrites, 0);
  }
});

test("an empty filtered page from a nonempty product is not labeled valid_empty", async () => {
  const db = fixtureDb({ rowCount: 2 });
  const response = await fetchWorker(`/api/v1/data/${PRODUCT_ID}?place_id=missing`, db);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.rows, []);
  assert.equal("availability" in body, false);
  assert.equal(db.stats.usageWrites, 1);
});

test("current outlook fails closed across the 10:59 build to 11:01 publication boundary", () => {
  const catalog = {
    row_count: 1,
    name: "gold_weather_place_current_outlook",
    mcp_projection: JSON.stringify(declaredCurrentness),
  };
  const publishedAt = Date.parse("2026-08-11T02:01:00Z"); // 11:01 KST

  assert.deepEqual(
    evaluateCurrentProductAvailability(catalog, "2026-08-11T10:00:00+09:00", publishedAt),
    { availability: null, blockers: ["quality_snapshot_not_current"] },
  );
  assert.deepEqual(
    evaluateCurrentProductAvailability(catalog, "2026-08-11T11:00:00+09:00", publishedAt),
    { availability: null, blockers: [] },
  );
});

test("stale current outlook is not served or charged", async () => {
  const db = fixtureDb({
    rowCount: 1,
    productId: "weather_place_current_outlook",
    tableName: "gold_weather_place_current_outlook",
    mcpProjection: JSON.stringify(declaredCurrentness),
    currentnessAsOf: new Date(Date.now() - 61 * 60_000).toISOString(),
    dataRows: [{ place_id: "place-1", forecast_at: new Date().toISOString() }],
  });
  const response = await fetchWorker("/api/v1/data/weather_place_current_outlook", db);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "product_not_ready");
  assert.ok(body.blockers.includes("quality_snapshot_not_current"), JSON.stringify(body));
  assert.equal(db.stats.usageWrites, 0);
});
