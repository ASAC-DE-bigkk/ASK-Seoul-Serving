// ops-dashboard — 운영자용 통합 품질 콘솔 (ASK-Seoul#58, 로컬 전용)
//
// 한 화면에서 여섯 가지를 본다(탭 이름은 화면 문구 규약 — 내부 용어를 쓰지 않는다):
//   · 데이터 준비 상태 — 발행이 온전한가 (_publication_ledger) + 품질 기준(_ops_slo)
//   · 실행 기록       — 무엇이 돌았고 무엇이 조용한가 (_ops_run_event 등 조회 DB 4종,
//                       ASK-Seoul#78 규약 — 정본 스키마는 ASAC-DAG, 여기는 읽기 전용. decision/0009)
//   · 응답 상태       — 외부에 잘 나가고 있나 (_gateway_request_log, 게이트웨이가 쌓는다)
//   · 이용 행동       — **누가** 쓰나: 사람·AI·여정 (decision/0010)
//   · API 사용량      — **무엇이** 얼마나 쓰이나: API별·분야별 (_gateway_request_log + _catalog)
//   · 이용자 키       — 발급된 키의 상태·쿼터
// 전부 같은 D1 을 읽는다. 마켓플레이스와는 **다른 Worker · 다른 호스트**다 — 청중이 다르고,
// 배포 단위가 갈려야 사고 반경도 갈린다.
//
// 인증: 읽기는 열려 있고 **조치만** 공유 토큰(OPS_TOKEN)으로 잠근다 — canWrite/requireWrite 참고.
// 공유 토큰은 "누가 했나"가 남지 않는 약한 인증이라, 공개 배포 시 Cloudflare Access /
// org OAuth 로 교체해야 한다(멘토 게이트). 조치 쪽은 토큰 미설정이면 503 으로 닫힌다.

// ── 게이트웨이 route 계약 ─────────────────────────────────────────────────────
//
// 게이트웨이가 내보내는 값 전수(`marketplace/src/index.js` 의 `trace.route` 대입 자리와 1:1):
//   catalog · preview · data · me · keys · revoke · mcp
//   skill_bundle · skill_data · skill_product · v1_product · v1_glossary
//
// **데이터를 실제로 서빙한 호출은 문마다 이름이 다르다.** `route='data'` 만 세면 K-Skill 이
// 붙는 순간 제품별 수요·키 활성화율이 조용히 낮아진다 — 그게 #63 이 잡은 사고다. 조건을
// 네 곳에 흩어 둔 것이 원인이었으므로 **여기 한 줄로 모은다.** 새 문이 생기면 여기만 고친다.
const SERVE = "route IN ('data', 'skill_data')";

// ── 환경 스코프 ───────────────────────────────────────────────────────────────
//
// 파이프라인 쪽(`evWhere`)과 **같은 규약**이다. 좁히는 건 운영 화면(`ENV_SCOPE`)뿐이고,
// 개발 화면은 섞인 것도 그대로 보여준다 — "섞였다"는 사실 자체가 이 콘솔이 드러내야 할
// 관측이기 때문이다. 값은 상수 목록에서만 오므로 SQL 조각으로 이어 붙여도 안전하다.
//
// 서빙 로그에는 이 필터가 **없었다.** 게이트웨이가 미배포라 전 행이 `local` 이어서 표가
// 안 났을 뿐이고, 배포되는 순간 `local` 과 `prod` 가 한 화면에 합산된다(#64). 파이프라인이
// 이미 겪은 함정이다(#52 §11 C-4: 운영에 dev 17 · 개발에 prod 63 · ASAC-DAG#654).
const SCOPES = { prod: "prod", dev: "dev" };
const envScope = (env) => SCOPES[String(env.ENV_SCOPE || "").trim()] || null;

// 🔴 `env IS NULL` 은 **운영으로 치지 않는다.** 없는 정보를 운영이라고 단정하면 로컬 실행이
// 운영으로 보인다(ASAC-DAG#692 와 같은 기준). 그래서 `env = 'prod'` 는 NULL 을 자동으로
// 뺀다 — 빼는 건 맞고, **뺐다는 사실을 화면이 말한다**(decision/0012).
const gwWhere = (env) => { const c = envScope(env); return c ? ` AND env = '${c}'` : ""; };

// MCP 는 `route='mcp'` 한 값이라 `query_product`(데이터)와 `list_products`(목록)가 갈리지
// 않는다 — #62 는 상태 기록만 고치고 route 는 그대로 뒀다. 넣으면 부풀고 빼면 모자라므로
// **빼고, 뺀 건수를 화면이 말한다.** 추측해서 채우는 게 제일 나쁘다(agreement §4 모른다 ≠ 0).
const MCP_ONLY = "route = 'mcp'";

// 제품 축. `0005` 가 `product_id` 를 싣기 시작했지만 그 이전 행은 NULL 이라 표명으로만
// 가리킬 수 있다. decision/0003 이 경고한 대로 `table_name` 은 물리명이어서 표명 통일이
// 오면 과거 로그가 아무것도 못 가리킨다 — **정본은 product_id, 표명은 폴백**이다.
const PRODUCT_KEY = "COALESCE(product_id, table_name)";
const PRODUCT_KEY_R = "COALESCE(r.product_id, r.table_name)";
// _catalog 와 이을 때도 같은 우선순위로 본다. 둘을 OR 로 묶으면 한 행이 두 제품에 붙는다.
const CATALOG_JOIN =
  "(CASE WHEN r.product_id IS NOT NULL THEN r.product_id = c.product_id " +
  "      ELSE r.table_name = c.name END)";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const problem = (status, title, detail) =>
  new Response(JSON.stringify({ type: "about:blank", title, status, detail }), {
    status,
    headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store" },
  });

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  // 길이가 달라도 조기 반환하지 않는다 — 비교 시간으로 길이를 알려주지 않기 위해
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// 읽기와 쓰기를 **다른 문**으로 나눈다.
//   읽기(요약·키 목록) — 토큰 없이 연다. 팀에 화면을 보여주는 게 이 콘솔의 쓸모이고,
//     이메일은 이미 응답 단계에서 마스킹되기 때문이다.
//   쓰기(폐기·복구·쿼터·삭제) — 언제나 토큰이 필요하다. 되돌릴 수 없는 조치를
//     주소 아는 사람 전부에게 열어둘 수는 없다.
//
// 원래는 토큰이 없으면 503 으로 화면 전체를 껐다. 그 취지("인증 없는 운영 화면이 실수로
// 열리는 것보다 낫다")는 버린 게 아니라 **쓰기 쪽으로 옮긴** 것이다.
function canWrite(env, request) {
  const token = String(env.OPS_TOKEN || "").trim();
  if (!token) return false;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(got) && timingSafeEqual(got, token);
}

function requireWrite(env, request) {
  const token = String(env.OPS_TOKEN || "").trim();
  if (!token) return problem(503, "ops write disabled", "OPS_TOKEN 미설정 — 조치하려면 .dev.vars 에 설정할 것");
  if (!canWrite(env, request)) return problem(401, "unauthorized", "조치에는 운영자 토큰이 필요하다");
  return null;
}

