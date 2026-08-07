// 제품 메타 조립기 + 용어 사전 — `/api/v1` 로 **흡수된** 두 핸들러.
//
// **파일 이름만 과거를 가리킨다.** 원래 `/v1/*`(ASAC-DAG#642 안 B) 전용이었는데, 그 표면은
// 접고 기능은 `/api/v1` 아래로 옮겼다 — agreement §10 이 처분을 *"소비자 전수 0 실측.
// `/api/v1` 로 흡수"* 로 기록했고 그게 정본이다(decision/0004 D-2 초안이 "삭제"로 적었다가
// 정정됐다). 파일 이름은 소비자가 생긴 뒤 옮긴다.
//
// 소비 순서는 ① 제품 고르기(`/api/v1/catalog`) → ② 그 제품 메타 전부 → ③ 질의 이고,
// 여기는 ②를 한 번에 준다. 조립 쿼리 4개는 #642 §1 그대로다.
//
// 식별자가 테이블명이 아니라 **product_id** 인 게 결정적이다 — 테이블명은 물리 이름이라
// 바뀔 수 있고, product_id 는 계약(meta.serving)이 보증한다(decision/0003).
//
// 메타 조회는 일일 쿼터를 소모하지 않는다(버스트만 적용) — 데이터가 아니라 판단 재료이고,
// 소비 순서상 데이터 호출 앞에 반드시 오는 단계라 여기서 깎으면 정작 쓸 몫이 준다.
import { json, problem, safeRows, parseJsonArray, PUBLIC } from "./shared.js";

const ID_RE = /^[a-z0-9_]+$/;

// ETag 는 publication_id 다 — 내용이 바뀔 때만 값이 바뀌므로(#601 무변경 게이트)
// If-None-Match 대조로 재조회를 건너뛰게 할 수 있다.
const etagOf = (publicationId) => (publicationId ? `"${publicationId}"` : null);

export async function handleProductBundle(env, productId, request, trace = {}) {
  trace.table = productId;
  trace.productId = productId;   // `/v1` 도 경로 인자가 공개 식별자다
  if (!ID_RE.test(productId))
    return problem(400, "invalid product id", "product_id 형식이 아니다");

  // 비공개·미등록은 404 로 답한다 — 403 이면 "있긴 있다"를 알려주는 셈이다(`/api/*` 와 같은 규칙)
  const cat = await env.DB.prepare(
    "SELECT name, product_id, description, product_question, time_axis, freshness, " +
    `row_count, publication_id, exported_at FROM _catalog WHERE product_id = ? AND ${PUBLIC}`
  ).bind(productId).first();
  if (!cat)
    return problem(404, "unknown product",
      `'${productId}' 은 서빙 카탈로그에 없다 — GET /api/v1/catalog 로 목록을 확인할 것`);

  const etag = etagOf(cat.publication_id);
  if (etag && request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers: { etag, "access-control-allow-origin": "*" } });

  // 보조 3종은 파이프라인이 게시하고 도메인별 진도가 다르다(#668) — 없으면 그 조각만 비운다
  const [columns, ext, patterns] = await Promise.all([
    safeRows(env.DB.prepare(
      "SELECT ordinal, column_name, type, description_ko FROM d1_catalog_columns " +
      "WHERE product_id = ? ORDER BY ordinal"
    ).bind(productId)),
    safeRows(env.DB.prepare(
      "SELECT grain, primary_key, time_axis, tier, rollup_rule, publication_id " +
      "FROM d1_catalog_ext WHERE product_id = ?"
    ).bind(productId)),
    safeRows(env.DB.prepare(
      "SELECT pattern_id, question_ko, axes, requires, verified_rows, verified_at, " +
      "allow_empty, insight_sample_ko FROM d1_usage_patterns WHERE product_id = ? ORDER BY pattern_id"
    ).bind(productId)),
  ]);

  const extRow = ext && ext.length ? ext[0] : null;
  const missing = [];
  if (!columns || !columns.length) missing.push("columns");
  if (!extRow) missing.push("structure");
  if (!patterns || !patterns.length) missing.push("patterns");

  // 메타의 게시본이 데이터와 다를 수 있다 — 무변경 밴드 게이트로 스킵된 제품의 **정상 상태**다
  // (#642 §0). 불일치를 오류로 처리하면 멀쩡한 제품이 막히므로 표시만 한다.
  const metaOf = extRow && extRow.publication_id && extRow.publication_id !== cat.publication_id
    ? "previous_publication" : null;

  const body = {
    product_id: cat.product_id,
    table_name: cat.name,
    publication_id: cat.publication_id,
    description: cat.description,
    product_question: cat.product_question,
    freshness: cat.freshness,
    row_count: cat.row_count,
    exported_at: cat.exported_at,
    structure: extRow
      ? {
          grain: extRow.grain,
          primary_key: parseJsonArray(extRow.primary_key),
          time_axis: extRow.time_axis ?? cat.time_axis,
          tier: extRow.tier,
          rollup_rule: extRow.rollup_rule,
        }
      : null,
    columns: (columns || []).map((c) => ({
      name: c.column_name, type: c.type, description_ko: c.description_ko,
    })),
    patterns: (patterns || []).map((p) => ({
      pattern_id: p.pattern_id,
      question_ko: p.question_ko,
      axes: p.axes,
      requires: parseJsonArray(p.requires),
      verified_rows: p.verified_rows,
      verified_at: p.verified_at,          // 백필 전이라 당분간 NULL (#642 §0)
      // run_pattern 이 실행해 주는 패턴인지(#118 — verified 만 실행, 미검증은 409).
      // 소비자가 고른 뒤 튕기는 왕복을 없애려고 고르기 전에 알려 준다. verified_at 에서
      // 계산하는 파생값이라 스키마·계약 변경이 아니다.
      runnable: Boolean(p.verified_at),
      allow_empty: Boolean(p.allow_empty),
      insight_sample_ko: p.insight_sample_ko,
    })),
    meta: {
      // 없는 것을 빈 배열로 주면 "메타가 없다"와 "메타가 비었다"가 구분되지 않는다
      unavailable: missing.length ? missing : undefined,
      meta_of: metaOf ?? undefined,
    },
  };
  trace.rows = body.columns.length + body.patterns.length;
  return json(body, 200, etag ? { etag } : {});
}

export async function handleGlossary(env, vocabularyId, trace = {}) {
  trace.table = "d1_catalog_glossary";
  if (!vocabularyId)
    return problem(400, "missing vocabulary_id",
      "vocabulary_id 쿼리 파라미터가 필요하다 — 예: /api/v1/glossary?vocabulary_id=commerce:major");

  const rows = await safeRows(env.DB.prepare(
    "SELECT code, label_ko, origin, source_type FROM d1_catalog_glossary " +
    "WHERE vocabulary_id = ? ORDER BY code"
  ).bind(vocabularyId));

  if (rows === null)
    return problem(503, "glossary unavailable",
      "용어 사전이 아직 게시되지 않았다 — 파이프라인 게시 후 다시 시도할 것");
  if (!rows.length)
    return problem(404, "unknown vocabulary", `'${vocabularyId}' 어휘가 없다`);

  trace.rows = rows.length;
  return json({ vocabulary_id: vocabularyId, terms: rows });
}
