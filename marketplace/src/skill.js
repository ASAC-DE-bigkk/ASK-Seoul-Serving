// `/skill/v1/*` — seoul-urban-analytics K-Skill 전용 읽기 계약.
//
// 공용 `/v1/*` 제품 API와는 소비자와 제품 범위가 다르다. 다만 키 검증·버스트·오류
// 형식·요청 로그는 src/shared.js를 반드시 함께 쓴다. 이 파일은 K-Skill이 선택한 여섯
// 제품만 노출하고, 출처·권리·품질 증거가 아직 게시되지 않은 동안에는 데이터보다 먼저
// `product_not_ready`를 반환한다. "모르는 데이터를 성공으로 보인다"보다 실패를 명시하는
// 편이 등록 심사와 사용자 모두에게 안전하다.
import { json, problem, safeRows } from "./shared.js";

export const SKILL_BUNDLE_ID = "seoul-urban-analytics";

// 순서는 K-Skill의 도메인 설명과 응답을 안정적으로 유지하는 계약이다. 카탈로그의
// 정렬이나 물리 테이블 이름에 의존하지 않는다.
export const SKILL_PRODUCT_IDS = [
  "weather_place_forecast_change_daily",
  "traffic_incident_x_weather_current_hourly",
  "citydata_purchasing_power_daily",
  "commerce_flow_monthly",
  "culture_activity_by_dong",
  "transit_parking_full_risk",
];

const PRODUCT_IDS = new Set(SKILL_PRODUCT_IDS);
const PRODUCT_ID_RE = /^[a-z0-9_]+$/;

export const isSkillProduct = (productId) => PRODUCT_IDS.has(productId);

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
    "seoul-urban-analytics에 등록된 제품이 아니다",
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
async function loadSkillProduct(env, productId) {
  if (!PRODUCT_ID_RE.test(productId) || !isSkillProduct(productId)) return null;

  const catalog = await safeFirst(env.DB.prepare(
    "SELECT name, product_id, external, serving_status, publication_id, freshness, time_axis, " +
    "columns, description, product_question FROM _catalog WHERE product_id = ?"
  ).bind(productId));

  const [ext, columns] = catalog
    ? await Promise.all([
        safeFirst(env.DB.prepare(
          "SELECT grain, primary_key, time_axis, publication_id FROM d1_catalog_ext WHERE product_id = ?"
        ).bind(productId)),
        safeRows(env.DB.prepare(
          "SELECT ordinal, column_name, type, description_ko, publication_id " +
          "FROM d1_catalog_columns WHERE product_id = ? ORDER BY ordinal"
        ).bind(productId)),
      ])
    : [null, null];

  const blockers = [];
  if (!catalog) {
    blockers.push("missing_catalog_entry");
  } else {
    if (catalog.external !== 1) blockers.push("not_externally_published");
    if (catalog.serving_status !== "published") blockers.push("not_serving_published");
    if (!catalog.publication_id) blockers.push("missing_publication_identity");
    if (!ext) blockers.push("missing_structure_metadata");
    if (!columns || !columns.length) blockers.push("missing_column_metadata");
  }

  // 현재 publisher가 제공하는 공개 메타 계약에는 출처 URL·license·rights·attribution 및
  // 품질 게이트 결과가 없다. 이 서버가 값이나 합격 여부를 추정하면 데이터 신뢰성 증거를
  // 위조하는 셈이므로, 계약이 공급될 때까지 모든 제품을 명시적으로 준비 불가로 둔다.
  blockers.push("source_rights_metadata_contract_unavailable");
  blockers.push("quality_metadata_contract_unavailable");

  const metadataPublicationId = ext?.publication_id ?? null;
  const metaOf = metadataPublicationId && catalog?.publication_id &&
    metadataPublicationId !== catalog.publication_id
    ? "previous_publication"
    : null;

  return {
    product_id: productId,
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
    },
  };
}

export async function handleSkillBundle(env, trace = {}) {
  trace.table = SKILL_BUNDLE_ID;
  const products = await Promise.all(SKILL_PRODUCT_IDS.map((productId) => loadSkillProduct(env, productId)));
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
  trace.table = productId;
  const product = await loadSkillProduct(env, productId);
  if (!product) return unknownProduct(productId);
  trace.rows = product.metadata.columns.length;
  return json({ bundle_id: SKILL_BUNDLE_ID, ...product });
}

export async function handleSkillData(env, productId, _searchParams, _keyRow, trace = {}) {
  trace.table = productId;
  const product = await loadSkillProduct(env, productId);
  if (!product) return unknownProduct(productId);

  // 쿼터는 실제 데이터 제공 뒤에만 소모한다. 준비 전 503을 사용자가 반복 확인하는
  // 상황에서 호출 한도를 잃게 하면 관측 가능한 운영 상태가 숨겨진다.
  if (!product.registration_ready) return notReady(product);

  // source/rights와 quality 계약이 도입돼 위 게이트가 열릴 때에만, 다음 PR에서
  // publication_id·schema_version·정규화된 필터·keyset 위치를 묶은 K-Skill 커서를
  // 구현한다. 그 전에는 행을 하나도 조회하지 않는다.
  return problem(503, "data serving unavailable",
    "K-Skill 데이터 조회 계약이 아직 활성화되지 않았다",
    { code: "data_serving_unavailable", product_id: product.product_id });
}