// 테이블이 아직 없을 수 있다(게이트웨이만 시드한 상태 등) — 콘솔 전체가 죽는 대신
// 그 섹션만 비운다. 어느 쪽이 없는지는 meta.missing 으로 화면에 알린다.
async function safeRows(env, sql, ...bind) {
  try {
    return { rows: (await env.DB.prepare(sql).bind(...bind).all()).results, ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

async function summary(env, params, writable = false) {
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(params.get("days"), 10) || DEFAULT_DAYS));
  const since = `-${days} days`;
  const missing = [];

  // ── 파이프라인
  //
  // ⚠️ **합성 행은 화면에 올리지 않는다.** 예전에는 보여주고 배너로 "이 값으로 판단하지
  // 마세요"를 붙였는데, 그래도 사람은 숫자를 먼저 읽는다 — 화면에 있으면 읽힌다.
  // 아예 빼고, 그 결과 비면 '데이터 없음'으로 두는 편이 정직하다.
  // (표시 규약: _ops_slo 는 is_sample=1, 조회 DB 4종은 event_id 'smp_' / updated_at='sample')
  const domains = await safeRows(env, "SELECT domain, label, has_slo, note FROM _ops_domain ORDER BY has_slo DESC, domain");
  const slo = await safeRows(env,
    "SELECT * FROM _ops_slo WHERE event_date >= date('now', ?) " +
    "AND COALESCE(is_sample, 0) = 0 ORDER BY event_date", since);
  if (!domains.ok || !slo.ok) missing.push("pipeline");

  // ── 실행 기록 (조회 DB 4종 — ASK-Seoul#78 §8, decision/0009. 읽기만 한다)
  // 날짜 축은 observed_date_kst 라 KST 로 자른다(now+9h). 오늘 포함 N일 창.
  const kstSince = `-${days - 1} days`;

  // 🔴 환경 축을 걸러 읽는다(#78 Z-7, #36 지침 ②). 한 조회 DB 에 prod·dev 기록이 함께
  // 들어가 있어서 — 실측 2026-08-04 운영 D1 에 dev 17행 — 안 거르면 개발 실행이 운영
  // 지표에 섞인다. 도메인 쪽 판정 결함은 고쳐졌지만 **과거 행은 남는다.**
  //
  // 좁히는 건 운영 화면(ENV_SCOPE)뿐이다. 개발 화면에서까지 좁히면 "섞였다"는 사실
  // 자체가 안 보이게 되는데, 그건 이 콘솔이 드러내야 할 관측이다.
  // 아래 SQL 은 `?` 바인딩이 아니라 문자열 조각이라, 값은 상수 목록에서만 온다.
  const envCol = envScope(env);
  // 합성 배제를 환경 필터와 같은 조각에 얹는다 — _ops_run_event 를 읽는 모든 질의가 이걸 쓴다.
  // 한 곳에 두지 않으면 새 질의를 더할 때 빠뜨린다(그게 화면에 합성이 새는 경로다).
  const evWhere = (envCol ? ` AND environment = '${envCol}'` : "") +
    " AND event_id NOT LIKE 'smp_%'";

  // ⚠️ **집계표는 못 거른다** — `_ops_daily_metric` 에 `environment` 컬럼이 자체가 없다
  // (정본 스키마 실측 2026-08-04: observed_date_kst·domain·layer 가 키). 그래서 KPI 와
  // 매트릭스는 환경이 섞인 채로 나온다. 여기에 필터를 붙이면 쿼리가 통째로 실패하고
  // safeRows 가 그걸 삼켜 **실행 기록 탭 전체가 조용히 빈다**(실측에서 실제로 그랬다).
  // 거를 수 없다는 사실 자체를 meta 로 내보내 화면이 밝히게 한다 — 감추는 게 더 나쁘다.
  const rdaily = await safeRows(env,
    "SELECT * FROM _ops_daily_metric WHERE observed_date_kst >= date('now','+9 hours', ?)" +
    " AND COALESCE(updated_at, '') <> 'sample'" +
    " ORDER BY observed_date_kst, domain, layer", kstSince);
  // 기대치×상태 — 정본은 DAG 선언의 사본(S-1)이다.
  //
  // 세 갈래를 **한 표에서 구분해서** 낸다. 예전에는 `WHERE monitored = 1` 로 잘라내서
  // 나머지 둘이 화면에 아예 없었는데, 그 둘은 뜻이 정반대다(#7 코멘트 · #36 지침 ④):
  //   watched      기대치 등록 + 감시 대상   — 침묵 한도로 판정한다
  //   unmonitored  기대치 등록 + monitored=0 — **감시 제외**(수동 전용 DAG). 정상이다
  //   unregistered 기대치 행 자체가 없음     — **아직 등록 안 됨**. 판정 근거가 없다는 뜻이라
  //                                            "이상 없음"이 아니라 관측 공백이다
  // 세 번째는 상태 표에만 있는 DAG 라 방향을 뒤집은 LEFT JOIN 이 하나 더 필요하다.
  const rexp = await safeRows(env,
    "SELECT e.dag_id, e.domain, e.trigger_type, e.expected_interval, e.upstream, " +
    "e.max_delay_minutes, e.owner, " +
    "CASE WHEN e.monitored = 1 THEN 'watched' ELSE 'unmonitored' END AS watch, " +
    "s.last_status, s.last_observed_at, s.observation_state " +
    "FROM _ops_pipeline_expectation e LEFT JOIN _ops_pipeline_state s ON s.dag_id = e.dag_id " +
    "WHERE COALESCE(e.updated_at, '') <> 'sample' " +
    "UNION ALL " +
    "SELECT s.dag_id, s.domain, NULL, NULL, NULL, NULL, NULL, 'unregistered', " +
    "s.last_status, s.last_observed_at, s.observation_state " +
    "FROM _ops_pipeline_state s " +
    "WHERE COALESCE(s.updated_at, '') <> 'sample' " +
    "AND NOT EXISTS (SELECT 1 FROM _ops_pipeline_expectation e WHERE e.dag_id = s.dag_id) " +
    "ORDER BY watch, domain, dag_id");
  if (!rdaily.ok || !rexp.ok) missing.push("runs");
  const [rfail, rempty, renv, rslow, rload] = await Promise.all([
    // 실패 목록 — is_final_try 를 그대로 싣는다. 1=최종 실패, 0=재시도 중, NULL=시도 정보 없음
    // (관문 이전 기록). 셋을 뭉개면 "재시도로 살아난 실행"이 실패로 둔갑한다(C-7).
    // log_bundle_key = 그 run 의 텍스트 로그 tar.gz(R2) 위치. 번들이 하루 1회 뒤늦게
    // 올라오므로 **당일 실행은 NULL 이 정상**이다(#7 코멘트 4) — 화면이 그걸 밝힌다.
    safeRows(env, "SELECT observed_date_kst, domain, layer, dag_id, task_id, is_final_try, " +
      "retry_count, error_ref, log_bundle_key FROM _ops_run_event WHERE status = 'failed' " +
      "AND observed_date_kst >= date('now','+9 hours', ?)" + evWhere +
      " ORDER BY observed_at DESC LIMIT 12", kstSince),
    // 빈 실행 = 초록 위장의 일반형 — 성공인데 실측 0행. row_count IS NULL(못 잼)과 다르다(F-3).
    safeRows(env, "SELECT observed_date_kst, domain, layer, dag_id, task_id, rows_source, " +
      "log_bundle_key FROM _ops_run_event WHERE status = 'success' AND row_count = 0 " +
      "AND observed_date_kst >= date('now','+9 hours', ?)" + evWhere +
      " ORDER BY observed_at DESC LIMIT 10", kstSince),
    // 환경 분포 — **여기만 안 거른다.** 거르면 "무엇이 빠졌나"를 보여줄 수가 없다.
    safeRows(env, "SELECT environment, COUNT(*) AS events, COUNT(DISTINCT domain) AS domains, " +
      "MAX(observed_at) AS last_seen FROM _ops_run_event " +
      "WHERE observed_date_kst >= date('now','+9 hours', ?)" +
      " AND event_id NOT LIKE 'smp_%' GROUP BY environment ORDER BY events DESC", kstSince),
    safeRows(env, "SELECT dag_id, task_id, domain, ROUND(schedule_delay_s/60.0,1) AS delay_min, " +
      "ROUND(duration_s/60.0,1) AS dur_min, observed_date_kst FROM _ops_run_event " +
      "WHERE schedule_delay_s IS NOT NULL AND observed_date_kst >= date('now','+9 hours', ?)" + evWhere +
      " ORDER BY schedule_delay_s DESC LIMIT 8", kstSince),
    // 적재 자체의 신선도 + 단계 미기록(layer NULL — 관문 이전 기록) 건수.
    // bundled = 로그 번들이 실제로 붙은 건수 — 0 이면 링크 칸이 왜 비는지 화면이 설명한다.
    safeRows(env, "SELECT COUNT(*) AS total, SUM(layer IS NULL) AS layerless, " +
      "SUM(log_bundle_key IS NOT NULL) AS bundled, " +
      "MAX(ingested_at) AS last_ingest, " +
      // 적재 DAG(common_ops_d1_load)가 3시간 주기라 실시간이 아니다(#7 코멘트 2).
      // "몇 분 전"까지 화면이 알아야 '조용한 것'과 '적재가 멈춘 것'을 가른다.
      "CAST((julianday('now') - julianday(MAX(ingested_at))) * 1440 AS INTEGER) AS ingest_age_min " +
      "FROM _ops_run_event WHERE observed_date_kst >= date('now','+9 hours', ?)" + evWhere, kstSince),
  ]);

  // ── 서빙 (게이트웨이가 쌓는 _gateway_request_log)
  // 서빙 로그 전 질의가 같은 조각을 쓴다 — 한 곳에 두지 않으면 새 질의에서 빠뜨리고,
  // 그게 환경이 조용히 섞이는 경로다(파이프라인에서 배운 것).
  const gwW = gwWhere(env);
  const routes = await safeRows(env,
    "SELECT route, COUNT(*) AS calls, SUM(status >= 400) AS errors, ROUND(AVG(ms),1) AS avg_ms " +
    "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + gwW +
    " GROUP BY route ORDER BY calls DESC", since);
  if (!routes.ok) missing.push("serving");
  const [daily, products, failures, empty, keys] = await Promise.all([
    safeRows(env, "SELECT substr(ts,1,10) AS day, COUNT(*) AS calls, COUNT(DISTINCT key_hash) AS keys_used " +
      "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + gwW +
      " GROUP BY day ORDER BY day", since),
    // 축은 product_id 가 정본, 표명은 폴백. 화면에는 사람이 아는 이름을 내보내야 하므로
    // 표명도 같이 싣는다 — 없으면 화면이 식별자를 그대로 보여준다.
    safeRows(env, "SELECT " + PRODUCT_KEY + " AS product_key, MAX(table_name) AS table_name, " +
      "MAX(product_id) AS product_id, SUM(route = 'preview') AS previews, " +
      "SUM(" + SERVE + ") AS calls, SUM(" + MCP_ONLY + ") AS mcp_calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows FROM _gateway_request_log " +
      "WHERE " + PRODUCT_KEY + " IS NOT NULL AND ts >= datetime('now', ?)" + gwW + " " +
      "GROUP BY product_key ORDER BY calls DESC, previews DESC LIMIT 12", since),
    safeRows(env, "SELECT status, route, table_name, COUNT(*) AS hits FROM _gateway_request_log " +
      "WHERE status >= 400 AND ts >= datetime('now', ?)" + gwW + " GROUP BY status, route, table_name " +
      "ORDER BY hits DESC LIMIT 10", since),
    safeRows(env, "SELECT " + PRODUCT_KEY + " AS product_key, MAX(table_name) AS table_name, " +
      "filters, COUNT(*) AS empty_responses FROM _gateway_request_log " +
      "WHERE status = 200 AND row_count = 0 AND ts >= datetime('now', ?)" + gwW + " " +
      "GROUP BY product_key, filters ORDER BY empty_responses DESC LIMIT 10", since),
    safeRows(env, "SELECT substr(key_hash,1,8) AS key_id, COUNT(*) AS calls, " +
      "COUNT(DISTINCT substr(ts,1,10)) AS active_days FROM _gateway_request_log " +
      "WHERE key_hash IS NOT NULL AND ts >= datetime('now', ?)" + gwW + " GROUP BY key_hash " +
      "ORDER BY calls DESC LIMIT 10", since),
  ]);

  // 화면이 "왜 비었나"에 답할 수 있어야 한다.
  //   none  — 이 기간에 행이 없다
  //   live  — 실측이 있다
  //
  // 예전에는 `sample` 이 하나 더 있었다. 합성 행을 **보여주고 배너로** 알리는 방식이었는데,
  // "이 값으로 판단하지 마세요"를 붙여도 사람은 숫자를 먼저 읽는다 — **화면에 있으면
  // 읽힌다.** 지금은 질의에서 아예 빼므로 이 상태가 존재할 수 없다.
  const pipelineSource = slo.rows.length ? "live" : "none";


  // ── 이용 행동 (행동 로그 스펙 초안 #9 — 콘솔 선반영, decision/0010)
  // 지금 데이터로 답이 되는 것(여정·익명 비중)과 수집 후 점등되는 것(ua_class 등)을 나눈다.
  // 초안 컬럼이 아직 없으면 safeRows 가 실패를 삼키고 그 카드는 '수집 전'으로 남는다 —
  // 콘솔은 게이트웨이 스키마를 만들지도 미러하지도 않는다(0010: ALTER 미러는 정본
  // 마이그레이션과 duplicate column 으로 충돌해 저쪽 시드를 깨뜨린다).
  const [src, pub, funnel, udaily, uclients, uagents, upages, fill, genv] = await Promise.all([
    sources(env),
    publication(env, days),
    safeRows(env,
      "SELECT COUNT(*) AS issued, SUM(first_call IS NOT NULL) AS activated, " +
      "ROUND(AVG(CASE WHEN first_call IS NOT NULL THEN (julianday(first_call) - julianday(created_at)) * 24 END), 1) AS avg_hours_to_first " +
      "FROM (SELECT k.created_at, (SELECT MIN(r.ts) FROM _gateway_request_log r " +
      "WHERE r.key_hash = k.key_hash AND r." + SERVE + gwW.replace(" AND env", " AND r.env") +
      ") AS first_call FROM _keys k)"),
    safeRows(env, "SELECT substr(ts,1,10) AS day, SUM(key_hash IS NOT NULL) AS keyed, " +
      "SUM(key_hash IS NULL) AS anon FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + gwW + " " +
      "GROUP BY day ORDER BY day", since),
    safeRows(env, "SELECT ua_class, COUNT(*) AS calls FROM _gateway_request_log " +
      "WHERE ts >= datetime('now', ?)" + gwW + " AND ua_class IS NOT NULL GROUP BY ua_class ORDER BY calls DESC", since),
    safeRows(env, "SELECT agent_name, agent_mode, COUNT(*) AS calls, SUM(" + SERVE + ") AS data_calls, " +
      "COUNT(DISTINCT " + PRODUCT_KEY + ") AS products FROM _gateway_request_log " +
      "WHERE ts >= datetime('now', ?)" + gwW + " AND agent_name IS NOT NULL " +
      "GROUP BY agent_name, agent_mode ORDER BY calls DESC LIMIT 10", since),
    // ⚠️ 예전에는 `route = 'page'` 로 걸렀는데 **게이트웨이 라우터에 그런 값이 없다** —
    // 조건이 아니라 오타에 가까웠고, 그래서 이 카드는 구조적으로 영원히 비었다(#63 ④).
    // 지금은 컬럼만 본다. `page_path` 는 `0005` 에 있지만 게이트웨이 `LOG_COLUMNS` 에 아직
    // 없어 채워지지 않는다 — 그 사실은 아래 `fill` 이 실측으로 말한다.
    safeRows(env, "SELECT page_path, COUNT(*) AS hits FROM _gateway_request_log " +
      "WHERE ts >= datetime('now', ?)" + gwW + " AND page_path IS NOT NULL " +
      "GROUP BY page_path ORDER BY hits DESC LIMIT 12", since),
    // 행동 축이 '아직 안 온 것'인지 '와서 0인 것'인지는 컬럼 존재만으로 못 가른다. 창 안에서
    // 실제로 채워진 행 수를 세어, 화면이 "게이트웨이가 아직 안 싣는다"를 근거 있게 말하게
    // 한다(agreement §4 모른다 ≠ 0). 게이트웨이가 싣기 시작하면 이 안내는 저절로 꺼진다.
    safeRows(env, "SELECT COUNT(*) AS total, SUM(ua_class IS NOT NULL) AS ua_class, " +
      "SUM(agent_name IS NOT NULL) AS agent_name, SUM(page_path IS NOT NULL) AS page_path, " +
      "SUM(intent IS NOT NULL) AS intent, SUM(product_id IS NOT NULL) AS product_id, " +
      "SUM(" + MCP_ONLY + ") AS mcp_calls " +
      "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + gwW, since),
    // 환경 분포 — **스코프를 걸지 않는다.** 걸면 "무엇을 뺐는지"를 셀 수 없다.
    // NULL 은 '(미상)' 으로 따로 센다 — 운영으로 채우지 않는다(ASAC-DAG#692).
    safeRows(env, "SELECT COALESCE(env, '(미상)') AS env, COUNT(*) AS calls " +
      "FROM _gateway_request_log WHERE ts >= datetime('now', ?) GROUP BY env ORDER BY calls DESC", since),
  ]);
  // 행동 축이 **아직 안 오는 것**인지 **와서 0인 것**인지. 컬럼이 있어도 게이트웨이가 안 실으면
  // 질의는 성공하고 0행이 나와, 화면은 "데이터 없음"이라 말한다 — 그건 틀린 말이다.
  // 실측 건수로 판정하므로 게이트웨이가 싣기 시작하면 이 안내가 저절로 꺼진다.
  const F = fill.ok ? (fill.rows[0] || {}) : null;
  const unfilled = (col) => (F ? (F.total > 0 && !F[col]) : false);

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    meta: {
      // pub.ok 는 위 Promise.all 에서 이미 판정됐다. 표가 없으면 그 섹션만 비우고
      // 화면이 '연결되지 않음'으로 밝힌다 — 콘솔은 죽지 않는다(safeRows 강등).
      missing: pub.ok ? missing : [...missing, "publication"],
      can_write: writable,
      // 이 콘솔이 지금 어느 환경의 무슨 DB 를 보고 있나. 숫자만 보고 추측하게 두면
      // 로컬 샘플을 운영 실적으로 오해하는 사고가 난다(wrangler.toml [vars]).
      env: { label: env.ENV_LABEL || "알 수 없음", d1: env.ENV_D1 || "알 수 없음" },
      // 샘플이 한 행이라도 섞여 있으면 화면 전체에 배지를 띄운다 — 조용히 섞이는 게 제일 나쁘다
      pipeline_source: pipelineSource,
      // 실행 기록을 어느 환경 것만 셌나 + 그래서 몇 건이 빠졌나. 걸러 놓고 말을 안 하면
      // "숫자가 왜 이렇지"가 되고, 그건 필터를 안 건 것만큼 나쁘다(#78 Z-7).
      runs_env_scope: envCol,
      runs_env_excluded: envCol
        ? renv.rows.filter((r) => r.environment !== envCol)
                   .reduce((n, r) => n + (r.events || 0), 0)
        : 0,
      // 어디까지 걸렀나. 기록 단위(_ops_run_event)는 걸렀지만 집계표는 컬럼이 없어 못 걸렀다 —
      // "다 걸렀다"고 오해하면 KPI 를 운영 수치로 읽게 되므로 범위를 정확히 밝힌다.
      runs_env_scope_partial: Boolean(envCol),
      // 적재 주기는 3시간(common_ops_d1_load) — 실시간이 아니다. 화면이 이 값을 알아야
      // "조용한 파이프라인"과 "적재가 멈춘 것"을 가른다(#7 코멘트 2).
      runs_ingest_cycle_min: 180,
      // 로그 테이블은 있는데 초안 컬럼만 없다 = 스펙 반영 전 (테이블 자체가 없으면 serving 누락으로 이미 표시)
      usage_spec_pending: routes.ok && !uclients.ok,
      // ── #63 route 계약 ──────────────────────────────────────────────────
      // **데이터 서빙으로 센 문**과 **못 가른 것**을 화면이 그대로 말할 수 있게 싣는다.
      // MCP 는 `route='mcp'` 한 값이라 데이터 질의와 목록 조회가 갈리지 않는다(#62) —
      // 그래서 아래 집계에서 뺐고, 뺀 건수를 여기 적는다. 침묵하면 "MCP 는 안 쓰인다"로 읽힌다.
      // ── #64 환경 스코프 ─────────────────────────────────────────────────
      // 서빙 수치가 **한 환경의 것임을 보장**하고, 무엇을 뺐는지 같이 말한다.
      // 침묵하면 "숫자가 왜 이렇지"가 되고, 그건 필터를 안 건 것만큼 나쁘다(decision/0012).
      serving_env_scope: envCol,
      serving_env_mix: genv.ok ? genv.rows : [],
      serving_env_excluded: envCol
        ? genv.rows.filter((r) => r.env !== envCol).reduce((a, r) => a + (r.calls || 0), 0)
        : 0,
      // `env IS NULL` 은 운영으로 채우지 않는다 — 없는 정보를 운영이라 단정하면 로컬
      // 실행이 운영으로 보인다(ASAC-DAG#692). 따로 세어 화면이 그대로 말한다.
      serving_env_unknown: genv.ok
        ? (genv.rows.find((r) => r.env === "(미상)")?.calls || 0)
        : 0,
      serve_routes: ["data", "skill_data"],
      mcp_calls: F ? (F.mcp_calls || 0) : null,
      // 창 안에서 그 축이 한 번이라도 채워졌나 — 카드가 "게이트웨이 미발행"을 말하는 근거다.
      axes_unfilled: F
        ? ["ua_class", "agent_name", "page_path", "intent", "product_id"].filter(unfilled)
        : [],
    },
    pipeline: { domains: domains.rows, slo: slo.rows },
    runs: { daily: rdaily.rows, expectations: rexp.rows, failures: rfail.rows,
            empty_runs: rempty.rows, environments: renv.rows, slowest: rslow.rows,
            load: rload.rows[0] || null },
    serving: { routes: routes.rows, daily: daily.rows, products: products.rows,
               failures: failures.rows, empty: empty.rows, keys: keys.rows },
    usage: { funnel: funnel.ok ? funnel.rows[0] : null, daily: udaily.rows,
             // pending — 컬럼 자체가 없다(질의 실패). unfilled — 컬럼은 있는데 게이트웨이가
             // 아직 안 싣는다. 둘을 뭉치면 "곧 온다"와 "안 온다"가 구분되지 않는다.
             clients: { pending: !uclients.ok, unfilled: unfilled("ua_class"), rows: uclients.rows },
             agents: { pending: !uagents.ok, unfilled: unfilled("agent_name"), rows: uagents.rows },
             pages: { pending: !upages.ok, unfilled: unfilled("page_path"), rows: upages.rows } },
    // 발행 점검 — #78 D-7 이 요구한 지표. 여기가 비면 "발행이 다 성공한 것처럼" 보인다.
    publication: pub,
    // 화면의 숫자가 왜 그 모양인지는 **표를 읽었는지**에서 갈린다. meta.missing 한 줄로는
    // "없다"와 "이름은 같은데 남의 표다"가 구분되지 않아 진단을 따로 싣는다(아래 sources()).
    sources: src,
  });
}

