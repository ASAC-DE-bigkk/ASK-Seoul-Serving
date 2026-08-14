// `weather_place_risk_window` 전용 query-bound 계약.
//
// 이 모듈은 일반 `/api/v1`·MCP와 공유하지 않는다. Weather risk의 빈 결과를
// 현재 publication이 증명한 장소·시간 coverage와 결합하고, 그 증거를 바탕으로
// 과금·조회·cursor 순서를 고정하는 것이 이 모듈의 유일한 책임이다.

export const QUERY_AVAILABILITY_TABLE = "d1_product_query_availability";
export const QUERY_CONTEXT_SCHEMA_VERSION = "weather-risk-query-context/v1";
export const QUERY_AVAILABILITY_SOURCE_REVISION_RE = /^kma_admin_dong_grid_20260325:[0-9a-f]{64}$/;
export const WEATHER_PLACE_ID_RE = /^seoul_admd_[0-9]{10}$/;

const KST_OFFSET_MINUTES = 9 * 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;
const STORAGE_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const REQUEST_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const QUERY_AVAILABILITY_COLUMNS = [
  "product_id",
  "publication_id",
  "place_id",
  "snapshot_as_of_hour",
  "available_from_at",
  "available_to_at",
  "forecast_collected_at_min",
  "forecast_collected_at_max",
  "expected_forecast_hour_count",
  "observed_forecast_hour_count",
  "availability_status",
  "source_population_revision",
  "availability_fingerprint",
  "measured_at",
];

function daysInMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDateParts(year, month, day) {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) &&
    year >= 1 && year <= 9999 && day >= 1 && day <= daysInMonth(year, month);
}

function validClockParts(hour, minute, second) {
  return Number.isInteger(hour) && Number.isInteger(minute) && Number.isInteger(second) &&
    hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function fractionToMillis(fraction) {
  if (!fraction) return 0;
  return Number(`${fraction}00`.slice(0, 3));
}

function normalizeFraction(fraction) {
  return fraction ? `.${fraction.padEnd(6, "0")}` : "";
}

function formatKstEpoch(epochMs) {
  const date = new Date(epochMs + KST_OFFSET_MINUTES * MINUTE_MS);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  const millis = date.getUTCMilliseconds();
  const fraction = millis ? `.${String(millis).padStart(3, "0")}000` : "";
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${fraction}`;
}

function parseOffset(raw) {
  if (!raw || raw.toUpperCase() === "Z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const total = hour * 60 + minute;
  return match[1] === "+" ? total : -total;
}

function parseDateOnly(raw, edge) {
  const match = DATE_RE.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validDateParts(year, month, day)) return null;
  const hour = edge === "to" ? 23 : 0;
  const minute = edge === "to" ? 59 : 0;
  const second = edge === "to" ? 59 : 0;
  const epochMs = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  return { epochMs, canonical: `${raw} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` };
}

// 요청 bound는 날짜·KST-naive datetime·RFC3339 instant를 받는다. 반환값의
// canonical은 항상 KST-naive이며 SQL bound는 hourly slot으로 별도 내림/올림한다.
export function parseQueryBound(raw, edge) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  const dateOnly = parseDateOnly(value, edge);
  if (dateOnly) return dateOnly;

  const match = REQUEST_TIMESTAMP_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const fraction = match[7] ?? "";
  const offset = parseOffset(match[8]);
  if (!validDateParts(year, month, day) || !validClockParts(hour, minute, second) || offset === null) {
    return null;
  }

  if (!match[8]) {
    const epochMs = Date.UTC(year, month - 1, day, hour - 9, minute, second, fractionToMillis(fraction));
    return {
      epochMs,
      canonical: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${normalizeFraction(fraction)}`,
    };
  }

  const iso = `${value.replace(" ", "T")}`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return { epochMs: parsed, canonical: formatKstEpoch(parsed) };
}

