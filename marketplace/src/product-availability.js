// 0행은 언제나 "데이터가 없다"가 아니다. Publisher가 선언한 정상 빈 결과와
// 품질 증거가 빠진 미준비 결과를 구분해 API가 같은 의미로 응답하게 한다.
import { problem } from "./shared.js";
import { freshnessAsOfMillis, freshnessState } from "./skill.js";

const EMPTY_RESULT_CODE_RE = /^[a-z][a-z0-9_]*$/;
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

function parseObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseEmptyResultDeclaration(raw) {
  const emptyResult = parseObject(raw)?.empty_result;
  if (!emptyResult || typeof emptyResult !== "object" || Array.isArray(emptyResult)) return null;
  if (emptyResult.state !== "valid_empty" || !EMPTY_RESULT_CODE_RE.test(emptyResult.code || "") ||
      !nonEmpty(emptyResult.message_ko)) return null;
  return {
    state: emptyResult.state,
    code: emptyResult.code,
    message_ko: emptyResult.message_ko,
  };
}

function parseCurrentnessDeclaration(raw) {
  const projection = parseObject(raw);
  if (!projection || !Object.hasOwn(projection, "currentness")) {
    return { declared: false, declaration: null };
  }
  const currentness = projection.currentness;
  if (!currentness || typeof currentness !== "object" || Array.isArray(currentness) ||
      !SQL_IDENTIFIER_RE.test(currentness.field || "") ||
      currentness.minimum !== "current_kst_hour") {
    return { declared: true, declaration: null };
  }
  return {
    declared: true,
    declaration: { field: currentness.field, minimum: currentness.minimum },
  };
}

function currentKstHourMillis(nowMs) {
  return Math.floor((nowMs + KST_OFFSET_MS) / HOUR_MS) * HOUR_MS - KST_OFFSET_MS;
}

export function evaluateCurrentProductAvailability(catalog, currentnessAsOf, nowMs = Date.now()) {
  const currentness = parseCurrentnessDeclaration(catalog?.mcp_projection);
  if (!currentness.declared) return { availability: null, blockers: [] };
  if (!currentness.declaration || !SQL_IDENTIFIER_RE.test(catalog?.name || "")) {
    return { availability: null, blockers: ["quality_currentness_evidence_incomplete"] };
  }
  const currentnessMs = freshnessAsOfMillis(currentnessAsOf);
  if (currentnessMs === null || !Number.isFinite(nowMs)) {
    return { availability: null, blockers: ["quality_currentness_evidence_incomplete"] };
  }
  if (currentnessMs < currentKstHourMillis(nowMs)) {
    return { availability: null, blockers: ["quality_snapshot_not_current"] };
  }
  return { availability: null, blockers: [] };
}

export function evaluateEmptyProductAvailability(catalog, quality, nowMs = Date.now()) {
  if (catalog?.row_count !== 0) return { availability: null, blockers: [] };

  const blockers = [];
  const availability = parseEmptyResultDeclaration(catalog.mcp_projection);
  if (!availability) blockers.push("empty_result_contract_unavailable");

  if (catalog.serving_status !== "published") blockers.push("catalog_status_not_published");
  if (!nonEmpty(catalog.publication_id)) blockers.push("missing_publication_identity");

  if (!quality) {
    blockers.push("quality_metadata_contract_unavailable");
  } else {
    if (quality.publication_id !== catalog.publication_id) blockers.push("quality_publication_mismatch");
    if (quality.serving_status !== "published") blockers.push("quality_status_not_published");
    if (!nonNegativeInteger(quality.source_row_count) || !nonNegativeInteger(quality.d1_row_count) ||
        !nonNegativeInteger(quality.duplicate_primary_key_count) || !nonNegativeInteger(quality.null_primary_key_count)) {
      blockers.push("quality_counts_invalid");
    }
    if (quality.d1_row_count !== catalog.row_count) blockers.push("quality_d1_row_count_mismatch");
    if (quality.duplicate_primary_key_count !== 0 || quality.null_primary_key_count !== 0) {
      blockers.push("quality_primary_key_violation");
    }

    const currentFreshnessState = freshnessState(
      quality.freshness_as_of,
      quality.freshness_slo_minutes,
      nowMs,
    );
    if (currentFreshnessState === "incomplete" || !nonEmpty(quality.measured_at)) {
      blockers.push("quality_freshness_evidence_incomplete");
    } else if (currentFreshnessState === "stale") {
      blockers.push("quality_freshness_stale");
    }
  }

  return { availability: blockers.length ? null : availability, blockers };
}

async function safeFirst(statement) {
  try {
    return await statement.first();
  } catch {
    return null;
  }
}

export async function loadProductAvailability(env, catalog, nowMs = Date.now()) {
  if (catalog?.row_count !== 0) {
    const currentness = parseCurrentnessDeclaration(catalog?.mcp_projection);
    if (!currentness.declared) return { availability: null, blockers: [] };
    if (!currentness.declaration || !SQL_IDENTIFIER_RE.test(catalog?.name || "")) {
      return evaluateCurrentProductAvailability(catalog, null, nowMs);
    }
    const currentnessRow = await safeFirst(env.DB.prepare(
      `SELECT min("${currentness.declaration.field}") AS currentness_as_of FROM "${catalog.name}"`
    ).bind());
    return evaluateCurrentProductAvailability(
      catalog,
      currentnessRow?.currentness_as_of,
      nowMs,
    );
  }

  const quality = await safeFirst(env.DB.prepare(
    "SELECT source_row_count, d1_row_count, duplicate_primary_key_count, null_primary_key_count, " +
    "freshness_as_of, freshness_slo_minutes, serving_status, measured_at, publication_id " +
    "FROM d1_product_quality WHERE product_id = ?"
  ).bind(catalog.product_id));
  return evaluateEmptyProductAvailability(catalog, quality, nowMs);
}

export function productNotReadyResponse(catalog, blockers) {
  return problem(503, "product not ready",
    "정상 빈 결과를 확인할 계약 또는 같은 발행본의 품질 증거가 준비되지 않았습니다",
    {
      code: "product_not_ready",
      product_id: catalog.product_id,
      publication_id: catalog.publication_id ?? null,
      blockers,
    });
}