// ── 데이터 소스 진단 ──────────────────────────────────────────────────────────────
// 이 콘솔의 존재 이유 절반은 **관측 공백을 드러내는 것**이다(direction.md). 그런데 지금까지
// "표를 못 읽었다"는 meta.missing 한 줄로만 나갔고, 화면은 "왜 못 읽었나"를 말하지 못했다.
// 없는 것(표 자체가 없음)과 다른 것(이름은 같은데 스키마가 다름)은 조치가 완전히 다른데
// 화면에서는 똑같이 "비어 있음"으로 보였다 — 실측에서 실제로 그 상태였다.
//
// 그래서 콘솔이 읽는 표를 하나씩 진단해 **지표로** 내보낸다. 없으면 없다고, 스키마가
// 어긋나면 어느 컬럼이 없는지까지.
// 표마다 **어느 탭이 쓰고, 그 데이터가 어디에 사는지**를 같이 적는다.
//
// 화면이 비었을 때 "데이터 없음"만 띄우면 운영자는 원인을 못 찾는다. 이 리포는 환경이
// 둘로 갈려 있어서 특히 그렇다 — **파이프라인은 원격 D1 에만 쓰고, 게이트웨이는 아직
// 로컬에만 쓴다.** 그래서 로컬에서 실행 기록이 비고, 운영에서 응답 상태가 빈다.
// 둘 다 정상인데 화면이 그걸 말하지 못하면 "콘솔이 고장났나"로 읽힌다.
//
//   home: "remote" 파이프라인이 원격에 쓴다 — 로컬에는 표만 있고 0행이다
//         "local"  게이트웨이가 로컬에 쓴다 — 배포 전이라 원격에는 표가 없다
//         "both"   양쪽에 있다
const SOURCES = [
  { table: "_ops_run_event", owner: "파이프라인", home: "remote", pane: ["runs"],
    need: ["observed_date_kst", "domain", "status"], used: "실행 기록" },
  { table: "_ops_daily_metric", owner: "파이프라인", home: "remote", pane: ["runs"],
    need: ["observed_date_kst", "domain", "layer", "event_count"], used: "실행 기록(집계)" },
  { table: "_ops_pipeline_state", owner: "파이프라인", home: "remote", pane: ["runs"],
    need: ["dag_id", "last_status", "observation_state"], used: "감시 대상 DAG" },
  { table: "_ops_pipeline_expectation", owner: "파이프라인", home: "remote", pane: ["runs"],
    need: ["dag_id", "monitored"], used: "실행 주기 등록" },
  { table: "_publication_ledger", owner: "파이프라인", home: "remote", pane: ["pipeline"],
    need: ["product_id", "outcome", "stage", "published_row_count", "d1_row_count"],
    used: "발행 점검" },
  { table: "_publication_log", owner: "파이프라인", home: "remote", pane: ["pipeline"],
    need: ["product_id", "published_at", "serving_status"], used: "발행 점검(성공 대장)" },
  // 옛 이름 `_request_log` 는 transit 워커 소유로 남았다(agreement §2) — 콘솔은 더 읽지 않는다.
  { table: "_gateway_request_log", owner: "게이트웨이", home: "local", pane: ["serving", "usage", "apis"],
    need: ["ts", "route", "status", "table_name", "key_hash", "product_id", "env"],
    used: "응답 상태 · 이용 행동 · API 사용량" },
  { table: "_keys", owner: "게이트웨이", home: "local", pane: ["keys", "usage"],
    need: ["key_hash", "email", "status", "daily_quota"], used: "이용자 키" },
  { table: "_catalog", owner: "도메인 export", home: "both", pane: ["apis"],
    need: ["name", "product_id", "external"], used: "API 사용량" },
  { table: "_ops_slo", owner: "콘솔", home: "both", pane: ["pipeline"],
    need: ["domain", "event_date"], used: "품질 기준(SLO)" },
  { table: "_ops_domain", owner: "콘솔", home: "both", pane: ["pipeline"],
    need: ["domain", "label", "has_slo"], used: "분야 등록부" },
];


