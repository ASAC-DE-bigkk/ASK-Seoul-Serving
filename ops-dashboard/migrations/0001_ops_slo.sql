-- 파이프라인 품질 스냅샷 — 콘솔이 **자기 소유로** 만드는 표 두 개 (ASK-Seoul#58)
--
-- ⚠️ **이 파일은 DROP 을 쓰지 않는다** (ASK-Seoul#78 D-6). 예전에는 스키마를 고칠 때마다
--    DROP+CREATE 로 통째로 다시 만들었다. "로컬 프로토타입이라 잃을 상태가 없다"는 전제였고,
--    팀 조회 DB 에 붙는 순간 그 전제가 깨진다 — 첫 스키마 수정이 팀 데이터를 지운다.
--    컬럼이 늘면 **새 마이그레이션 파일(0002…)에 ALTER 를 추가**한다. 이 파일은 안 고친다.
--    적용 여부는 D1 안의 장부(d1_migrations)가 추적한다 — `wrangler d1 migrations apply`.
--
-- ⚠️ **콘솔이 만드는 표는 아래 둘뿐이다.** 파이프라인·dbt 산출물(`_ops_run_event`·
--    `_ops_daily_metric`·`_ops_pipeline_state`·`_ops_pipeline_expectation`·`_catalog`·
--    제품 표 `d1_*`)은 **소유자가 따로 있고 콘솔은 읽기만 한다.** 그쪽 표를 만들거나
--    지우는 문장을 이 디렉토리에 두지 않는다 — 스키마 정본은 ASAC-DAG
--    `common/ops/d1_ops.py`(4종)와 `../marketplace/migrations/`(게이트웨이 표)다.
--
-- **is_sample**: 화면이 합성값을 실측인 척하면 안 되므로 행마다 표시한다. UI 가 그걸 읽어
-- 배너를 띄운다. 실측이 들어오면 is_sample=0 이라 배너는 저절로 사라진다.

CREATE TABLE IF NOT EXISTS _ops_slo (
  domain               TEXT    NOT NULL,
  event_date           TEXT    NOT NULL,  -- KST 집계일
  scheduled_slo_passed INTEGER,           -- 정기런이 제 몫을 했나 (bool)
  eod_slo_passed       INTEGER,           -- 그날이 끝날 때 데이터가 있었나 (bool)
  best_coverage_pct    REAL,
  failed_dataset_count INTEGER,
  violation_count      INTEGER,           -- 계약(min_rows 등) 위반
  total_rows           INTEGER,
  ingest_duration_min  REAL,
  transform_runs       INTEGER,
  transform_all_success INTEGER,          -- bool
  maintenance_ran      INTEGER,           -- bool
  -- 초록 위장: Airflow 는 success 인데 expected=0 (전멸을 통과로 착각). 7/7 실사례에서
  -- 나온 컬럼이라 반드시 실어야 한다 — SLO 가 통과로 보이는데 실제로는 빈 날이다.
  green_disguise_runs  INTEGER,
  is_sample            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, event_date)
);

CREATE INDEX IF NOT EXISTS idx_ops_slo_date ON _ops_slo (event_date);

-- 도메인 등록부 — "SLO 마트를 가진 도메인이 몇 개인가"를 화면이 세려면 분모가 필요하다.
-- 실측(2026-07-28): ASAC-DBT 전체에서 *_slo_daily 는 culture 하나뿐이다. 그 사실 자체가
-- 콘솔이 드러내야 할 관측이라, 없는 도메인도 행으로 남긴다.
CREATE TABLE IF NOT EXISTS _ops_domain (
  domain     TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  has_slo    INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);
