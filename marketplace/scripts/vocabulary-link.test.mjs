import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleProductBundle } from "../src/v1.js";

const PRODUCT = {
  name: "gold_weather_place_current_outlook",
  product_id: "weather_place_current_outlook",
  external: 1,
  description: "장소별 현재 예보",
  product_question: "현재 예보는 무엇입니까?",
  time_axis: "forecast_at",
  columns: JSON.stringify([
    { name: "sky_code", type: "varchar" },
    { name: "forecast_at", type: "timestamp" },
  ]),
  row_count: 16,
  freshness: "2026-08-11T09:00:00+09:00",
  publication_id: "pub-vocabulary",
  exported_at: "2026-08-11T09:01:00+09:00",
};

const COLUMN_ROWS = [
  { ordinal: 0, column_name: "sky_code", type: "TEXT", description_ko: "KMA 하늘 상태 코드" },
  { ordinal: 1, column_name: "forecast_at", type: "TEXT", description_ko: "예보 시각" },
];

function fixtureDb({ vocabularyRows = [], missingVocabularyTable = false } = {}) {
  return {
    prepare(sql) {
      const rows = () => {
        if (sql.includes("FROM _catalog")) return [PRODUCT];
        if (sql.includes("FROM d1_catalog_columns")) return COLUMN_ROWS;
        if (sql.includes("FROM d1_catalog_column_vocabularies")) {
          if (missingVocabularyTable) throw new Error("no such table");
          return vocabularyRows;
        }
        if (sql.includes("FROM d1_catalog_ext") || sql.includes("FROM d1_usage_patterns") ||
            sql.includes("FROM d1_pattern_params") || sql.includes("FROM d1_catalog_display")) return [];
        return [];
      };
      const statement = {
        all: async () => ({ results: rows() }),
        first: async () => rows()[0] ?? null,
        run: async () => ({}),
      };
      return { bind: () => statement, ...statement };
    },
  };
}

test("product bundle enriches only a mapped column with vocabulary_id", async () => {
  const env = { DB: fixtureDb({
    vocabularyRows: [{ column_name: "sky_code", vocabulary_id: "weather:sky_code" }],
  }) };
  const res = await handleProductBundle(
    env,
    PRODUCT.product_id,
    new Request(`https://marketplace.example.test/api/v1/products/${PRODUCT.product_id}`),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.columns.find((column) => column.name === "sky_code").vocabulary_id, "weather:sky_code");
  assert.equal("vocabulary_id" in body.columns.find((column) => column.name === "forecast_at"), false);
});

test("product bundle stays available while the optional vocabulary sidecar is absent", async () => {
  const env = { DB: fixtureDb({ missingVocabularyTable: true }) };
  const res = await handleProductBundle(
    env,
    PRODUCT.product_id,
    new Request(`https://marketplace.example.test/api/v1/products/${PRODUCT.product_id}`),
  );

  assert.equal(res.status, 200);
});

test("catalog list enriches mapped columns without adding null vocabulary ids", async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = undefined;
  try {
    const res = await worker.fetch(
      new Request("https://marketplace.example.test/api/v1/catalog"),
      { DB: fixtureDb({ vocabularyRows: [{ product_id: PRODUCT.product_id, column_name: "sky_code", vocabulary_id: "weather:sky_code" }] }) },
      { waitUntil() {} },
    );

    assert.equal(res.status, 200);
    const columns = (await res.json()).products[0].columns;
    assert.equal(columns.find((column) => column.name === "sky_code").vocabulary_id, "weather:sky_code");
    assert.equal("vocabulary_id" in columns.find((column) => column.name === "forecast_at"), false);
  } finally {
    globalThis.caches = previousCaches;
  }
});