async function sources(env) {
  const out = await Promise.all(SOURCES.map(async (s) => {
    // 표 이름은 상수 목록에서만 오므로 사용자 입력이 SQL 로 가지 않는다.
    const cols = await safeRows(env, `SELECT name FROM pragma_table_info('${s.table}')`);
    const have = new Set(cols.rows.map((c) => c.name));
    const exists = have.size > 0;
    const missingCols = exists ? s.need.filter((c) => !have.has(c)) : s.need;
    // 스키마가 어긋나면 COUNT 도 의미가 없지만, "행은 쌓이고 있다"는 사실 자체가 신호다
    // (이름을 선점한 다른 표가 실제로 운영 중인지 아닌지가 갈린다).
    const cnt = exists ? await safeRows(env, `SELECT COUNT(*) AS n FROM "${s.table}"`) : null;
    return {
      table: s.table, owner: s.owner, used: s.used, home: s.home, pane: s.pane,
      exists,
      // 셋으로 가른다 — 조치가 각각 다르다.
      //   ok        읽을 수 있다
      //   mismatch  표는 있는데 필요한 컬럼이 없다 (이름 충돌 / 다른 주인)
      //   absent    표가 아예 없다 (아직 안 만들었다)
      state: !exists ? "absent" : (missingCols.length ? "mismatch" : "ok"),
      missing_columns: missingCols,
      rows: cnt && cnt.ok && cnt.rows[0] ? cnt.rows[0].n : null,
    };
  }));
  return out;
}

