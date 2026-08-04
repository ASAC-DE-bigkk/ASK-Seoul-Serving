-- 파이프라인 품질 스냅샷 — 콘솔이 **자기 소유로** 만드는 표 두 개 (ASK-Seoul#58)
--
-- ⚠️ **이 파일은 DROP 을 쓰지 않는다** (ASK-Seoul#78 D-6). 예전에는 스키마를 고칠 때마다
--    DROP+CREATE 로 통째로 다시 만들었다. "로컬 프로토타입이라 잃을 상태가 없다"는 전제였고,
--    팀 조회 DB 에 붙는 순간 그 전제가 깨진다 — 첫 스키마 수정이 팀 데이터를 지운다.
--    컬럼이 늘면 **새 마이그레이션 파일(0002…)에 ALTER 를 추가**한다. 이 파일은 안 고친다.
--    적용 여부는 D1 안의 장부(d1_migrations)가 추적한다 — `wrangler d1 migrations apply`.
--
-- **is_sample**: 로컬 프로토타입에는 팀 D1 쓰기 권한이 없어 합성 데이터를 시드한다.
-- 화면이 그걸 실측인 척하면 안 되므로 행마다 표시하고, UI 는 '샘플' 배지를 띄운다.
-- 실적재가 붙으면 is_sample=0 이 들어오고 배지는 저절로 사라진다.

-- ⚠️ DROP 금지 — 증분 규약 (ASK-Seoul#78 D-6, decision/0007 개정).
-- 팀 조회 DB 에 _ops_* 가족이 실존하므로, 이 파일이 팀 D1 에 닿는 날 DROP 은 팀 데이터를
-- 지운다. 스키마 변경은 ALTER 추가 파일(0003, 0004 …)로만. 내용물 리프레시는 픽스처·로더가
-- 자기 범위를 DELETE 하고 다시 넣는다. 로컬 통리셋이 필요하면 .wrangler 상태를 지울 것.
--
-- ⚠️ **콘솔이 만드는 표는 아래 둘뿐이다.** 파이프라인 산출물(`_ops_run_event`·
--    `_ops_daily_metric`·`_ops_pipeline_state`·`_ops_pipeline_expectation`)은 정본이
--    ASAC-DAG `common/ops/d1_ops.py` 이고, 0002 는 로컬 개발용 **미러**다(decision/0009).
--    `_catalog`·제품 표(`d1_*`)·게이트웨이 표도 소유자가 따로 있어 콘솔은 읽기만 한다.
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