export function parseStorageTimestamp(raw) {
  if (typeof raw !== "string") return null;
  const match = STORAGE_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  if (!validDateParts(year, month, day) || !validClockParts(hour, minute, second)) return null;
  return {
    epochMs: Date.UTC(year, month - 1, day, hour - 9, minute, second, fractionToMillis(fraction)),
    canonical: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${normalizeFraction(fraction)}`,
    hasFraction: Boolean(fraction),
  };
}

export function hourlySlotBounds(from, to) {
  if (!from || !to || !Number.isFinite(from.epochMs) || !Number.isFinite(to.epochMs)) return null;
  const first = Math.ceil(from.epochMs / HOUR_MS) * HOUR_MS;
  const last = Math.floor(to.epochMs / HOUR_MS) * HOUR_MS;
  if (first > last) return null;
  return { from: formatKstEpoch(first).slice(0, 19), to: formatKstEpoch(last).slice(0, 19) };
}

export function validPlaceId(value) {
  return typeof value === "string" && WEATHER_PLACE_ID_RE.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function completeAvailabilityRow(row, productId, publicationId, placeId) {
  if (!row || row.product_id !== productId || row.publication_id !== publicationId || row.place_id !== placeId) {
    return "query_availability publication identity mismatch";
  }
  if (row.availability_status !== "complete") return "query_availability availability_status is not complete";
  if (!QUERY_AVAILABILITY_SOURCE_REVISION_RE.test(row.source_population_revision || "")) {
    return "query_availability source_population_revision is invalid";
  }
  if (!SHA256_RE.test(row.availability_fingerprint || "") || !nonEmpty(row.measured_at)) {
    return "query_availability publication evidence is incomplete";
  }

  const snapshot = parseStorageTimestamp(row.snapshot_as_of_hour);
  const availableFrom = parseStorageTimestamp(row.available_from_at);
  const availableTo = parseStorageTimestamp(row.available_to_at);
  const collectedMin = parseStorageTimestamp(row.forecast_collected_at_min);
  const collectedMax = parseStorageTimestamp(row.forecast_collected_at_max);
  if (!snapshot || !availableFrom || !availableTo || !collectedMin || !collectedMax) {
    return "query_availability timestamp evidence is malformed";
  }
  if (snapshot.epochMs % HOUR_MS !== 0 || availableFrom.epochMs % HOUR_MS !== 0 || availableTo.epochMs % HOUR_MS !== 0) {
    return "query_availability hourly bounds are invalid";
  }
  if (availableFrom.epochMs !== snapshot.epochMs || availableFrom.epochMs > availableTo.epochMs ||
      collectedMin.epochMs > collectedMax.epochMs) {
    return "query_availability bounds are reversed or snapshot is not the prefix anchor";
  }
  if (!positiveInteger(row.expected_forecast_hour_count) || !positiveInteger(row.observed_forecast_hour_count) ||
      row.expected_forecast_hour_count !== row.observed_forecast_hour_count) {
    return "query_availability forecast hour count is incomplete";
  }
  const inclusiveSlots = Math.floor((availableTo.epochMs - availableFrom.epochMs) / HOUR_MS) + 1;
  if (inclusiveSlots !== row.expected_forecast_hour_count) {
    return "query_availability forecast hour count does not match bounds";
  }
  return null;
}

function sidecarSelect() {
  return QUERY_AVAILABILITY_COLUMNS.map((column) => `"${column}"`).join(", ");
}

export async function readCurrentAvailability(env, product, placeId, nowMs = Date.now()) {
  if (!product.publication_id || !validPlaceId(placeId)) {
    return { error: "query_availability publication identity is unavailable" };
  }
  let result;
  try {
    result = await env.DB.prepare(
      `SELECT ${sidecarSelect()} FROM "${QUERY_AVAILABILITY_TABLE}" ` +
      "WHERE product_id = ? AND publication_id = ? AND place_id = ?"
    ).bind(product.product_id, product.publication_id, placeId).all();
  } catch {
    return { error: "query_availability sidecar is unavailable" };
  }
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (rows.length !== 1) return { error: "query_availability current publication evidence is missing" };
  const row = rows[0];
  const shapeError = completeAvailabilityRow(row, product.product_id, product.publication_id, placeId);
  if (shapeError) return { error: shapeError };

  const collected = parseStorageTimestamp(row.forecast_collected_at_min);
  const slo = product.metadata.quality?.freshness_slo_minutes;
  if (!collected || !Number.isSafeInteger(slo) || slo < 1) {
    return { error: "query_availability freshness contract is unavailable" };
  }
  if (collected.epochMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return { error: "query_availability forecast_collected_at_min is in the future" };
  }
  const freshnessState = nowMs - collected.epochMs > slo * MINUTE_MS ? "stale" : "fresh";
  if (freshnessState !== "fresh") return { error: "query_availability forecast_collected_at_min freshness SLO breached" };

  return {
    row,
    snapshot: parseStorageTimestamp(row.snapshot_as_of_hour),
    availableFrom: parseStorageTimestamp(row.available_from_at),
    availableTo: parseStorageTimestamp(row.available_to_at),
    collectedMin: collected,
    collectedMax: parseStorageTimestamp(row.forecast_collected_at_max),
    freshnessState,
  };
}

export function buildQueryContext({ product, placeId, requestedFrom, requestedTo, availability, zeroResultReason = null }) {
  return {
    schema_version: QUERY_CONTEXT_SCHEMA_VERSION,
    place_id: placeId,
    requested_from_at: requestedFrom.canonical,
    requested_to_at: requestedTo.canonical,
    available_from_at: availability.availableFrom.canonical,
    available_to_at: availability.availableTo.canonical,
    snapshot_as_of_hour: availability.snapshot.canonical,
    forecast_collected_at_min: availability.collectedMin.canonical,
    forecast_collected_at_max: availability.collectedMax.canonical,
    source_population_revision: availability.row.source_population_revision,
    publication_id: product.publication_id,
    coverage_status: "covered",
    freshness_state: availability.freshnessState,
    zero_result_reason: zeroResultReason,
  };
}

export async function queryFingerprint(productId, publicationId, placeId, from, to) {
  const input = JSON.stringify([productId, publicationId, placeId, from, to]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value) {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}

export function encodeWeatherCursor({ publicationId, queryFingerprint: fingerprint, forecastAt, productRowId }) {
  return base64UrlEncode({ v: 2, publication_id: publicationId, query_fingerprint: fingerprint, forecast_at: forecastAt, product_row_id: productRowId });
}

export function decodeWeatherCursor(raw) {
  try {
    const parsed = JSON.parse(base64UrlDecode(raw));
    if (parsed?.v !== 2 || !nonEmpty(parsed.publication_id) || !SHA256_RE.test(parsed.query_fingerprint || "") ||
        !nonEmpty(parsed.forecast_at) || !nonEmpty(parsed.product_row_id)) return null;
    const parsedForecast = parseStorageTimestamp(parsed.forecast_at);
    if (!parsedForecast) return null;
    return { ...parsed, forecast_at: parsedForecast.canonical };
  } catch {
    return null;
  }
}
