// ops-dashboard — 운영자용 통합 품질 콘솔 (ASK-Seoul#58, 로컬 전용)
//
// 한 화면에서 두 가지를 본다:
//   · 파이프라인 품질 — 수집·변환이 제 몫을 했나 (_ops_slo, gold_*_slo_daily 스냅샷)
//   · 서빙 품질       — 외부에 잘 나가고 있나 (_gw_request_log, 게이트웨이가 쌓는다)
// 둘 다 같은 D1 을 읽는다. 마켓플레이스와는 **다른 Worker · 다른 호스트**다 — 청중이 다르고,
// 배포 단위가 갈려야 사고 반경도 갈린다.
//
// 인증: 읽기는 열려 있고 **조치만** 공유 토큰(OPS_TOKEN)으로 잠근다 — canWrite/requireWrite 참고.
// 공유 토큰은 "누가 했나"가 남지 않는 약한 인증이라, 공개 배포 시 Cloudflare Access /
// org OAuth 로 교체해야 한다(멘토 게이트). 조치 쪽은 토큰 미설정이면 503 으로 닫힌다.

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
  const domains = await safeRows(env, "SELECT domain, label, has_slo, note FROM _ops_domain ORDER BY has_slo DESC, domain");
  const slo = await safeRows(env,
    "SELECT * FROM _ops_slo WHERE event_date >= date('now', ?) ORDER BY event_date", since);
  if (!domains.ok || !slo.ok) missing.push("pipeline");

  // ── 서빙 (게이트웨이가 쌓는 _gw_request_log)
  const routes = await safeRows(env,
    "SELECT route, COUNT(*) AS calls, SUM(status >= 400) AS errors, ROUND(AVG(ms),1) AS avg_ms " +
    "FROM _gw_request_log WHERE ts >= datetime('now', ?) GROUP BY route ORDER BY calls DESC", since);
  if (!routes.ok) missing.push("serving");
  const [daily, products, failures, empty, keys] = await Promise.all([
    safeRows(env, "SELECT substr(ts,1,10) AS day, COUNT(*) AS calls, COUNT(DISTINCT key_hash) AS keys_used " +
      "FROM _gw_request_log WHERE ts >= datetime('now', ?) GROUP BY day ORDER BY day", since),
    safeRows(env, "SELECT table_name, SUM(route='preview') AS previews, SUM(route='data') AS calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows FROM _gw_request_log " +
      "WHERE table_name IS NOT NULL AND ts >= datetime('now', ?) " +
      "GROUP BY table_name ORDER BY calls DESC, previews DESC LIMIT 12", since),
    safeRows(env, "SELECT status, route, table_name, COUNT(*) AS hits FROM _gw_request_log " +
      "WHERE status >= 400 AND ts >= datetime('now', ?) GROUP BY status, route, table_name " +
      "ORDER BY hits DESC LIMIT 10", since),
    safeRows(env, "SELECT table_name, filters, COUNT(*) AS empty_responses FROM _gw_request_log " +
      "WHERE status = 200 AND row_count = 0 AND ts >= datetime('now', ?) " +
      "GROUP BY table_name, filters ORDER BY empty_responses DESC LIMIT 10", since),
    safeRows(env, "SELECT substr(key_hash,1,8) AS key_id, COUNT(*) AS calls, " +
      "COUNT(DISTINCT substr(ts,1,10)) AS active_days FROM _gw_request_log " +
      "WHERE key_hash IS NOT NULL AND ts >= datetime('now', ?) GROUP BY key_hash " +
      "ORDER BY calls DESC LIMIT 10", since),
  ]);

  // 데이터 출처를 세 상태로 갈라서 내보낸다. "샘플이냐 아니냐"만 알려주면 화면이
  // "데이터가 없다"와 "합성이 섞였다"를 같은 문구로 말하게 되고, 운영자는 어느 쪽인지
  // 모른 채 원인을 찾게 된다.
  //   none  — _ops_slo 에 이 기간 행이 아예 없다 (시드 전이거나 실적재가 안 돌았다)
  //   sample— 합성 샘플이 섞여 있다 (is_sample=1)
  //   live  — 전부 실측이다
  const sampleRows = slo.rows.filter((r) => r.is_sample === 1).length;
  const pipelineSource = !slo.rows.length ? "none" : (sampleRows ? "sample" : "live");

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    meta: {
      missing,
      can_write: writable,
      // 이 콘솔이 지금 어느 환경의 무슨 DB 를 보고 있나. 숫자만 보고 추측하게 두면
      // 로컬 샘플을 운영 실적으로 오해하는 사고가 난다(wrangler.toml [vars]).
      env: { label: env.ENV_LABEL || "알 수 없음", d1: env.ENV_D1 || "알 수 없음" },
      // 샘플이 한 행이라도 섞여 있으면 화면 전체에 배지를 띄운다 — 조용히 섞이는 게 제일 나쁘다
      pipeline_is_sample: pipelineSource === "sample",
      pipeline_source: pipelineSource,
      pipeline_sample_rows: sampleRows,
    },
    pipeline: { domains: domains.rows, slo: slo.rows },
    serving: { routes: routes.rows, daily: daily.rows, products: products.rows,
               failures: failures.rows, empty: empty.rows, keys: keys.rows },
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
const SOURCES = [
  { table: "_ops_run_event", owner: "파이프라인", need: ["observed_date_kst", "domain", "status"],
    used: "데이터 준비 상태" },
  { table: "_ops_daily_metric", owner: "파이프라인", need: ["observed_date_kst", "domain", "layer", "event_count"],
    used: "데이터 준비 상태(집계)" },
  { table: "_ops_pipeline_state", owner: "파이프라인", need: ["dag_id", "last_status", "observation_state"],
    used: "파이프라인 현재 상태" },
  { table: "_ops_pipeline_expectation", owner: "파이프라인", need: ["dag_id", "monitored"],
    used: "실행 주기 등록" },
  { table: "_gw_request_log", owner: "게이트웨이", need: ["ts", "route", "status", "table_name", "key_hash"],
    used: "응답 상태 · API 사용량" },
  { table: "_catalog", owner: "도메인 export", need: ["name", "product_id", "external"],
    used: "API 사용량" },
  { table: "_keys", owner: "게이트웨이", need: ["key_hash", "email", "status", "daily_quota"],
    used: "이용자 키" },
  { table: "_ops_slo", owner: "콘솔", need: ["domain", "event_date", "is_sample"],
    used: "품질 기준(SLO)" },
  { table: "_ops_domain", owner: "콘솔", need: ["domain", "label", "has_slo"], used: "분야 등록부" },
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
      table: s.table, owner: s.owner, used: s.used,
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

// ── 파이프라인 실행 기록 (팀 조회 DB 4종) ──────────────────────────────────────────
// 정본은 ASAC-DAG `common/ops/d1_ops.py` 이고 **콘솔은 읽기 전용 소비자**다
// (ASK-Seoul#78 §8 · decision/0005·0007). 여기서 만들거나 고치는 표가 아니다.
//
// 화면이 읽어야 할 표는 `_ops_daily_metric`(날짜×도메인×단계 집계)이지만, 그게 비어 있어도
// `_ops_run_event`(기록 원본)에는 값이 있을 수 있다 — 실측(2026-08-03) 그 상태였다.
// 그래서 **둘 다 읽고, 어느 쪽이 비었는지를 화면에 그대로 알린다.** 집계가 비었다는 사실
// 자체가 관측 공백이고, 콘솔의 존재 이유가 그걸 채워서가 아니라 **보여주는** 것이다.
//
// 🔴 `모른다 ≠ 0` (#78 공통 원칙·F-3): 측정 못 한 값은 NULL 로 두고 0 과 구분해 내보낸다.
//    0 으로 그리면 관측 공백이 "이상 없음"으로 위장된다.
// 이 콘솔이 어느 환경을 보는가 → 그 환경 기록만 센다. `_ops_run_event.environment` 에
// 배포 환경이 실려 오는데(#78 Z-7), 실측에서 **운영 D1 에 dev 기록 17건이 섞여** 있었다
// (ASAC-DAG#677 곁가지). 섞인 채로 세면 운영 성공률이 개발 실행에 오염된다.
//
// 운영 화면(ENV_LABEL='운영')에서는 prod 만, 그 외에는 전부 본다 — 개발 화면에서 운영
// 기록까지 보이는 건 문제가 아니지만 그 반대는 사고다. 한쪽만 좁히는 이유가 그것이다.
// 필터를 건 사실과 걸러낸 건수는 응답에 실어 화면이 숨기지 않게 한다.
function envScope(env) {
  const isProd = String(env.ENV_LABEL || "") === "운영";
  return {
    isProd,
    // SQL 조각이지만 값이 코드 상수라 주입 경로가 아니다(바인딩을 쓰면 IS NULL 분기가 지저분해진다)
    where: isProd ? " AND environment = 'prod'" : "",
  };
}

async function pipeline(env, params) {
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(params.get("days"), 10) || DEFAULT_DAYS));
  const sinceDate = `-${days} days`;
  const scope = envScope(env);

  const [src, metric, events, state, expectation, layerGap] = await Promise.all([
    sources(env),
    // 집계표 — D-7 이 지정한 화면용 표. 자연키(날짜·도메인·단계)로 이미 접혀 있다.
    safeRows(env,
      "SELECT observed_date_kst AS day, domain, layer, event_count, success_count, failed_count, " +
      "skipped_count, degraded_count, retried_run_count, empty_run_count, " +
      "row_count_sum, rows_observed_count, rows_unknown_count, duration_s_sum, " +
      "api_call_count_sum, retry_count_sum, failure_count_sum " +
      "FROM _ops_daily_metric WHERE observed_date_kst >= date('now','+9 hours',?) " +
      "ORDER BY observed_date_kst DESC, domain, layer", sinceDate),
    // 기록 원본 — 집계가 비었을 때 "그래도 기록은 있다"를 보이기 위한 것이지, 콘솔이 집계를
    // 대신 만드는 게 아니다. 파이프라인의 집계 로직을 여기서 재현하면 정본이 둘이 된다.
    safeRows(env,
      "SELECT observed_date_kst AS day, domain, " +
      "COUNT(*) AS events, " +
      "SUM(status='success') AS success, SUM(status='failed') AS failed, " +
      "COUNT(DISTINCT dag_id) AS dags, " +
      // layer 가 NULL 인 기록 — #78 이 세라고 한 '단계 미기록 건수'. 0 과 구분해야 한다.
      "SUM(layer IS NULL) AS layer_unknown, " +
      "SUM(row_count IS NULL) AS rows_unknown " +
      "FROM _ops_run_event WHERE observed_date_kst >= date('now','+9 hours',?)" + scope.where + " " +
      "GROUP BY observed_date_kst, domain ORDER BY observed_date_kst, domain", sinceDate),
    // DAG 현재 상태 — observation_state 가 C-9 의 complete/partial/unverified.
    // unverified 는 "아직 점검이 안 지난 구간"이지 정상이라는 뜻이 **아니다.**
    safeRows(env,
      "SELECT dag_id, domain, last_status, last_observed_at, last_observed_date_kst, " +
      "event_count_observed, observation_state, reconciled_through, updated_at " +
      "FROM _ops_pipeline_state ORDER BY domain, dag_id"),
    // 기대치 — 정본은 DAG 선언이고 이 표는 사본(S-1). 감시 대상만 비교에 쓴다(S-4).
    safeRows(env,
      "SELECT dag_id, domain, trigger_type, expected_interval, upstream, max_delay_minutes, " +
      "schedule_timezone, monitored, owner, owner_confirmed_on FROM _ops_pipeline_expectation " +
      "ORDER BY domain, dag_id"),
    // 환경 필터를 걸었다는 사실 자체를 숨기지 않는다 — 걸러낸 건수를 같이 센다.
    // "왜 숫자가 다르지"를 화면이 스스로 답할 수 있어야 한다.
    safeRows(env,
      "SELECT COUNT(*) AS total, SUM(layer IS NULL) AS layer_unknown, " +
      "SUM(environment IS NOT NULL AND environment <> 'prod') AS non_prod " +
      "FROM _ops_run_event WHERE observed_date_kst >= date('now','+9 hours',?)", sinceDate),
  ]);

  const missing = [];
  if (!metric.ok) missing.push("daily_metric");
  if (!events.ok) missing.push("run_event");
  if (!state.ok) missing.push("pipeline_state");
  if (!expectation.ok) missing.push("expectation");

  // 기록은 있는데 집계가 비었나 — 이게 실제로 일어나는 상태라 화면이 구분해서 말해야 한다.
  const hasEvents = events.rows.some((r) => r.events > 0);
  const gap = layerGap.rows[0] || {};

  // ── D-7 3분류 — 성공률만으로는 안 보이는 것을 센다 (#78 §8)
  //   정기 실행 통과  = 성공했고, 재시도도 빈 실행도 아니다
  //   수동 복구로 살림 = 재시도 끝에 성공했다 — 성공률 100% 뒤에 숨는 열화다
  //                     (성공률 100% 인 7일 중 4일이 재발이었던 실사례가 규약에 있다)
  //   빈 실행         = 성공인데 받은 행이 0 — SLO 가 통과로 계산되는 '초록 위장'
  // 세 값 다 파이프라인이 집계표에 미리 세어 둔 것을 읽는다. 여기서 다시 계산하지 않는다.
  const cls = metric.rows.reduce((a, r) => {
    a.retried += r.retried_run_count || 0;
    a.empty += r.empty_run_count || 0;
    a.success += r.success_count || 0;
    a.failed += r.failed_count || 0;
    a.skipped += r.skipped_count || 0;
    a.degraded += r.degraded_count || 0;
    a.events += r.event_count || 0;
    a.rows_observed += r.rows_observed_count || 0;
    a.rows_unknown += r.rows_unknown_count || 0;
    // 모른다 ≠ 0 — row_count_sum 은 잰 것만 더한 값이라 NULL 을 0 으로 접지 않는다
    if (r.row_count_sum != null) a.row_sum += r.row_count_sum;
    if (r.duration_s_sum != null) a.duration += r.duration_s_sum;
    if (r.api_call_count_sum != null) a.api_calls += r.api_call_count_sum;
    return a;
  }, { retried: 0, empty: 0, success: 0, failed: 0, skipped: 0, degraded: 0, events: 0,
       rows_observed: 0, rows_unknown: 0, row_sum: 0, duration: 0, api_calls: 0 });
  // 정기 통과 = 성공에서 재시도로 살린 것을 뺀다. 음수 방지는 집계가 어긋났을 때의 안전장치다.
  cls.clean = Math.max(0, cls.success - cls.retried);

  // 단계별 집약 — "어디서 막히나"를 보려면 도메인이 아니라 단계로 접어야 한다
  const byLayer = {};
  for (const r of metric.rows) {
    const k = r.layer || "(미기록)";
    const b = byLayer[k] || (byLayer[k] = { layer: k, events: 0, success: 0, failed: 0,
                                            retried: 0, empty: 0, duration: 0, domains: new Set() });
    b.events += r.event_count || 0; b.success += r.success_count || 0;
    b.failed += r.failed_count || 0; b.retried += r.retried_run_count || 0;
    b.empty += r.empty_run_count || 0;
    if (r.duration_s_sum != null) b.duration += r.duration_s_sum;
    b.domains.add(r.domain);
  }
  const layers = Object.values(byLayer)
    .map((b) => ({ ...b, domains: b.domains.size,
                   avg_duration_s: b.events ? Math.round(b.duration / b.events * 10) / 10 : null }))
    .sort((a, b) => b.events - a.events);

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    meta: {
      missing,
      env: { label: env.ENV_LABEL || "알 수 없음", d1: env.ENV_D1 || "알 수 없음" },
      // 표별 상태를 그대로 내보낸다. 화면이 "왜 비었나"를 말할 수 있어야 한다.
      source: {
        daily_metric_rows: metric.rows.length,
        run_event_days: events.rows.length,
        // 집계표가 비었는데 원본에는 기록이 있는 상태 — 관측 공백의 한 종류다
        aggregate_missing: metric.ok && metric.rows.length === 0 && hasEvents,
      },
      // 모른다 ≠ 0 — 단계를 못 적은 기록이 몇 건인지 그대로 센다
      unknown: { events_total: gap.total ?? null, layer_unknown: gap.layer_unknown ?? null },
      // 환경 필터를 걸었는지, 그래서 몇 건을 뺐는지 — 화면이 숨기지 않는다
      scope: { env_filtered: scope.isProd, non_prod_rows: gap.non_prod ?? null },
    },
    // D-7 실행 3분류 + 집계 기반 지표. 파이프라인이 세어 둔 값을 읽을 뿐 다시 계산하지 않는다.
    classification: cls,
    by_layer: layers,
    // 콘솔이 읽는 표 하나하나의 상태 — 관측 공백을 배너 한 줄이 아니라 지표로 낸다
    sources: src,
    daily_metric: metric.rows,
    run_event_daily: events.rows,
    pipeline_state: state.rows,
    expectation: expectation.rows,
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

  const [apis, domains, monthly] = await Promise.all([
    safeRows(env,
      "SELECT c.name, c.product_id, " + DOMAIN_EXPR + " AS domain, c.description, c.row_count AS rows_total, " +
      "COUNT(r.rowid) AS calls, " +
      "COALESCE(SUM(r.route = 'data'), 0) AS data_calls, " +
      "COALESCE(SUM(r.route = 'preview'), 0) AS previews, " +
      "COALESCE(SUM(r.status >= 400), 0) AS errors, " +
      "COALESCE(SUM(r.status = 200 AND r.row_count = 0), 0) AS empty_hits, " +
      "ROUND(AVG(r.ms), 1) AS avg_ms, MAX(r.ts) AS last_call " +
      "FROM _catalog c LEFT JOIN _gw_request_log r " +
      "  ON r.table_name = c.name AND r.ts >= datetime('now', ?) " +
      "GROUP BY c.name ORDER BY calls DESC, c.name", since),
    // 도메인 비율 — 분모는 '카탈로그에 잡히는 호출'이다. catalog·me 처럼 제품이 없는 라우트는
    // 도메인에 귀속되지 않으므로 여기서 빠진다(화면에 그 사실을 적는다).
    safeRows(env,
      "SELECT " + DOMAIN_EXPR + " AS domain, COUNT(DISTINCT c.name) AS api_count, " +
      "COUNT(r.rowid) AS calls, COUNT(DISTINCT r.table_name) AS apis_used, " +
      "COALESCE(SUM(r.status >= 400), 0) AS errors " +
      "FROM _catalog c LEFT JOIN _gw_request_log r " +
      "  ON r.table_name = c.name AND r.ts >= datetime('now', ?) " +
      "GROUP BY domain ORDER BY calls DESC, domain", since),
    // 월별 — _gw_request_log 는 30일 보존이라 실제로 잡히는 건 최대 두 달 조각이다.
    // 그래도 내보내는 이유는 "지금 보이는 게 전부"라는 사실을 화면이 말해줄 수 있어서다.
    safeRows(env,
      "SELECT substr(r.ts,1,7) AS month, " + DOMAIN_EXPR + " AS domain, COUNT(*) AS calls " +
      "FROM _gw_request_log r JOIN _catalog c ON c.name = r.table_name " +
      "WHERE r.ts >= datetime('now', ?) GROUP BY month, domain ORDER BY month, calls DESC", since),
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

  const [daily, filters, statuses, recent] = await Promise.all([
    safeRows(env, "SELECT substr(ts,1,10) AS day, COUNT(*) AS calls, " +
      "SUM(status >= 400) AS errors, ROUND(AVG(row_count),1) AS avg_rows " +
      "FROM _gw_request_log WHERE table_name = ? AND ts >= datetime('now', ?) GROUP BY day ORDER BY day",
      name, since),
    // 필터 '축' — 컬럼명 조합이다. 값은 저장하지 않으므로 여기 나올 수 없다.
    safeRows(env, "SELECT COALESCE(filters, '') AS filters, COUNT(*) AS calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows, SUM(status = 200 AND row_count = 0) AS empty_hits " +
      "FROM _gw_request_log WHERE table_name = ? AND ts >= datetime('now', ?) " +
      "GROUP BY filters ORDER BY calls DESC LIMIT 20", name, since),
    safeRows(env, "SELECT status, route, COUNT(*) AS calls FROM _gw_request_log " +
      "WHERE table_name = ? AND ts >= datetime('now', ?) GROUP BY status, route ORDER BY calls DESC",
      name, since),
    safeRows(env, "SELECT ts, route, status, COALESCE(filters,'') AS filters, row_count, ms, " +
      "request_id, substr(key_hash,1,8) AS key_id FROM _gw_request_log " +
      "WHERE table_name = ? AND ts >= datetime('now', ?) ORDER BY ts DESC LIMIT 50", name, since),
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

async function listKeys(env) {
  // 쿼터의 하루 경계는 KST — 게이트웨이 kstDay() 와 같은 규약이어야 숫자가 맞는다
  const res = await safeRows(env,
    "SELECT k.key_hash, k.key_prefix, k.email, k.status, k.daily_quota, k.created_at, " +
    "COALESCE(u.count, 0) AS used_today, " +
    "(SELECT COUNT(*) FROM _gw_request_log r WHERE r.key_hash = k.key_hash) AS calls_logged, " +
    "(SELECT MAX(r.ts) FROM _gw_request_log r WHERE r.key_hash = k.key_hash) AS last_call " +
    "FROM _keys k LEFT JOIN _usage u ON u.key_hash = k.key_hash AND u.day = date('now', '+9 hours') " +
    "ORDER BY k.created_at DESC");
  // email 은 여기서 사라진다 — 응답 객체에 원문이 담기는 경로를 남기지 않는다.
  // 키 이름도 email_masked 로 바꿔, 나중에 이 값을 실제 주소로 착각하지 않게 한다.
  return {
    ok: res.ok,
    rows: res.rows.map(({ email, ...rest }) => ({ ...rest, email_masked: maskEmail(email) })),
  };
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
    if (url.pathname === "/api/pipeline") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      return pipeline(env, url.searchParams);
    }
    if (url.pathname === "/api/usage") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      return usage(env, url.searchParams);
    }
    if (url.pathname.startsWith("/api/usage/")) {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      const name = decodeURIComponent(url.pathname.slice("/api/usage/".length));
      if (!name) return problem(400, "missing api", "API 이름이 필요하다");
      return usageDetail(env, name, url.searchParams);
    }
    if (url.pathname === "/api/keys") {
      if (request.method === "GET") {
        const res = await listKeys(env);
        // can_write 는 화면이 조치 버튼을 낼지 정하는 근거다. 이걸 못 믿어도 상관없다 —
        // 실제 차단은 POST 쪽 requireWrite 가 한다(화면 조작으로 뚫리지 않는다).
        return json({ ok: res.ok, keys: res.rows, can_write: canWrite(env, request),
                      generated_at: new Date().toISOString() });
      }
      if (request.method === "POST") return requireWrite(env, request) || keyAction(env, request);
      return problem(405, "method not allowed", "GET(목록) · POST(조치)");
    }
    if (url.pathname.startsWith("/api/"))
      return problem(404, "not found",
        "GET /api/summary · /api/pipeline · /api/usage · /api/usage/<api> · /api/keys");
    return env.ASSETS ? env.ASSETS.fetch(request) : problem(404, "not found", "정적 자산 없음");
  },
};
