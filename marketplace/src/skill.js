// `/skill/v1/*` — seoul-weather-risk K-Skill 전용 읽기 계약.
//
// `/api/v1` 제품 API와는 소비자와 제품 범위가 다르다. 다만 키 검증·버스트·오류
// 형식·요청 로그는 src/shared.js를 반드시 함께 쓴다. 이 파일은 K-Skill이 선택한
// weather_place_risk_window 단일 제품만 노출하고, 출처·권리·품질 증거가 아직
// 게시되지 않은 동안에는 데이터보다 먼저 `product_not_ready`를 반환한다.
// "모르는 데이터를 성공으로 보인다"보다 실패를 명시하는 편이 등록 심사와 사용자
// 모두에게 안전하다.
import { countUsage, json, parseJsonArray, problem, quotaExceededProblem, quotaHeaders, safeRows } from "./shared.js";

export const SKILL_BUNDLE_ID = "seoul-weather-risk";

// K-Skill이 노출하는 단일 제품. 카탈로그의 정렬이나 물리 테이블 이름에 의존하지 않는다.
export const SKILL_PRODUCT_IDS = [
  "weather_place_risk_window",
];

const PRODUCT_IDS = new Set(SKILL_PRODUCT_IDS);
const PRODUCT_ID_RE = /^[a-z0-9_]+$/;
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MINUTE_MS = 60_000;
const KST_OFFSET = "+09:00";

export const isSkillProduct = (productId) => PRODUCT_IDS.has(productId);