// ── 발행 점검 ─────────────────────────────────────────────────────────────────────
//
// ASK-Seoul#78 `D-7` 이 화면에 요구한 지표 중 **"발행 점검 상태"** 가 이것이다.
// 정본은 ASAC-DAG 의 `_publication_ledger`(시도 대장)·`_publication_log`(성공 대장)이고
// 콘솔은 **읽기만** 한다.
//
// 왜 필요한가 — 지금까지 이 표를 질의조차 안 해서 **화면은 발행이 다 성공한 것처럼
// 보였다.** 실측(운영, 2026-08-04): 시도 4,718건 중 **실패 60 · 열화 439 · 행수 불일치 63**.
// 그리고 실패 60건 중 **56건이 traffic 한 도메인**이다 — 뭉뚱그리면 안 보이는 신호다.
//
// 도메인 축은 `product_id` 접두사다(`traffic_flow_…` → traffic). 파이프라인이 그 규칙으로
// 발행하고 `_catalog` 와 같은 규약이라, 별도 컬럼이나 매핑 표를 두지 않는다(DOMAIN_EXPR 참고).
const PUB_DOMAIN = "substr(product_id, 1, instr(product_id, '_') - 1)";

async function publication(env, days) {
  const since = `-${days} days`;

  const [byDomain, byStage, worst, mismatch, recent, byDay] = await Promise.all([
    // 분야별 rollup. **전체 합계는 화면에서 SUM 한다** — 같은 것을 두 번 묻지 않는다.
    safeRows(env,
      "SELECT " + PUB_DOMAIN + " AS domain, COUNT(*) AS attempts, " +
      "SUM(outcome = 'published') AS published, SUM(outcome = 'degraded') AS degraded, " +
      "SUM(outcome = 'failed') AS failed, SUM(outcome = 'skipped_retained') AS skipped, " +
      "SUM(published_row_count <> d1_row_count) AS row_mismatch, " +
      "COUNT(DISTINCT product_id) AS products, MAX(attempted_at) AS last_at " +
      "FROM _publication_ledger WHERE attempted_at >= datetime('now', ?) " +
      "GROUP BY domain ORDER BY attempts DESC", since),
    // 어느 **단계**에서 깨지나 — write / read_back / source_primary_key / gate.
    // 실패를 한 덩어리로 세면 "쓰다 실패"와 "쓰고 나서 확인 실패"가 같아 보인다.
    safeRows(env,
      "SELECT outcome, stage, COUNT(*) AS n, MAX(attempted_at) AS last_at " +
      "FROM _publication_ledger WHERE attempted_at >= datetime('now', ?) " +
      "AND outcome <> 'published' GROUP BY outcome, stage ORDER BY n DESC", since),
    // 어느 **제품**에 몰렸나. reason 은 표에 안 싣고 title 로만 쓴다(화면 문구 규약).
    safeRows(env,
      "SELECT product_id, " + PUB_DOMAIN + " AS domain, outcome, stage, COUNT(*) AS n, " +
      "MAX(attempted_at) AS last_at, MAX(reason) AS reason " +
      "FROM _publication_ledger WHERE attempted_at >= datetime('now', ?) " +
      "AND outcome IN ('failed', 'degraded') " +
      "GROUP BY product_id, outcome, stage ORDER BY n DESC LIMIT 12", since),
    // 행수 불일치 — 세 숫자(원본·발행·D1)가 어긋난다. 어느 게 맞는지는 콘솔이 판단하지 않고
    // **그대로 드러낸다**(F-3: 모르는 것을 지어내지 않는다).
    safeRows(env,
      "SELECT product_id, " + PUB_DOMAIN + " AS domain, source_row_count, published_row_count, " +
      "d1_row_count, api_smoke_status, rollback_status, attempted_at " +
      "FROM _publication_ledger WHERE attempted_at >= datetime('now', ?) " +
      "AND published_row_count <> d1_row_count ORDER BY attempted_at DESC LIMIT 10", since),
    // 마지막 성공 발행 — 성공 대장은 행이 적어 단독 카드로 두지 않고 각주로 쓴다.
    safeRows(env,
      "SELECT product_id, published_at, serving_status, published_row_count, " +
      "published_bytes, publication_mode FROM _publication_log " +
      "ORDER BY published_at DESC LIMIT 5"),
    // 일자×도메인 — 안정성 추이 히트맵의 발행 축. attempted_at 은 UTC 라 **KST 로 접는다**
    // (+9 hours). 실행 축(observed_date_kst)과 날짜 규약이 다르면 같은 칸에 다른 날이 섞인다.
    safeRows(env,
      "SELECT date(attempted_at, '+9 hours') AS day, " + PUB_DOMAIN + " AS domain, " +
      "COUNT(*) AS attempts, SUM(outcome = 'failed') AS failed, " +
      "SUM(outcome = 'degraded') AS degraded, " +
      "SUM(published_row_count <> d1_row_count) AS row_mismatch " +
      "FROM _publication_ledger WHERE attempted_at >= datetime('now', ?) " +
      "GROUP BY day, domain", since),
  ]);

  return {
    ok: byDomain.ok,
    by_domain: byDomain.rows, by_stage: byStage.rows,
    worst: worst.rows, row_mismatch: mismatch.rows, recent_published: recent.rows,
    by_day: byDay.rows,
  };
}

