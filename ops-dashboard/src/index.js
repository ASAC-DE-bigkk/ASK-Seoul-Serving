// ops-dashboard — 운영자용 통합 품질 콘솔 (ASK-Seoul#58, 로컬 전용)
//
// 한 화면에서 여섯 가지를 본다(탭 이름은 화면 문구 규약 — 내부 용어를 쓰지 않는다):
//   · 데이터 준비 상태 — 매일 제때 갱신됐나 (_ops_slo, 보조·합성 스냅샷)
//   · 실행 기록       — 무엇이 돌았고 무엇이 조용한가 (_ops_run_event 등 조회 DB 4종,
//                       ASK-Seoul#78 규약 — 정본 스키마는 ASAC-DAG, 여기는 읽기 전용. decision/0009)
//   · 응답 상태       — 외부에 잘 나가고 있나 (_request_log, 게이트웨이가 쌓는다)
//   · 이용 행동       — **누가** 쓰나: 사람·AI·여정 (decision/0010)
//   · API 사용량      — **무엇이** 얼마나 쓰이나: API별·분야별 (_request_log + _catalog)
//   · 이용자 키       — 발급된 키의 상태·쿼터
// 전부 같은 D1 을 읽는다. 마켓플레이스와는 **다른 Worker · 다른 호스트**다 — 청중이 다르고,
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

  // ── 실행 기록 (조회 DB 4종 — ASK-Seoul#78 §8, decision/0009. 읽기만 한다)
  // 날짜 축은 observed_date_kst 라 KST 로 자른다(now+9h). 오늘 포함 N일 창.
  const kstSince = `-${days - 1} days`;
  const rdaily = await safeRows(env,
    "SELECT * FROM _ops_daily_metric WHERE observed_date_kst >= date('now','+9 hours', ?) " +
    "ORDER BY observed_date_kst, domain, layer", kstSince);
  // 기대치×상태 — 정본은 DAG 선언의 사본(S-1)이고, 수동 전용(monitored=0)은 뺀다(S-4).
  // LEFT JOIN 이라 "기록 자체가 없는 DAG"도 행으로 남는다 — 그 공백이 곧 관측이다.
  const rexp = await safeRows(env,
    "SELECT e.dag_id, e.domain, e.trigger_type, e.expected_interval, e.upstream, " +
    "e.max_delay_minutes, e.owner, s.last_status, s.last_observed_at, s.observation_state " +
    "FROM _ops_pipeline_expectation e LEFT JOIN _ops_pipeline_state s ON s.dag_id = e.dag_id " +
    "WHERE e.monitored = 1 ORDER BY e.domain, e.dag_id");
  if (!rdaily.ok || !rexp.ok) missing.push("runs");
  const [rfail, rempty, renv, rslow, rload, rsmp] = await Promise.all([
    // 실패 목록 — is_final_try 를 그대로 싣는다. 1=최종 실패, 0=재시도 중, NULL=시도 정보 없음
    // (관문 이전 기록). 셋을 뭉개면 "재시도로 살아난 실행"이 실패로 둔갑한다(C-7).
    safeRows(env, "SELECT observed_date_kst, domain, layer, dag_id, task_id, is_final_try, " +
      "retry_count, error_ref FROM _ops_run_event WHERE status = 'failed' " +
      "AND observed_date_kst >= date('now','+9 hours', ?) ORDER BY observed_at DESC LIMIT 12", kstSince),
    // 빈 실행 = 초록 위장의 일반형 — 성공인데 실측 0행. row_count IS NULL(못 잼)과 다르다(F-3).
    safeRows(env, "SELECT observed_date_kst, domain, layer, dag_id, task_id, rows_source " +
      "FROM _ops_run_event WHERE status = 'success' AND row_count = 0 " +
      "AND observed_date_kst >= date('now','+9 hours', ?) ORDER BY observed_at DESC LIMIT 10", kstSince),
    // 환경 분포 — 조회 DB 에 dev 가 섞이면 운영 지표가 오염된다(Z-7 실해). 화면이 감시한다.
    safeRows(env, "SELECT environment, COUNT(*) AS events, COUNT(DISTINCT domain) AS domains, " +
      "MAX(observed_at) AS last_seen FROM _ops_run_event " +
      "WHERE observed_date_kst >= date('now','+9 hours', ?) GROUP BY environment ORDER BY events DESC", kstSince),
    safeRows(env, "SELECT dag_id, task_id, domain, ROUND(schedule_delay_s/60.0,1) AS delay_min, " +
      "ROUND(duration_s/60.0,1) AS dur_min, observed_date_kst FROM _ops_run_event " +
      "WHERE schedule_delay_s IS NOT NULL AND observed_date_kst >= date('now','+9 hours', ?) " +
      "ORDER BY schedule_delay_s DESC LIMIT 8", kstSince),
    // 적재 자체의 신선도 + 단계 미기록(layer NULL — 관문 이전 기록) 건수
    safeRows(env, "SELECT COUNT(*) AS total, SUM(layer IS NULL) AS layerless, " +
      "MAX(ingested_at) AS last_ingest FROM _ops_run_event " +
      "WHERE observed_date_kst >= date('now','+9 hours', ?)", kstSince),
    // 샘플 감지 — 정본 스키마에 is_sample 이 없어 값 규약으로 표시한다(decision/0009)
    safeRows(env, "SELECT (SELECT COUNT(*) FROM _ops_run_event WHERE event_id LIKE 'smp_%') + " +
      "(SELECT COUNT(*) FROM _ops_daily_metric WHERE updated_at = 'sample') AS n"),
  ]);

  // ── 서빙 (게이트웨이가 쌓는 _request_log)
  const routes = await safeRows(env,
    "SELECT route, COUNT(*) AS calls, SUM(status >= 400) AS errors, ROUND(AVG(ms),1) AS avg_ms " +
    "FROM _request_log WHERE ts >= datetime('now', ?) GROUP BY route ORDER BY calls DESC", since);
  if (!routes.ok) missing.push("serving");
  const [daily, products, failures, empty, keys] = await Promise.all([
    safeRows(env, "SELECT substr(ts,1,10) AS day, COUNT(*) AS calls, COUNT(DISTINCT key_hash) AS keys_used " +
      "FROM _request_log WHERE ts >= datetime('now', ?) GROUP BY day ORDER BY day", since),
    safeRows(env, "SELECT table_name, SUM(route='preview') AS previews, SUM(route='data') AS calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows FROM _request_log " +
      "WHERE table_name IS NOT NULL AND ts >= datetime('now', ?) " +
      "GROUP BY table_name ORDER BY calls DESC, previews DESC LIMIT 12", since),
    safeRows(env, "SELECT status, route, table_name, COUNT(*) AS hits FROM _request_log " +
      "WHERE status >= 400 AND ts >= datetime('now', ?) GROUP BY status, route, table_name " +
      "ORDER BY hits DESC LIMIT 10", since),
    safeRows(env, "SELECT table_name, filters, COUNT(*) AS empty_responses FROM _request_log " +
      "WHERE status = 200 AND row_count = 0 AND ts >= datetime('now', ?) " +
      "GROUP BY table_name, filters ORDER BY empty_responses DESC LIMIT 10", since),
    safeRows(env, "SELECT substr(key_hash,1,8) AS key_id, COUNT(*) AS calls, " +
      "COUNT(DISTINCT substr(ts,1,10)) AS active_days FROM _request_log " +
      "WHERE key_hash IS NOT NULL AND ts >= datetime('now', ?) GROUP BY key_hash " +
      "ORDER BY calls DESC LIMIT 10", since),
  ]);

  // 데이터 출처를 세 상태로 갈라서 내보낸다. "샘플이냐 아니냐"만 알려주면 화면이
  // "데이터가 없다"와 "합성이 섞였다"를 같은 문구로 말하게 되고, 운영자는 어느 쪽인지
  // 모른 채 원인을 찾게 된다.
  //   none  — _ops_slo 에 이 기간 행이 아예 없다 (시드 전이다)
  //   sample— 합성 샘플이 섞여 있다 (is_sample=1)
  //   live  — 전부 실측이다
  const sampleRows = slo.rows.filter((r) => r.is_sample === 1).length;
  const pipelineSource = !slo.rows.length ? "none" : (sampleRows ? "sample" : "live");

  // ── 이용 행동 (행동 로그 스펙 초안 #9 — 콘솔 선반영, decision/0010)
  // 지금 데이터로 답이 되는 것(여정·익명 비중)과 수집 후 점등되는 것(ua_class 등)을 나눈다.
  // 초안 컬럼이 아직 없으면 safeRows 가 실패를 삼키고 그 카드는 '수집 전'으로 남는다 —
  // 콘솔은 게이트웨이 스키마를 만들지도 미러하지도 않는다(0010: ALTER 미러는 정본
  // 마이그레이션과 duplicate column 으로 충돌해 저쪽 시드를 깨뜨린다).
  const [src, funnel, udaily, uclients, uagents, upages] = await Promise.all([
    sources(env),
    safeRows(env,
      "SELECT COUNT(*) AS issued, SUM(first_call IS NOT NULL) AS activated, " +
      "ROUND(AVG(CASE WHEN first_call IS NOT NULL THEN (julianday(first_call) - julianday(created_at)) * 24 END), 1) AS avg_hours_to_first " +
      "FROM (SELECT k.created_at, (SELECT MIN(r.ts) FROM _request_log r " +
      "WHERE r.key_hash = k.key_hash AND r.route = 'data') AS first_call FROM _keys k)"),
    safeRows(env, "SELECT substr(ts,1,10) AS day, SUM(key_hash IS NOT NULL) AS keyed, " +
      "SUM(key_hash IS NULL) AS anon FROM _request_log WHERE ts >= datetime('now', ?) " +
      "GROUP BY day ORDER BY day", since),
    safeRows(env, "SELECT ua_class, COUNT(*) AS calls FROM _request_log " +
      "WHERE ts >= datetime('now', ?) AND ua_class IS NOT NULL GROUP BY ua_class ORDER BY calls DESC", since),
    safeRows(env, "SELECT agent_name, agent_mode, COUNT(*) AS calls, SUM(route='data') AS data_calls, " +
      "COUNT(DISTINCT table_name) AS products FROM _request_log " +
      "WHERE ts >= datetime('now', ?) AND agent_name IS NOT NULL " +
      "GROUP BY agent_name, agent_mode ORDER BY calls DESC LIMIT 10", since),
    safeRows(env, "SELECT page_path, COUNT(*) AS hits FROM _request_log " +
      "WHERE route = 'page' AND ts >= datetime('now', ?) AND page_path IS NOT NULL " +
      "GROUP BY page_path ORDER BY hits DESC LIMIT 12", since),
  ]);

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
      runs_is_sample: rsmp.ok && (rsmp.rows[0]?.n || 0) > 0,
      // 로그 테이블은 있는데 초안 컬럼만 없다 = 스펙 반영 전 (테이블 자체가 없으면 serving 누락으로 이미 표시)
      usage_spec_pending: routes.ok && !uclients.ok,
    },
    pipeline: { domains: domains.rows, slo: slo.rows },
    runs: { daily: rdaily.rows, expectations: rexp.rows, failures: rfail.rows,
            empty_runs: rempty.rows, environments: renv.rows, slowest: rslow.rows,
            load: rload.rows[0] || null },
    serving: { routes: routes.rows, daily: daily.rows, products: products.rows,
               failures: failures.rows, empty: empty.rows, keys: keys.rows },
    usage: { funnel: funnel.ok ? funnel.rows[0] : null, daily: udaily.rows,
             clients: { pending: !uclients.ok, rows: uclients.rows },
             agents: { pending: !uagents.ok, rows: uagents.rows },
             pages: { pending: !upages.ok, rows: upages.rows } },
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
const SOURCES = [
  { table: "_ops_run_event", owner: "파이프라인", need: ["observed_date_kst", "domain", "status"],
    used: "데이터 준비 상태" },
  { table: "_ops_daily_metric", owner: "파이프라인", need: ["observed_date_kst", "domain", "layer", "event_count"],
    used: "데이터 준비 상태(집계)" },
  { table: "_ops_pipeline_state", owner: "파이프라인", need: ["dag_id", "last_status", "observation_state"],
    used: "파이프라인 현재 상태" },
  { table: "_ops_pipeline_expectation", owner: "파이프라인", need: ["dag_id", "monitored"],
    used: "실행 주기 등록" },
  { table: "_request_log", owner: "게이트웨이", need: ["ts", "route", "status", "table_name", "key_hash"],
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
      "FROM _catalog c LEFT JOIN _request_log r " +
      "  ON r.table_name = c.name AND r.ts >= datetime('now', ?) " +
      "GROUP BY c.name ORDER BY calls DESC, c.name", since),
    // 도메인 비율 — 분모는 '카탈로그에 잡히는 호출'이다. catalog·me 처럼 제품이 없는 라우트는
    // 도메인에 귀속되지 않으므로 여기서 빠진다(화면에 그 사실을 적는다).
    safeRows(env,
      "SELECT " + DOMAIN_EXPR + " AS domain, COUNT(DISTINCT c.name) AS api_count, " +
      "COUNT(r.rowid) AS calls, COUNT(DISTINCT r.table_name) AS apis_used, " +
      "COALESCE(SUM(r.status >= 400), 0) AS errors " +
      "FROM _catalog c LEFT JOIN _request_log r " +
      "  ON r.table_name = c.name AND r.ts >= datetime('now', ?) " +
      "GROUP BY domain ORDER BY calls DESC, domain", since),
    // 월별 — _request_log 는 30일 보존이라 실제로 잡히는 건 최대 두 달 조각이다.
    // 그래도 내보내는 이유는 "지금 보이는 게 전부"라는 사실을 화면이 말해줄 수 있어서다.
    safeRows(env,
      "SELECT substr(r.ts,1,7) AS month, " + DOMAIN_EXPR + " AS domain, COUNT(*) AS calls " +
      "FROM _request_log r JOIN _catalog c ON c.name = r.table_name " +
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
      "FROM _request_log WHERE table_name = ? AND ts >= datetime('now', ?) GROUP BY day ORDER BY day",
      name, since),
    // 필터 '축' — 컬럼명 조합이다. 값은 저장하지 않으므로 여기 나올 수 없다.
    safeRows(env, "SELECT COALESCE(filters, '') AS filters, COUNT(*) AS calls, " +
      "ROUND(AVG(row_count),1) AS avg_rows, SUM(status = 200 AND row_count = 0) AS empty_hits " +
      "FROM _request_log WHERE table_name = ? AND ts >= datetime('now', ?) " +
      "GROUP BY filters ORDER BY calls DESC LIMIT 20", name, since),
    safeRows(env, "SELECT status, route, COUNT(*) AS calls FROM _request_log " +
      "WHERE table_name = ? AND ts >= datetime('now', ?) GROUP BY status, route ORDER BY calls DESC",
      name, since),
    safeRows(env, "SELECT ts, route, status, COALESCE(filters,'') AS filters, row_count, ms, " +
      "request_id, substr(key_hash,1,8) AS key_id FROM _request_log " +
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
    "(SELECT COUNT(*) FROM _request_log r WHERE r.key_hash = k.key_hash) AS calls_logged, " +
    "(SELECT MAX(r.ts) FROM _request_log r WHERE r.key_hash = k.key_hash) AS last_call " +
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
    // 요청 추적 — 지원 문의의 "그 요청" 한 건을 request_id 로 특정한다. 무인증(읽기 공개)인
    // 근거: request_id 는 그 응답을 받은 사람만 아는 16-hex 난수이고, 응답에는 키 8자
    // 축약·컬럼명 축만 실린다(decision/0010).
    if (url.pathname === "/api/trace") {
      if (request.method !== "GET") return problem(405, "method not allowed", "조회 전용");
      const rid = (url.searchParams.get("request_id") || "").trim();
      if (!/^req_[0-9a-f]{16}$/.test(rid))
        return problem(400, "invalid request_id",
          "req_ + 16자리 hex — 게이트웨이 응답 헤더 X-Request-Id(오류 본문 request_id) 값");
      const res = await safeRows(env,
        "SELECT ts, route, table_name, status, substr(key_hash, 1, 8) AS key_id, " +
        "filters, row_count, ms FROM _request_log WHERE request_id = ? LIMIT 5", rid);
      if (!res.ok) return problem(503, "log unavailable",
        "_request_log 를 조회할 수 없다 — 게이트웨이 D1 상태 공유와 request_id 컬럼(마이그레이션 0004) 적용 여부를 확인할 것");
      return json({ request_id: rid, found: res.rows.length, rows: res.rows });
    }
    if (url.pathname.startsWith("/api/")) return problem(404, "not found",
      "GET /api/summary · /api/trace · /api/apis · /api/apis/<이름> · /api/keys");
    return env.ASSETS ? env.ASSETS.fetch(request) : problem(404, "not found", "정적 자산 없음");
  },
};