function parseJsonObject(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

function validDateParts(year, month, day = 1) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function freshnessAsOfMillis(value) {
  if (!nonEmpty(value)) return null;
  const raw = value.trim();
  let candidate;
  let match;

  if ((match = /^(\d{4})$/.exec(raw))) {
    candidate = `${raw}-01-01T00:00:00${KST_OFFSET}`;
  } else if ((match = /^(\d{4})-(\d{2})$/.exec(raw))) {
    if (!validDateParts(Number(match[1]), Number(match[2]))) return null;
    candidate = `${raw}-01T00:00:00${KST_OFFSET}`;
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw))) {
    if (!validDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
    candidate = `${raw}T00:00:00${KST_OFFSET}`;
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/.exec(raw))) {
    const [, year, month, day, hour, minute, second = "0"] = match;
    if (!validDateParts(Number(year), Number(month), Number(day)) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    candidate = `${raw.replace(" ", "T")}${KST_OFFSET}`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    candidate = raw.replace(" ", "T");
  } else {
    return null;
  }

  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

export function freshnessState(freshnessAsOf, sloMinutes, nowMs = Date.now()) {
  if (!Number.isInteger(sloMinutes) || sloMinutes < 1 || !Number.isFinite(nowMs)) return "incomplete";
  const freshnessMs = freshnessAsOfMillis(freshnessAsOf);
  if (freshnessMs === null) return "incomplete";
  return nowMs - freshnessMs > sloMinutes * MINUTE_MS ? "stale" : "fresh";
}

function passingMeasuredCoverage(coverage) {
  return coverage?.status === "passed" && nonEmpty(coverage.field) &&
    Number.isInteger(coverage.expected_distinct_count) &&
    Number.isInteger(coverage.observed_distinct_count) &&
    typeof coverage.minimum_ratio === "number" && typeof coverage.ratio === "number" &&
    coverage.expected_distinct_count >= 1 && coverage.observed_distinct_count >= 0 &&
    coverage.minimum_ratio > 0 && coverage.minimum_ratio <= 1 &&
    coverage.ratio >= coverage.minimum_ratio;
}

function explicitNotApplicableCoverage(coverage) {
  return coverage?.status === "not_applicable" && nonEmpty(coverage.reason) &&
    Object.keys(coverage).every((key) => key === "status" || key === "reason");
}

function quoteIdentifier(value) {
  if (!SQL_IDENTIFIER_RE.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

function encodeCursor(publicationId, rowid) {
  return btoa(JSON.stringify({ publication_id: publicationId, rowid }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    return nonEmpty(parsed.publication_id) && Number.isSafeInteger(parsed.rowid) && parsed.rowid >= 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseLimit(raw) {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return Math.min(Number(raw), MAX_LIMIT);
}

async function safeFirst(statement) {
  try {
    return await statement.first();
  } catch {
    return null;
  }
}

function unknownProduct(productId) {
  return problem(404, "unknown product",
    "seoul-weather-risk에 등록된 제품이 아니다",
    { code: "unknown_product", product_id: productId });
}

function notReady(product) {
  return problem(503, "product not ready",
    "출처·이용권리·품질 증거가 게시되기 전까지 데이터 조회를 닫는다",
    {
      code: "product_not_ready",
      product_id: product.product_id,
      publication_id: product.publication_id,
      blockers: product.blockers,
    });
}

// _catalog은 제품의 현재 발행본이고, 보조 메타는 무변경 밴드 때문에 한 발행 전 상태일
// 수 있다. 그 상태는 `meta_of: previous_publication`으로 *표시*한다. 보조 메타가
// 비어 있거나 읽히지 않는 경우는 준비 불가 사유로 남기지만, 임의의 기본값을 만들지 않는다.
async function loadSkillProduct(env, productId, nowMs = Date.now()) {
  if (!PRODUCT_ID_RE.test(productId) || !isSkillProduct(productId)) return null;

  const catalog = await safeFirst(env.DB.prepare(
    "SELECT name, product_id, external, serving_status, publication_id, freshness, time_axis, " +
    "columns, description, product_question, row_count FROM _catalog WHERE product_id = ?"
  ).bind(productId));

  const [ext, columns, sources, qualityRow] = catalog
    ? await Promise.all([
        safeFirst(env.DB.prepare(
          "SELECT grain, primary_key, time_axis, publication_id FROM d1_catalog_ext WHERE product_id = ?"
        ).bind(productId)),
        safeRows(env.DB.prepare(
          "SELECT ordinal, column_name, type, description_ko, publication_id " +
          "FROM d1_catalog_columns WHERE product_id = ? ORDER BY ordinal"
        ).bind(productId)),
        safeRows(env.DB.prepare(
          "SELECT source_id, source_url, license, license_url, redistribution, attribution, rights_checked_at, " +
          "publication_id FROM d1_catalog_sources WHERE product_id = ? ORDER BY source_id"
        ).bind(productId)),
        safeFirst(env.DB.prepare(
          "SELECT source_row_count, d1_row_count, duplicate_primary_key_count, null_primary_key_count, " +
          "freshness_as_of, freshness_slo_minutes, serving_status, measured_at, coverage_json, " +
          "projection_schema_version, projection_schema_hash, publication_id " +
          "FROM d1_product_quality WHERE product_id = ?"
        ).bind(productId)),
      ])
    : [null, null, null, null];

  const blockers = [];
  if (!catalog) {
    blockers.push("missing_catalog_entry");
  } else {
    if (catalog.external !== 1) blockers.push("not_externally_published");
    if (catalog.serving_status !== "published") blockers.push("not_serving_published");
    if (!catalog.publication_id) blockers.push("missing_publication_identity");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(catalog.name || "")) blockers.push("invalid_table_identity");
    if (!ext) blockers.push("missing_structure_metadata");
    if (!columns || !columns.length) blockers.push("missing_column_metadata");
    if (ext?.publication_id !== catalog.publication_id) blockers.push("structure_publication_mismatch");
    if (ext?.time_axis && catalog.time_axis && ext.time_axis !== catalog.time_axis) {
      blockers.push("time_axis_metadata_mismatch");
    }
    if (columns?.some((column) => column.publication_id !== catalog.publication_id)) {
      blockers.push("column_metadata_publication_mismatch");
    }
  }

  if (sources === null) {
    blockers.push("source_rights_metadata_contract_unavailable");
  } else if (!sources.length) {
    blockers.push("missing_source_rights_evidence");
  } else {
    for (const source of sources) {
      if (source.publication_id !== catalog?.publication_id) blockers.push("source_rights_publication_mismatch");
      if (!nonEmpty(source.source_id) || !nonEmpty(source.source_url) || !nonEmpty(source.license) ||
          !nonEmpty(source.license_url) || !nonEmpty(source.attribution) || !nonEmpty(source.rights_checked_at)) {
        blockers.push("source_rights_evidence_incomplete");
      }
      if (source.redistribution !== "allowed_with_attribution") {
        blockers.push("source_redistribution_not_allowed");
      }
    }
  }

  const coverage = parseJsonObject(qualityRow?.coverage_json);
  if (!qualityRow) {
    blockers.push("quality_metadata_contract_unavailable");
  } else {
    const currentFreshnessState = freshnessState(
      qualityRow.freshness_as_of,
      qualityRow.freshness_slo_minutes,
      nowMs,
    );
    if (qualityRow.publication_id !== catalog?.publication_id) blockers.push("quality_publication_mismatch");
    if (qualityRow.serving_status !== "published") blockers.push("quality_status_not_published");
    if (!nonNegativeInteger(qualityRow.source_row_count) || !nonNegativeInteger(qualityRow.d1_row_count) ||
        !nonNegativeInteger(qualityRow.duplicate_primary_key_count) || !nonNegativeInteger(qualityRow.null_primary_key_count)) {
      blockers.push("quality_counts_invalid");
    }
    if (qualityRow.d1_row_count !== catalog?.row_count) blockers.push("quality_d1_row_count_mismatch");
    if (qualityRow.duplicate_primary_key_count !== 0 || qualityRow.null_primary_key_count !== 0) {
      blockers.push("quality_primary_key_violation");
    }
    if (currentFreshnessState === "incomplete" || !nonEmpty(qualityRow.measured_at)) {
      blockers.push("quality_freshness_evidence_incomplete");
    } else if (currentFreshnessState === "stale") {
      blockers.push("quality_freshness_stale");
    }
    if (!nonEmpty(qualityRow.projection_schema_version) || !nonEmpty(qualityRow.projection_schema_hash)) {
      blockers.push("public_projection_identity_missing");
    }
    if (!passingMeasuredCoverage(coverage) && !explicitNotApplicableCoverage(coverage)) {
      blockers.push("quality_coverage_not_passing");
    }
  }

  const metadataPublicationId = ext?.publication_id ?? null;
  const metaOf = metadataPublicationId && catalog?.publication_id &&
    metadataPublicationId !== catalog.publication_id
    ? "previous_publication"
    : null;

  return {
    product_id: productId,
    table_name: catalog?.name ?? null,
    publication_id: catalog?.publication_id ?? null,
    freshness: catalog?.freshness ?? null,
    description: catalog?.description ?? null,
    product_question: catalog?.product_question ?? null,
    registration_ready: blockers.length === 0,
    blockers,
    metadata: {
      publication_id: metadataPublicationId,
      meta_of: metaOf,
      structure: ext
        ? {
            grain: ext.grain ?? null,
            primary_key: parseJsonArray(ext.primary_key),
            time_axis: ext.time_axis ?? catalog?.time_axis ?? null,
          }
        : null,
      columns: (columns || []).map((column) => ({
        name: column.column_name,
        type: column.type,
        description_ko: column.description_ko,
      })),
      sources: sources === null ? null : (sources || []).map((source) => ({
        source_id: source.source_id,
        source_url: source.source_url,
        license: source.license,
        license_url: source.license_url,
        redistribution: source.redistribution,
        attribution: source.attribution,
        rights_checked_at: source.rights_checked_at,
        publication_id: source.publication_id,
      })),
      quality: qualityRow
        ? {
            source_row_count: qualityRow.source_row_count,
            d1_row_count: qualityRow.d1_row_count,
            duplicate_primary_key_count: qualityRow.duplicate_primary_key_count,
            null_primary_key_count: qualityRow.null_primary_key_count,
            freshness_as_of: qualityRow.freshness_as_of,
            freshness_slo_minutes: qualityRow.freshness_slo_minutes,
            serving_status: qualityRow.serving_status,
            measured_at: qualityRow.measured_at,
            projection_schema_version: qualityRow.projection_schema_version,
            projection_schema_hash: qualityRow.projection_schema_hash,
            publication_id: qualityRow.publication_id,
            coverage,
          }
        : null,
    },
  };
}

export async function handleSkillBundle(env, trace = {}) {
  trace.table = SKILL_BUNDLE_ID;
  const nowMs = Date.now();
  const products = await Promise.all(SKILL_PRODUCT_IDS.map((productId) => loadSkillProduct(env, productId, nowMs)));
  trace.rows = products.length;
  return json({
    bundle_id: SKILL_BUNDLE_ID,
    registration_ready: products.every((product) => product.registration_ready),
    products: products.map((product) => ({
      product_id: product.product_id,
      publication_id: product.publication_id,
      registration_ready: product.registration_ready,
      blockers: product.blockers,
    })),
  });
}

export async function handleSkillProduct(env, productId, trace = {}) {
  // `/skill/v1` 은 계약상 경로 인자가 곧 공개 식별자다 — 해석을 기다릴 필요가 없다
  trace.table = productId;
  trace.productId = productId;
  const product = await loadSkillProduct(env, productId, Date.now());
  if (!product) return unknownProduct(productId);
  trace.publicationId = product.publication_id ?? null;
  trace.rows = product.metadata.columns.length;
  return json({ bundle_id: SKILL_BUNDLE_ID, ...product });
}

export async function handleSkillData(env, productId, _searchParams, _keyRow, trace = {}) {
  trace.table = productId;
  trace.productId = productId;
  const product = await loadSkillProduct(env, productId, Date.now());
  if (!product) return unknownProduct(productId);
  trace.publicationId = product.publication_id ?? null;

  // 쿼터는 실제 데이터 제공 뒤에만 소모한다. 준비 전 503을 사용자가 반복 확인하는
  // 상황에서 호출 한도를 잃게 하면 관측 가능한 운영 상태가 숨겨진다.
  if (!product.registration_ready) return notReady(product);

  const publicColumns = product.metadata.columns.map((column) => column.name);
  const allowedColumns = new Set(publicColumns);
  if (!SQL_IDENTIFIER_RE.test(product.table_name || "") || !publicColumns.length ||
      publicColumns.some((column) => !SQL_IDENTIFIER_RE.test(column))) {
    // registration_ready는 D1 metadata의 publication identity까지 확인했지만, identifier
    // 형식은 SQL 경계에서 한 번 더 fail-closed 한다. 카탈로그 오염이 쿼리로 번지지 않는다.
    return problem(503, "data serving unavailable", "안전한 공개 조회 스키마를 확인할 수 없다",
      { code: "data_serving_contract_invalid", product_id: product.product_id });
  }

  const limit = parseLimit(_searchParams.get("limit"));
  if (limit === null) {
    return problem(400, "invalid limit", `limit 는 1 이상 정수여야 하며 최대 ${MAX_LIMIT}까지다`);
  }

  const where = [];
  const binds = [];
  for (const [key, value] of _searchParams.entries()) {
    if (["limit", "from", "to", "cursor"].includes(key)) continue;
    if (!allowedColumns.has(key)) {
      return problem(400, "unknown filter", `'${key}' 컬럼은 이 제품의 공개 projection에 없다`, {
        product_id: product.product_id,
      });
    }
    where.push(`${quoteIdentifier(key)} = ?`);
    binds.push(value);
    trace.filterCols = (trace.filterCols || []).concat(key);
  }

  const timeAxis = product.metadata.structure?.time_axis;
  if (_searchParams.get("from") || _searchParams.get("to")) {
    if (!timeAxis || !allowedColumns.has(timeAxis)) {
      return problem(400, "no time axis", "이 제품은 공개 time axis가 없어 from/to를 지원하지 않는다", {
        product_id: product.product_id,
      });
    }
    if (_searchParams.get("from")) {
      where.push(`${quoteIdentifier(timeAxis)} >= ?`);
      binds.push(_searchParams.get("from"));
    }
    if (_searchParams.get("to")) {
      where.push(`${quoteIdentifier(timeAxis)} <= ?`);
      binds.push(_searchParams.get("to"));
    }
  }

  const rawCursor = _searchParams.get("cursor");
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) return problem(400, "invalid cursor", "이전 응답의 next_cursor 값을 그대로 넣어야 한다");
    if (cursor.publication_id !== product.publication_id) {
      return problem(409, "cursor expired", "제품이 재게시됐다 — cursor 없이 첫 페이지부터 다시 조회할 것", {
        publication_id: product.publication_id,
      });
    }
    where.push("rowid > ?");
    binds.push(cursor.rowid);
  }

  const usage = await countUsage(env, _keyRow);
  if (usage.exceeded) {
    return quotaExceededProblem(usage.used, usage.quota);
  }

  const selectColumns = publicColumns.map(quoteIdentifier).join(", ");
  const sql = `SELECT rowid AS "_rid", ${selectColumns} FROM ${quoteIdentifier(product.table_name)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY rowid LIMIT ${limit + 1}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const lastRowId = page.length ? page[page.length - 1]._rid : null;
  const rows = page.map(({ _rid, ...row }) => row);

  trace.rows = rows.length;
  return json({
    bundle_id: SKILL_BUNDLE_ID,
    product_id: product.product_id,
    table_name: product.table_name,
    publication_id: product.publication_id,
    row_count: rows.length,
    limit,
    time_axis: timeAxis ?? null,
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(product.publication_id, lastRowId) : null,
    usage: { used: usage.used, daily_quota: usage.quota },
    rows,
  }, 200, quotaHeaders(usage.used, usage.quota));
}