// ── 이용자 키 — 날짜 구간과 필터 ─────────────────────────────────────────────────
//
// 창(window)을 **사람이 정하게** 한다. 지금까지 키 목록은 `days` 창과 무관하게 전량이었고,
// "이 달에 발급된 키만" 같은 질문에 답할 수 없었다.
//
// 구간 규칙(빠뜨리면 화면이 조용히 이상해지는 자리라 서버가 강제한다):
//   · 시작일 없음 → 종료일 기준 **최근 1개월**
//   · 종료일 없음 → **오늘**(KST). 오늘을 넘기는 값은 오늘로 접는다 — 미래 구간은 언제나 0건이라
//     "데이터가 없다"로 보이는데, 실제로는 **물어본 구간이 틀린 것**이다
//   · 시작일은 **최대 1년 전**까지. 그보다 앞이면 1년 전으로 접는다
//   · 시작 > 종료면 뒤집는다(사람이 달력에서 거꾸로 고르는 일이 잦다)
//
// 잘라낸 사실은 응답 `meta.clamped` 로 알린다 — 조용히 바꾸면 화면 숫자를 못 믿게 된다.
const KEY_FILTERS = new Set(["all", "called", "uncalled", "revoked", "over_quota"]);

function keyWindow(params) {
  // 하루 경계는 KST — 게이트웨이 kstDay() 와 같은 규약이어야 쿼터 숫자가 맞는다
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const minKst = new Date(Date.now() + 9 * 3600 * 1000 - 365 * 86400 * 1000)
    .toISOString().slice(0, 10);
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;

  const clamped = [];
  let to = ok(params.get("to")) || todayKst;
  if (to > todayKst) { to = todayKst; clamped.push("종료일을 오늘로 맞췄습니다"); }

  let from = ok(params.get("from"));
  if (!from) {
    // 기본 창 = 종료일 기준 한 달. 달 길이가 달라도 사람이 기대하는 건 "한 달 전 같은 날"이다.
    const d = new Date(to + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - 1);
    from = d.toISOString().slice(0, 10);
  }
  if (from < minKst) { from = minKst; clamped.push("시작일을 1년 전으로 맞췄습니다"); }
  if (from > to) { const t = from; from = to; to = t; clamped.push("시작·종료를 뒤집었습니다"); }

  return { from, to, clamped, today: todayKst, min: minKst };
}

async function keys(env, params, writable) {
  const w = keyWindow(params);
  // 키의 호출 수도 같은 환경만 센다 — 목록은 운영인데 호출 수가 로컬까지 합쳐지면
  // 두 숫자가 서로를 설명하지 못한다(#64).
  const gwW = gwWhere(env);
  const filter = KEY_FILTERS.has(params.get("filter")) ? params.get("filter") : "all";

  // 발급일이 구간 안인 키를 센다. 사용량·요청 수도 **같은 구간**으로 자른다 —
  // 목록은 한 달인데 합계가 전체이면 두 숫자가 서로를 설명하지 못한다.
  const rows = await safeRows(env,
    "SELECT k.key_hash, k.key_prefix, k.status, k.daily_quota, k.created_at, " +
    // 이메일 원문은 응답에 싣지 않는다(decision/0004) — 서버에서 가린다
    "substr(k.email, 1, 2) || '***@' || substr(k.email, instr(k.email, '@') + 1) AS email_masked, " +
    "COALESCE(u.used_today, 0) AS used_today, " +
    "COALESCE(r.calls, 0) AS calls, r.last_call, r.first_data_call " +
    "FROM _keys k " +
    "LEFT JOIN (SELECT key_hash, count AS used_today FROM _usage " +
    "           WHERE day = date('now','+9 hours')) u ON u.key_hash = k.key_hash " +
    "LEFT JOIN (SELECT key_hash, COUNT(*) AS calls, MAX(ts) AS last_call, " +
    "                  MIN(CASE WHEN " + SERVE + " THEN ts END) AS first_data_call " +
    "           FROM _gateway_request_log " +
    "           WHERE date(ts, '+9 hours') BETWEEN ? AND ?" + gwW + " GROUP BY key_hash) r " +
    "       ON r.key_hash = k.key_hash " +
    "WHERE date(k.created_at, '+9 hours') BETWEEN ? AND ? " +
    "ORDER BY k.created_at DESC LIMIT 500",
    w.from, w.to, w.from, w.to);

  if (!rows.ok) {
    return json({ window: w, filter, keys: [], counts: null,
      meta: { can_write: writable, missing: ["keys"], clamped: w.clamped } });
  }

  // 필터는 서버가 아니라 **여기서** 건다 — 같은 응답으로 개수를 다 세야 화면이 각 버튼 옆에
  // 건수를 띄울 수 있다. 500행 상한이라 비용이 문제되지 않는다.
  const all = rows.rows;
  const isCalled = (r) => r.first_data_call != null;
  const counts = {
    all: all.length,
    called: all.filter(isCalled).length,
    uncalled: all.filter((r) => !isCalled(r)).length,
    revoked: all.filter((r) => r.status === "revoked").length,
    over_quota: all.filter((r) => r.used_today >= r.daily_quota).length,
  };
  const pick = {
    all: () => all,
    called: () => all.filter(isCalled),
    uncalled: () => all.filter((r) => !isCalled(r)),
    revoked: () => all.filter((r) => r.status === "revoked"),
    over_quota: () => all.filter((r) => r.used_today >= r.daily_quota),
  }[filter];

  return json({
    window: w, filter, counts, keys: pick(),
    meta: { can_write: writable, missing: [], clamped: w.clamped },
  });
}

// ── 하루 드릴다운 — 추이에서 튀는 칸을 눌렀을 때 "무슨 작업이 그랬나" ────────────
//
// 화면이 요약(집계표·발행 대장)에서 이상을 보여주면, 원인은 기록 단위(_ops_run_event ·
// _publication_ledger 의 행)에 있다. 그 연결을 운영자가 SQL 로 하게 두지 않는 것이 이 경로다.
// 읽기 전용이고, 요약과 **같은 환경 필터**를 쓴다 — 요약에 안 보이던 행이 여기서 튀어나오면
// 두 화면이 서로를 못 믿게 된다.
async function domainDay(env, params) {
  const domain = (params.get("domain") || "").trim();
  const day = (params.get("day") || "").trim();
  // 형식 검증 — 어차피 바인딩으로 넘기지만, 어긋난 요청은 일찍 돌려보낸다
  if (!/^[a-z0-9_]{1,40}$/.test(domain))
    return problem(400, "invalid domain", "도메인은 소문자·숫자·밑줄 40자 이내");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    return problem(400, "invalid day", "YYYY-MM-DD 형식으로 보낼 것");

  // summary 와 같은 환경 필터(§6-2) — 값은 상수 목록에서만 온다
  const envW = ({ prod: " AND environment = 'prod'", dev: " AND environment = 'dev'" })[
    String(env.ENV_SCOPE || "").trim()] || "";

  const [fails, empties, retried, slow, pubs, metric] = await Promise.all([
    safeRows(env,
      "SELECT dag_id, task_id, layer, is_final_try, retry_count, error_ref, log_bundle_key, " +
      "observed_at FROM _ops_run_event WHERE domain = ? AND observed_date_kst = ? " +
      "AND status = 'failed'" + envW + " ORDER BY observed_at DESC LIMIT 30", domain, day),
    safeRows(env,
      "SELECT dag_id, task_id, layer, rows_source, observed_at FROM _ops_run_event " +
      "WHERE domain = ? AND observed_date_kst = ? AND status = 'success' AND row_count = 0" +
      envW + " ORDER BY observed_at DESC LIMIT 20", domain, day),
    // 재시도 끝에 성공 — 성공률에 안 잡히는 열화. 살아났다는 사실보다 "몇 번 만에"가 신호다.
    safeRows(env,
      "SELECT dag_id, task_id, layer, retry_count, observed_at FROM _ops_run_event " +
      "WHERE domain = ? AND observed_date_kst = ? AND status = 'success' AND retry_count > 0" +
      envW + " ORDER BY retry_count DESC, observed_at DESC LIMIT 20", domain, day),
    safeRows(env,
      "SELECT dag_id, task_id, layer, ROUND(duration_s / 60.0, 1) AS dur_min, " +
      "ROUND(schedule_delay_s / 60.0, 1) AS delay_min FROM _ops_run_event " +
      "WHERE domain = ? AND observed_date_kst = ? AND duration_s IS NOT NULL" + envW +
      " ORDER BY duration_s DESC LIMIT 8", domain, day),
    // 발행 대장은 UTC 라 KST 로 접는다 — 히트맵 축과 같은 규약이어야 칸과 내용이 맞는다
    safeRows(env,
      "SELECT product_id, outcome, stage, reason, attempted_at, source_row_count, " +
      "published_row_count, d1_row_count FROM _publication_ledger " +
      "WHERE " + PUB_DOMAIN + " = ? AND date(attempted_at, '+9 hours') = ? " +
      "AND (outcome IN ('failed', 'degraded') OR published_row_count <> d1_row_count) " +
      "ORDER BY attempted_at DESC LIMIT 30", domain, day),
    safeRows(env,
      "SELECT layer, event_count, success_count, failed_count, degraded_count, " +
      "retried_run_count, empty_run_count, rows_unknown_count, duration_s_sum, row_count_sum " +
      "FROM _ops_daily_metric WHERE domain = ? AND observed_date_kst = ? ORDER BY layer",
      domain, day),
  ]);

  return json({
    domain, day,
    fails: fails.rows, empty_runs: empties.rows, retried: retried.rows, slow: slow.rows,
    publications: pubs.rows, metric: metric.rows,
    meta: { runs_ok: fails.ok, pub_ok: pubs.ok },
  });
}

