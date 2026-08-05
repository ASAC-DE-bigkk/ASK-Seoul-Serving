-- 운영 기록 조회 DB 표 4종 — **표가 없는 D1 을 위한 미러** (decision/0009, ASK-Seoul#78 §8)
--
-- 🔴 **운영 D1 에서는 실행되지 않는다** (2026-08-05, decision/0015). 거기엔 ASAC-DAG 적재기가
--    만든 진짜 표가 실측 수만 행과 함께 이미 있고, 이 파일을 돌리면 `CREATE TABLE IF NOT
--    EXISTS` 는 넘어가도 **아래 `CREATE INDEX` 3개가 남의 운영 표에 실제로 만들어진다.**
--    스키마 판단은 정본 소유자 몫이므로(CLAUDE.md §6), 표가 이미 있으면
--    `scripts/backfill-migrations-ledger.sql` 이 **실행 없이 장부에만 적어** 건너뛰게 한다.
--
-- 정본은 ASAC-DAG `common/ops/d1_ops.py`(ops-d1/v1)다. 팀 D1 에는 그쪽 적재기가 이 표를
-- 만들고 채운다 — 이 파일은 팀 조회 DB 를 읽을 수 없는 로컬(0002 로컬 전용)에서 같은 모양의
-- 표를 시드하기 위한 미러이며, 컬럼을 더하거나 빼지 않는다. 정본이 바뀌면 따라 고친다.
--
-- DROP 없음 — 증분 규약(#78 D-6, decision/0007). 스키마 변경은 ALTER 추가 파일로만.
--
-- 샘플 표시(정본에 is_sample 컬럼을 더할 수 없으므로 값 규약): _ops_run_event 는 event_id
-- 'smp_' 접두, 나머지 표는 updated_at='sample'. 화면이 이를 감지해 배지를 띄운다.

-- 기록 1건 — 컬럼은 규약 F 표와 1:1. layer 는 NULL 허용(관문 이전 기록은 단계 정보가
-- 없고, 없는 것을 추측해 채우면 그게 거짓말이 된다 — F-3 모른다≠0).
CREATE TABLE IF NOT EXISTS _ops_run_event (
  event_id           TEXT NOT NULL,
  schema_version     TEXT NOT NULL,
  domain             TEXT NOT NULL,
  layer              TEXT,
  grain              TEXT NOT NULL,
  dag_id             TEXT,
  task_id            TEXT,
  run_id             TEXT,
  try_number         INTEGER,
  is_final_try       INTEGER,
  environment        TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  started_at         TEXT,
  ended_at           TEXT,
  duration_s         REAL,
  duration_hms       TEXT,
  observed_date_kst  TEXT NOT NULL,
  source_path_date   TEXT,
  schedule_delay_s   REAL,
  row_count          INTEGER,
  rows_source        TEXT NOT NULL,
  bytes              INTEGER,
  api_name           TEXT,
  api_call_count     INTEGER,
  retry_count        INTEGER,
  failure_count      INTEGER,
  sink_type          TEXT,
  sink_target        TEXT,
  status             TEXT NOT NULL,
  error_ref          TEXT,
  quality            TEXT,
  publication_id     TEXT,
  product_id         TEXT,
  product_ids        TEXT,
  source_category    TEXT NOT NULL,
  source_key         TEXT,
  log_bundle_key     TEXT,
  ingested_at        TEXT NOT NULL,
  PRIMARY KEY (event_id)
);
CREATE INDEX IF NOT EXISTS _ops_run_event__date_domain
  ON _ops_run_event (observed_date_kst, domain, layer);
CREATE INDEX IF NOT EXISTS _ops_run_event__dag ON _ops_run_event (dag_id, observed_at);
CREATE INDEX IF NOT EXISTS _ops_run_event__source
  ON _ops_run_event (source_path_date, source_category);

-- 날짜×도메인×단계 집계 — 화면·알림이 실제로 읽는 표(D-7). 성공률이 가리는 두 축
-- (재시도로 살림·빈 실행)과 "모른다 ≠ 0"(observed vs unknown)이 컬럼으로 준비돼 있다.
CREATE TABLE IF NOT EXISTS _ops_daily_metric (
  observed_date_kst    TEXT NOT NULL,
  domain               TEXT NOT NULL,
  layer                TEXT NOT NULL,
  event_count          INTEGER NOT NULL,
  success_count        INTEGER NOT NULL,
  failed_count         INTEGER NOT NULL,
  skipped_count        INTEGER NOT NULL,
  degraded_count       INTEGER NOT NULL,
  retried_run_count    INTEGER NOT NULL,
  empty_run_count      INTEGER NOT NULL,
  row_count_sum        INTEGER,
  rows_observed_count  INTEGER NOT NULL,
  rows_unknown_count   INTEGER NOT NULL,
  duration_s_sum       REAL,
  api_call_count_sum   INTEGER,
  retry_count_sum      INTEGER,
  failure_count_sum    INTEGER,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (observed_date_kst, domain, layer)
);

-- DAG 하나의 현재 상태 — observation_state 가 C-9 의 complete/partial/unverified.
-- 미확인은 정상이라는 뜻이 아니다 — 아직 점검이 안 지난 구간이라는 사실이다.
CREATE TABLE IF NOT EXISTS _ops_pipeline_state (
  dag_id                 TEXT NOT NULL,
  domain                 TEXT NOT NULL,
  last_event_id          TEXT,
  last_status            TEXT,
  last_observed_at       TEXT,
  last_observed_date_kst TEXT,
  last_run_id            TEXT,
  event_count_observed   INTEGER,
  observation_state      TEXT NOT NULL,
  reconciled_through     TEXT,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (dag_id)
);

-- DAG 하나의 기대치 — 정본은 DAG 선언(코드)이고 이 표는 사본(S-1).
-- monitored=0(수동 전용)은 멈춤 판정에서 제외한다(S-4).
CREATE TABLE IF NOT EXISTS _ops_pipeline_expectation (
  dag_id             TEXT NOT NULL,
  domain             TEXT NOT NULL,
  trigger_type       TEXT NOT NULL,
  expected_interval  TEXT,
  upstream           TEXT,
  max_delay_minutes  INTEGER,
  schedule_timezone  TEXT NOT NULL,
  monitored          INTEGER NOT NULL,
  owner              TEXT,
  owner_confirmed_on TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (dag_id)
);
