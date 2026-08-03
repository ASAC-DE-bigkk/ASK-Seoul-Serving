import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_BUNDLE_ID,
  SKILL_PRODUCT_IDS,
  handleSkillBundle,
  handleSkillData,
  handleSkillProduct,
} from "../src/skill.js";

const EXPECTED_PRODUCTS = [
  "weather_place_forecast_change_daily",
  "traffic_incident_x_weather_current_hourly",
  "citydata_purchasing_power_daily",
  "commerce_flow_monthly",
  "culture_activity_by_dong",
  "transit_parking_full_risk",
];

function fixtureDb({ metadataPublicationId = "active-publication" } = {}) {
  const catalog = new Map(EXPECTED_PRODUCTS.map((productId) => [productId, {
    name: `gold_${productId}`,
    product_id: productId,
    external: 1,
    serving_status: "published",
    publication_id: "active-publication",
    freshness: "2026-08-03",
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
          if (sql.includes("FROM _catalog")) return catalog.get(params[0]) ?? null;
          if (sql.includes("FROM d1_catalog_ext")) {
            return {
              grain: "행정동×시각",
              primary_key: '["admin_dong_code","observed_at"]',
              time_axis: "observed_at",
              publication_id: metadataPublicationId,
            };
          }
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
          return { results: [] };
        },
      };
    },
  };
}

test("skill bundle preserves the exact six-product set and exposes blocked readiness", async () => {
  const response = await handleSkillBundle({ DB: fixtureDb() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bundle_id, "seoul-urban-analytics");
  assert.equal(SKILL_BUNDLE_ID, "seoul-urban-analytics");
  assert.deepEqual(SKILL_PRODUCT_IDS, EXPECTED_PRODUCTS);
  assert.deepEqual(body.products.map((product) => product.product_id), EXPECTED_PRODUCTS);
  assert.equal(body.registration_ready, false);
  assert.ok(body.products.every((product) => product.registration_ready === false));
  assert.ok(body.products.every((product) =>
    product.blockers.includes("source_rights_metadata_contract_unavailable")));
});

test("skill product marks a publisher-classified previous metadata publication without treating it as an error", async () => {
  const response = await handleSkillProduct(
    { DB: fixtureDb({ metadataPublicationId: "previous-publication" }) },
    "commerce_flow_monthly",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.product_id, "commerce_flow_monthly");
  assert.equal(body.publication_id, "active-publication");
  assert.equal(body.metadata.publication_id, "previous-publication");
  assert.equal(body.metadata.meta_of, "previous_publication");
  assert.equal(body.registration_ready, false);
});

test("skill data fails closed while required product evidence is unavailable", async () => {
  const response = await handleSkillData(
    { DB: fixtureDb() },
    "weather_place_forecast_change_daily",
    new URLSearchParams(),
    { key_hash: "test-key", daily_quota: 1000 },
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "product_not_ready");
  assert.equal(body.product_id, "weather_place_forecast_change_daily");
  assert.ok(body.blockers.includes("source_rights_metadata_contract_unavailable"));
});