// ── API 사용 현황 ─────────────────────────────────────────────────────────────────
// "어떤 API 가 얼마나 쓰이나"를 API 단위·도메인 단위로 본다. 위의 서빙 품질이 "잘 나가고
// 있나"(실패·0행)를 본다면 여기는 "무엇이 쓰이나"(수요)를 본다.
//
// 도메인은 별도 컬럼이 아니라 _catalog.product_id 의 접두사다(commerce_age_band → commerce).
// 파이프라인이 그 규칙으로 발행하고 _ops_domain 의 6개 도메인과 그대로 맞는다 —
// 도메인 컬럼을 새로 만들거나 매핑 테이블을 두지 않는 이유다.
const DOMAIN_EXPR = "substr(c.product_id, 1, instr(c.product_id, '_') - 1)";

// 카탈로그를 왼쪽에 둔다 — **호출이 0인 API 도 목록에 나와야** "전체 리스트"가 된다.
// 한 번도 안 불린 제품이야말로 알아야 하는 정보다.
async function usage(env, params) {
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(params.get("days"), 10) || DEFAULT_DAYS));
  const since = `-${days} days`;
  const gwW = gwWhere(env);

  const [apis, domains, monthly] = await Promise.all([
    safeRows(env,
      "SELECT c.name, c.product_id, " + DOMAIN_EXPR + " AS domain, c.description, c.row_count AS rows_total, " +
      "COUNT(r.rowid) AS calls, " +
      "COALESCE(SUM(r." + SERVE + "), 0) AS data_calls, " +
      "COALESCE(SUM(r.route = 'preview'), 0) AS previews, " +
      "COALESCE(SUM(r." + MCP_ONLY + "), 0) AS mcp_calls, " +
      "COALESCE(SUM(r.status >= 400), 0) AS errors, " +
      "COALESCE(SUM(r.status = 200 AND r.row_count = 0), 0) AS empty_hits, " +
      "ROUND(AVG(r.ms), 1) AS avg_ms, MAX(r.ts) AS last_call " +
      "FROM _catalog c LEFT JOIN _gateway_request_log r " +
      "  ON " + CATALOG_JOIN + " AND r.ts >= datetime('now', ?)" + gwW.replace(" AND env", " AND r.env") + " " +
      "GROUP BY c.name ORDER BY calls DESC, c.name", since),
    // 도메인 비율 — 분모는 '카탈로그에 잡히는 호출'이다. catalog·me 처럼 제품이 없는 라우트는
    // 도메인에 귀속되지 않으므로 여기서 빠진다(화면에 그 사실을 적는다).
    safeRows(env,
      "SELECT " + DOMAIN_EXPR + " AS domain, COUNT(DISTINCT c.name) AS api_count, " +
      "COUNT(r.rowid) AS calls, COUNT(DISTINCT " + PRODUCT_KEY_R + ") AS apis_used, " +
      "COALESCE(SUM(r.status >= 400), 0) AS errors " +
      "FROM _catalog c LEFT JOIN _gateway_request_log r " +
      "  ON " + CATALOG_JOIN + " AND r.ts >= datetime('now', ?)" + gwW.replace(" AND env", " AND r.env") + " " +
      "GROUP BY domain ORDER BY calls DESC, domain", since),
    // 월별 — _gateway_request_log 는 30일 보존이라 실제로 잡히는 건 최대 두 달 조각이다.
    // 그래도 내보내는 이유는 "지금 보이는 게 전부"라는 사실을 화면이 말해줄 수 있어서다.
    safeRows(env,
      "SELECT substr(r.ts,1,7) AS month, " + DOMAIN_EXPR + " AS domain, COUNT(*) AS calls " +
      "FROM _gateway_request_log r JOIN _catalog c ON " + CATALOG_JOIN + " " +
      "WHERE r.ts >= datetime('now', ?)" + gwW.replace(" AND env", " AND r.env") +
      " GROUP BY month, domain ORDER BY month, calls DESC", since),
  ]);

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    meta: {
      missing: apis.ok ? [] : ["usage"],
      // 요청 값·응답 본문은 애초에 저장하지 않는다(수집 원칙 ①·②). 화면이 "없는 게 아니라
      // 안 남긴 것"이라고 말할 수 있도록 서버가 명시한다 — 사용자가 버그로 오해하지 않게.
      detail_scope: "filters_axis_only",
      log_retention_days: 30,
    },
    domains: domains.rows,
    apis: apis.rows,
    monthly: monthly.rows,
  });
}

// 개별 API 상세. 값이 아니라 **축**을 보여준다 — 어떤 필터 조합으로 들어와서 몇 행이 나갔나.
async function usageDetail(env, name, params) {
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(params.get("days"), 10) || DEFAULT_DAYS));
  const since = `-${days} days`;

  // 사용자 입력이 테이블명으로 도는 유일한 지점 — 카탈로그 존재 확인으로 화이트리스트한다
  // (게이트웨이 쪽과 같은 규약). 바인딩이라 주입은 아니지만, 없는 이름을 404 로 끊는 게 맞다.
  const product = await env.DB.prepare(
    "SELECT name, product_id, description, row_count, time_axis, columns FROM _catalog WHERE name = ?")
    .bind(name).first().catch(() => null);
  if (!product) return problem(404, "unknown api", "카탈로그에 없는 API 다");

  // 목록과 같은 축으로 찾는다. 상세로 들어오는 값은 표명(`_catalog.name`)이지만 로그에는
  // `product_id` 로만 남은 행이 있다(스킬·MCP) — 표명으로만 찾으면 상세에서만 사라져
  // 목록과 숫자가 어긋난다. 카탈로그에서 방금 읽은 `product_id` 를 두 번째 열쇠로 쓴다.
  // 상세도 목록과 같은 환경만 본다 — 안 그러면 상세 합이 목록보다 커진다(#64).
  const KEY_W = gwWhere(env) + " AND (table_name = ? OR product_id = ?) ";
  const K = [name, product.product_id || name];

  const [daily, filters, statuses, recent] = await Promise.all([
    safeRows(env, "SELECT substr(ts,1,10) AS day, COUNT(*) AS calls, " +
      "SUM(status >= 400) AS errors, ROUND(AVG(row_count),1) AS avg_rows " +
      "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + KEY_W + "GROUP BY day ORDER BY day",
      since, ...K),
    // 필터 '축' — 컬럼명 조합이다. 값은 저장하지 않으므로 여기 나올 수 없다.
    safeRows(env, "SELECT COALESCE(filters, '') AS filters, COUNT(*) AS calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows, SUM(status = 200 AND row_count = 0) AS empty_hits " +
      "FROM _gateway_request_log WHERE ts >= datetime('now', ?)" + KEY_W +
      "GROUP BY filters ORDER BY calls DESC LIMIT 20", since, ...K),
    safeRows(env, "SELECT status, route, COUNT(*) AS calls FROM _gateway_request_log " +
      "WHERE ts >= datetime('now', ?)" + KEY_W + "GROUP BY status, route ORDER BY calls DESC",
      since, ...K),
    safeRows(env, "SELECT ts, route, status, COALESCE(filters,'') AS filters, row_count, ms, " +
      "request_id, substr(key_hash,1,8) AS key_id FROM _gateway_request_log " +
      "WHERE ts >= datetime('now', ?)" + KEY_W + "ORDER BY ts DESC LIMIT 50", since, ...K),
  ]);

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    // columns 는 카탈로그가 가진 '이 제품이 어떤 컬럼을 가졌나'다 — 필터 축을 읽을 때의 사전.
    api: { ...product, domain: String(product.product_id || "").split("_")[0] },
    meta: { detail_scope: "filters_axis_only", log_retention_days: 30 },
    daily: daily.rows, filters: filters.rows, statuses: statuses.rows, recent: recent.rows,
  });
}

