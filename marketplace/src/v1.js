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

  // 보조 3종은 파이프라인이 게시하고 도메인별 진도가 다르다(#668) — 없으면 그 조각만 비운다.
  // 파라미터 메타(P1 기본값·허용값 / P3 타입, #217)는 별도 표 d1_pattern_params 다(#706 전례:
  // 공유 표에 컬럼을 더하면 구 실행기가 되돌린다). 표가 없으면 그 조각만 없이 동작한다.
  const [columns, ext, patterns, paramMeta] = await Promise.all([
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
    safeRows(env.DB.prepare(
      "SELECT pattern_id, param_defaults, param_enum, params FROM d1_pattern_params " +
      "WHERE product_id = ?"
    ).bind(productId)),
  ]);
  // 기본값 파싱은 서버 이 한 곳이다(#217 결정) — 플레이그라운드의 `-- :n=10` 주석 파서(#219)는
  // 이 응답의 선언값으로 대체된다. 못 읽는 JSON 은 그 항목만 버린다(없는 것과 같게).
  const parseObj = (raw) => { try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : undefined; } catch { return undefined; } };
  const paramsByPattern = new Map((paramMeta || []).map((r) => [r.pattern_id, {
    param_defaults: parseObj(r.param_defaults),
    param_enum: parseObj(r.param_enum),
    params: parseObj(r.params),
  }]));

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
      // P1/P3 파라미터 메타(#217) — 선언된 패턴에만 실린다(undefined 는 JSON 에서 사라진다).
      // param_defaults 가 있는 이름은 호출 시 생략 가능, param_enum 밖 값은 400,
      // params 의 array 선언은 REST 에서 JSON 배열 문자열로 보낸다.
      ...(paramsByPattern.get(p.pattern_id) || {}),
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

  // 🔑 **파라미터가 없으면 목록을 준다**(#180). 예전엔 400 이었는데, `vocabulary_id` 를 알아낼
  //    경로가 어디에도 없었다 — 컬럼이 자기 어휘를 선언하지 않으므로 소비자는 `commerce:<컬럼명>`
  //    같은 규칙을 **지어내야** 했고 그 대부분이 404 였다. 목록을 열어 추측을 없앤다.
  //    (컬럼이 어휘를 선언하는 본안은 공통 계약 사안이라 별건이다 — #180 에서 commerce 담당과
  //    합의한 분담이고, 이쪽은 "게이트웨이 안에서 끝나는 것"으로 먼저 연다.)
  if (!vocabularyId) {
    const list = await safeRows(env.DB.prepare(
      "SELECT vocabulary_id, origin, COUNT(*) AS term_count FROM d1_catalog_glossary " +
      "GROUP BY vocabulary_id, origin ORDER BY vocabulary_id"
    ));
    if (list === null)
      return problem(503, "glossary unavailable",
        "용어 사전이 아직 게시되지 않았다 — 파이프라인 게시 후 다시 시도할 것");
    trace.rows = list.length;
    return json({
      vocabularies: list,
      // 목록만 주고 끝내면 "그래서 어떻게 쓰나"가 남는다. 다음 한 걸음을 응답이 말한다.
      next: "GET /api/v1/glossary?vocabulary_id=<위 목록의 값> 으로 코드값을 받는다",
    });
  }

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