// ── 키 관리 ───────────────────────────────────────────────────────────────────────
// 게이트웨이가 발급한 키를 운영자가 보고 손대는 자리. 게이트웨이의 셀프 폐기(DELETE /api/keys)와
// 다른 점은 **키 원문 없이** 처리한다는 것 — 이용자는 키를 잃어버려도 우리는 조치할 수 있어야 한다.
//
// 식별자는 key_prefix 가 아니라 key_hash 다. prefix 는 8자(ask_+4hex)라 충돌할 수 있고,
// 엉뚱한 사람의 키를 폐기하는 사고는 되돌리기 어렵다. hash 는 자격증명이 아니다 —
// 인증에는 원문이 필요하므로 해시를 알아도 호출할 수 없다.
const HASH_RE = /^[0-9a-f]{64}$/;
const MIN_QUOTA = 0, MAX_QUOTA = 1000000;

// 이메일은 **응답에서** 가린다. 화면에서만 가리면 API 응답·개발자도구·curl 에 원문이 그대로
// 남아서 가린 게 아니다. 운영자가 실제로 필요한 건 "어느 행이 누구 것인지 구분"이지 주소 자체가
// 아니고, 조치는 전부 key_hash 로 돈다 — 그래서 원문을 내보낼 이유가 없다.
// 정말로 전체 주소가 필요한 드문 경우는 D1 을 직접 조회한다(운영자는 DB 접근 권한이 있다).
function maskEmail(email) {
  const s = String(email || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return "***";                       // 이메일 형태가 아니면 통째로 가린다
  const local = s.slice(0, at);
  return local.slice(0, Math.min(2, local.length)) + "***@" + s.slice(at + 1);
}
async function keyAction(env, request) {
  let body;
  try { body = await request.json(); } catch { return problem(400, "invalid body", "JSON 본문이 필요하다"); }
  const { action, key_hash: hash } = body || {};
  if (!HASH_RE.test(String(hash || ""))) return problem(400, "invalid key", "key_hash 형식이 아니다");

  const row = await env.DB.prepare("SELECT key_hash, key_prefix, status FROM _keys WHERE key_hash = ?")
    .bind(hash).first();
  if (!row) return problem(404, "unknown key", "그런 키가 없다");

  if (action === "revoke" || action === "restore") {
    const status = action === "revoke" ? "revoked" : "active";
    await env.DB.prepare("UPDATE _keys SET status = ? WHERE key_hash = ?").bind(status, hash).run();
    return json({ key_prefix: row.key_prefix, status });
  }
  if (action === "quota") {
    const q = parseInt(body.daily_quota, 10);
    if (!Number.isInteger(q) || q < MIN_QUOTA || q > MAX_QUOTA)
      return problem(400, "invalid quota", `daily_quota 는 ${MIN_QUOTA}~${MAX_QUOTA} 정수여야 한다`);
    await env.DB.prepare("UPDATE _keys SET daily_quota = ? WHERE key_hash = ?").bind(q, hash).run();
    return json({ key_prefix: row.key_prefix, daily_quota: q });
  }
  if (action === "delete") {
    // 이용자의 삭제 요청을 운영자가 대신 처리하는 경로. 요청 로그의 key_hash 는 남지만
    // 해시→이메일 대응이 사라져 사람과 연결되지 않는다(처리방침에 적은 그대로).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM _usage WHERE key_hash = ?").bind(hash),
      env.DB.prepare("DELETE FROM _burst WHERE bucket = ?").bind("k:" + hash),
      env.DB.prepare("DELETE FROM _keys WHERE key_hash = ?").bind(hash),
    ]);
    return json({ key_prefix: row.key_prefix, deleted: true });
  }
  return problem(400, "unknown action", "action 은 revoke·restore·quota·delete 중 하나여야 한다");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/summary") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      return summary(env, url.searchParams, canWrite(env, request));
    }
    if (url.pathname === "/api/apis") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      return usage(env, url.searchParams);
    }
    if (url.pathname.startsWith("/api/apis/")) {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      const name = decodeURIComponent(url.pathname.slice("/api/apis/".length));
      if (!name) return problem(400, "missing api", "API 이름이 필요하다");
      return usageDetail(env, name, url.searchParams);
    }
    if (url.pathname === "/api/keys") {
      // can_write 는 화면이 조치 버튼을 낼지 정하는 근거일 뿐이다. 이걸 못 믿어도 상관없다 —
      // 실제 차단은 POST 쪽 requireWrite 가 한다(화면 조작으로 뚫리지 않는다).
      if (request.method === "GET") return keys(env, url.searchParams, canWrite(env, request));
      if (request.method === "POST") return requireWrite(env, request) || keyAction(env, request);
      return problem(405, "method not allowed", "GET(목록) · POST(조치)");
    }
    // 요청 추적 — 지원 문의의 "그 요청" 한 건을 request_id 로 특정한다. 무인증(읽기 공개)인
    // 근거: request_id 는 그 응답을 받은 사람만 아는 16-hex 난수이고, 응답에는 키 8자
    // 축약·컬럼명 축만 실린다(decision/0010).
    // 안정성 추이의 드릴다운 — 무인증 조회. 요약과 같은 표를 같은 필터로 읽는다.
    if (url.pathname === "/api/drill") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      return domainDay(env, url.searchParams);
    }
    if (url.pathname === "/api/trace") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      const rid = (url.searchParams.get("request_id") || "").trim();
      if (!/^req_[0-9a-f]{16}$/.test(rid))
        return problem(400, "invalid request_id",
          "req_ + 16자리 hex — 게이트웨이 응답 헤더 X-Request-Id(오류 본문 request_id) 값");
      const res = await safeRows(env,
        // 🔴 여기만은 환경으로 거르지 않는다. `request_id` 는 지원 문의의 출발점이라,
        // 다른 환경 요청이어도 **"그 환경 것이다"라고 답하는 편이 "없다"보다 낫다.**
        // 대신 어느 환경 요청인지를 같이 실어 보낸다 — 판단은 사람이 한다.
        "SELECT ts, route, table_name, status, substr(key_hash, 1, 8) AS key_id, " +
        "filters, row_count, ms, env FROM _gateway_request_log WHERE request_id = ? LIMIT 5", rid);
      if (!res.ok) return problem(503, "log unavailable",
        "_gateway_request_log 를 조회할 수 없다 — 게이트웨이 D1 상태 공유와 마이그레이션 0005 적용 여부를 확인할 것");
      return json({ request_id: rid, found: res.rows.length, rows: res.rows });
    }
    if (url.pathname.startsWith("/api/")) return problem(404, "not found",
      "GET /api/summary · /api/trace · /api/apis · /api/apis/<이름> · /api/drill · /api/keys");
    return env.ASSETS ? env.ASSETS.fetch(request) : problem(404, "not found", "정적 자산 없음");
  },
};
