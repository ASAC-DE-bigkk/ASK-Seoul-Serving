-- 로컬 검증용 **합성** 운영 기록 (decision/0009) — 실측이 아니다.
--
-- 팀 조회 DB(실제 적재는 ASAC-DAG 관문·적재기가 한다)를 로컬에서 읽을 수 없으므로,
-- 화면 동작을 확인할 14일치를 합성해 둔다. 표시 규약(정본 스키마에 is_sample 을 더할 수
-- 없어 값으로 표시한다): _ops_run_event 는 event_id 'smp_' 접두, 나머지 표는
-- updated_at='sample'. UI 는 이를 감지해 '샘플' 배지를 띄운다.
--
-- 날짜는 2026-07-21 ~ 2026-08-03 하드코딩 — 기간이 지나면 화면 창(기본 14일) 밖으로
-- 밀려난다(slo_sample 과 같은 한계). 시나리오가 하나씩 박혀 있다:
--   재시도로 살림(07-31 raw·bronze) · 최종 실패(07-25 gold) · 빈 실행=초록 위장(08-01 d1)
--   모른다≠0(silver 의 dbt 검증) · 멈춤(commerce_collect_watchdog) · 기록 없음(weather_traffic_bronze)
--   관측 공백(commerce·citydata 외 도메인의 매트릭스 빈 칸) · 환경 섞임(smp_e10, dev)
--   미등록(weather_collect_obs·citydata_collect — 상태는 있는데 기대치 행이 없다)
--   감시 제외(monitored=0) · 로그 번들 있음/없음(log_bundle_key)
-- run_event 는 대표 발췌라 집계표와 1:1 이 아니다 — 화면 경로 확인용이다.

DELETE FROM _ops_run_event WHERE event_id LIKE 'smp_%';
DELETE FROM _ops_daily_metric WHERE updated_at = 'sample';
DELETE FROM _ops_pipeline_state WHERE updated_at = 'sample';
DELETE FROM _ops_pipeline_expectation WHERE updated_at = 'sample';

-- ── 기대치 (S 표). commerce 9종은 실측(ASK-Seoul#78 §9, 오너 확인 2026-07-31)이고
--    타 도메인 dag_id 는 예시다. max_delay_minutes = "이보다 오래 조용하면 살펴본다" 한도.
INSERT INTO _ops_pipeline_expectation
  (dag_id, domain, trigger_type, expected_interval, upstream, max_delay_minutes, schedule_timezone, monitored, owner, owner_confirmed_on, updated_at) VALUES
  ('commerce_collect_raw',      'commerce', 'schedule', '일 1회 00:00',            NULL,                   1560, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_recollect_raw',    'commerce', 'schedule', '6시간',                   NULL,                    420, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_ops_logship',      'commerce', 'schedule', '일 1회 01:30',            NULL,                   1560, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_load_bronze',      'commerce', 'schedule', '일 1회 04:00',            NULL,                   1560, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_load_silver',      'commerce', 'schedule', '일 1회 05:00',            NULL,                   1560, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_load_gold',        'commerce', 'schedule', '일 1회 06:00',            NULL,                   1560, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_collect_watchdog', 'commerce', 'schedule', '하루 4회(08·12·16·20시)', NULL,                    780, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_serving_export',   'commerce', 'trigger',  NULL,                      'commerce_load_gold',    180, 'Asia/Seoul', 1, 'Exisign',        '2026-07-31', 'sample'),
  ('commerce_load_gold_refresh','commerce', 'manual',   NULL,                      NULL,                   NULL, 'Asia/Seoul', 0, 'Exisign',        '2026-07-31', 'sample'),
  ('culture_bronze',            'culture',  'schedule', '일 1회 03:00',            NULL,                   1560, 'Asia/Seoul', 1, 'yooseongjin527', '2026-07-30', 'sample'),
  ('citydata_transform_cosmos', 'citydata', 'trigger',  NULL,                      'citydata bronze 완료',  360, 'Asia/Seoul', 1, 'kang-gyeongmin', '2026-07-30', 'sample'),
  ('transit_collect_daily',     'transit',  'schedule', '일 1회',                  NULL,                   1560, 'Asia/Seoul', 1, 'codingpoppy94',  '2026-07-30', 'sample'),
  ('weather_traffic_bronze',    'weather',  'trigger',  NULL,                      'raw 완료 확인서',       240, 'Asia/Seoul', 1, 'masondev1024',   '2026-07-30', 'sample');

-- ── 현재 상태 (C-9). watchdog 는 이틀째 조용하다(멈춤 후보 시연).
--    weather_traffic_bronze 는 행 자체가 없다("기록 없음" 시연 — LEFT JOIN 이 비운다).
INSERT INTO _ops_pipeline_state
  (dag_id, domain, last_event_id, last_status, last_observed_at, last_observed_date_kst, last_run_id, event_count_observed, observation_state, reconciled_through, updated_at) VALUES
  ('commerce_collect_raw',      'commerce', 'smp_e01', 'success', '2026-08-02T15:41:00Z', '2026-08-03', 'scheduled__2026-08-02T15:00:00', 26, 'unverified', '2026-08-01', 'sample'),
  ('commerce_recollect_raw',    'commerce', NULL,      'skipped', '2026-08-02T21:12:00Z', '2026-08-03', 'scheduled__2026-08-02T21:00:00', 52, 'unverified', '2026-08-01', 'sample'),
  ('commerce_ops_logship',      'commerce', NULL,      'success', '2026-08-02T16:45:00Z', '2026-08-03', 'scheduled__2026-08-02T16:30:00', 13, 'complete',   '2026-08-02', 'sample'),
  ('commerce_load_bronze',      'commerce', 'smp_e04', 'success', '2026-08-02T19:07:00Z', '2026-08-03', 'scheduled__2026-08-02T19:00:00', 13, 'complete',   '2026-08-02', 'sample'),
  ('commerce_load_silver',      'commerce', NULL,      'success', '2026-08-02T20:05:00Z', '2026-08-03', 'scheduled__2026-08-02T20:00:00', 13, 'complete',   '2026-08-02', 'sample'),
  ('commerce_load_gold',        'commerce', 'smp_e13', 'success', '2026-08-02T21:03:00Z', '2026-08-03', 'scheduled__2026-08-02T21:00:00', 13, 'complete',   '2026-08-02', 'sample'),
  ('commerce_collect_watchdog', 'commerce', 'smp_e02', 'success', '2026-08-01T11:05:00Z', '2026-08-01', 'scheduled__2026-08-01T11:00:00', 41, 'complete',   '2026-08-01', 'sample'),
  ('commerce_serving_export',   'commerce', 'smp_e06', 'success', '2026-08-02T21:20:00Z', '2026-08-03', 'triggered__2026-08-02T21:18:00', 12, 'unverified', '2026-08-01', 'sample'),
  ('culture_bronze',            'culture',  NULL,      'success', '2026-08-02T18:30:00Z', '2026-08-03', 'scheduled__2026-08-02T18:00:00',  8, 'unverified', NULL,         'sample'),
  ('citydata_transform_cosmos', 'citydata', NULL,      'success', '2026-08-02T22:40:00Z', '2026-08-03', 'triggered__2026-08-02T22:35:00', 17, 'unverified', NULL,         'sample'),
  ('transit_collect_daily',     'transit',  NULL,      'success', '2026-08-02T17:00:00Z', '2026-08-03', 'scheduled__2026-08-02T16:00:00', 22, 'complete',   '2026-08-02', 'sample'),
  -- **미등록 시연** — 상태는 있는데 기대치(_ops_pipeline_expectation) 행이 없다.
  -- "감시 제외"가 아니라 "아직 등록 안 됨"이고, 화면은 이 둘을 구분해야 한다(#7 코멘트 5).
  -- 실측 근거: 기대 주기는 현재 commerce 9건만 등록돼 있고 타 도메인은 등록 요청 중이다.
  ('weather_collect_obs',       'weather',  NULL,      'success', '2026-08-02T14:20:00Z', '2026-08-03', 'scheduled__2026-08-02T14:00:00', 31, 'unverified', NULL,         'sample'),
  ('citydata_collect',          'citydata', NULL,      'success', '2026-08-03T01:10:00Z', '2026-08-03', 'scheduled__2026-08-03T01:00:00', 44, 'partial',    NULL,         'sample');

-- ── 날짜×도메인×단계 집계 (D-7 이 읽는 표).
--    commerce 는 관문 배선이 끝나 단계가 채워지고, citydata 는 raw 만 시작됐다.
--    나머지 도메인 행이 없는 것 = 관문 이전(관측 공백) — 매트릭스의 빈 칸이 곧 관측이다.
INSERT INTO _ops_daily_metric
  (observed_date_kst, domain, layer, event_count, success_count, failed_count, skipped_count, degraded_count, retried_run_count, empty_run_count, row_count_sum, rows_observed_count, rows_unknown_count, duration_s_sum, api_call_count_sum, retry_count_sum, failure_count_sum, updated_at) VALUES
  ('2026-07-25', 'commerce', 'gold',   1, 0, 1, 0, 0, 0, 0, NULL,   0, 1, 1830.0,  NULL, 0, 1, 'sample'),
  ('2026-07-28', 'commerce', 'raw',    3, 3, 0, 0, 0, 0, 0, 51210,  3, 0, 1490.5,  118,  0, 0, 'sample'),
  ('2026-07-29', 'commerce', 'raw',    3, 3, 0, 0, 0, 0, 0, 49873,  3, 0, 1512.0,  121,  0, 0, 'sample'),
  ('2026-07-30', 'commerce', 'raw',    3, 3, 0, 0, 0, 0, 0, 50944,  3, 0, 1533.2,  119,  0, 0, 'sample'),
  ('2026-07-31', 'commerce', 'raw',    4, 3, 1, 0, 0, 1, 0, 50102,  3, 1, 2210.7,  163,  1, 1, 'sample'),
  ('2026-08-01', 'commerce', 'raw',    3, 3, 0, 0, 0, 0, 0, 52377,  3, 0, 1488.9,  120,  0, 0, 'sample'),
  ('2026-08-02', 'commerce', 'raw',    3, 2, 0, 1, 0, 0, 0, 34251,  2, 1, 1002.3,   80,  0, 0, 'sample'),
  ('2026-08-03', 'commerce', 'raw',    3, 3, 0, 0, 0, 0, 0, 51840,  3, 0, 1501.1,  122,  0, 0, 'sample'),
  ('2026-07-28', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 18102,  1, 0,  301.0,  NULL, 0, 0, 'sample'),
  ('2026-07-29', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 17966,  1, 0,  295.4,  NULL, 0, 0, 'sample'),
  ('2026-07-30', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 18240,  1, 0,  310.2,  NULL, 0, 0, 'sample'),
  ('2026-07-31', 'commerce', 'bronze', 2, 1, 1, 0, 0, 1, 0, 18004,  1, 1,  744.9,  NULL, 1, 1, 'sample'),
  ('2026-08-01', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 18377,  1, 0,  305.5,  NULL, 0, 0, 'sample'),
  ('2026-08-02', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 18129,  1, 0,  298.7,  NULL, 0, 0, 'sample'),
  ('2026-08-03', 'commerce', 'bronze', 1, 1, 0, 0, 0, 0, 0, 18455,  1, 0,  303.9,  NULL, 0, 0, 'sample'),
  ('2026-08-01', 'commerce', 'silver', 6, 6, 0, 0, 0, 0, 0, 36112,  2, 4, 1120.0,  NULL, 0, 0, 'sample'),
  ('2026-08-02', 'commerce', 'silver', 6, 6, 0, 0, 0, 0, 0, 35987,  2, 4, 1098.4,  NULL, 0, 0, 'sample'),
  ('2026-08-03', 'commerce', 'silver', 6, 6, 0, 0, 0, 0, 0, 36240,  2, 4, 1104.8,  NULL, 0, 0, 'sample'),
  ('2026-07-28', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30281,  1, 0, 1795.2,  NULL, 0, 0, 'sample'),
  ('2026-07-29', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30107,  1, 0, 1810.6,  NULL, 0, 0, 'sample'),
  ('2026-07-30', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30455,  1, 0, 1822.1,  NULL, 0, 0, 'sample'),
  ('2026-07-31', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30322,  1, 0, 1841.3,  NULL, 0, 0, 'sample'),
  ('2026-08-01', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30588,  1, 0, 1799.8,  NULL, 0, 0, 'sample'),
  ('2026-08-02', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30414,  1, 0, 2712.4,  NULL, 0, 0, 'sample'),
  ('2026-08-03', 'commerce', 'gold',   1, 1, 0, 0, 0, 0, 0, 30690,  1, 0, 1808.0,  NULL, 0, 0, 'sample'),
  ('2026-08-01', 'commerce', 'd1',     1, 1, 0, 0, 0, 0, 1, 0,      1, 0,   88.2,  NULL, 0, 0, 'sample'),
  ('2026-08-02', 'commerce', 'd1',     1, 1, 0, 0, 0, 0, 0, 29874,  1, 0,   91.5,  NULL, 0, 0, 'sample'),
  ('2026-08-03', 'commerce', 'd1',     1, 1, 0, 0, 0, 0, 0, 30102,  1, 0,   90.1,  NULL, 0, 0, 'sample'),
  ('2026-08-01', 'citydata', 'raw',    2, 2, 0, 0, 0, 0, 0,  9210,  2, 0,  412.0,   36,  0, 0, 'sample'),
  ('2026-08-02', 'citydata', 'raw',    2, 2, 0, 0, 0, 0, 0,  9187,  2, 0,  405.6,   36,  0, 0, 'sample'),
  ('2026-08-03', 'citydata', 'raw',    2, 1, 1, 0, 0, 0, 0,  4522,  1, 1,  702.3,   40,  0, 1, 'sample');

-- ── 기록 1건 대표 발췌 (F 표). 집계표와 1:1 이 아니다 — 목록 화면의 경로 확인용.
INSERT INTO _ops_run_event
  (event_id, schema_version, domain, layer, grain, dag_id, task_id, run_id, try_number, is_final_try, environment, observed_at, started_at, ended_at, duration_s, duration_hms, observed_date_kst, source_path_date, schedule_delay_s, row_count, rows_source, bytes, api_name, api_call_count, retry_count, failure_count, sink_type, sink_target, status, error_ref, quality, publication_id, product_id, product_ids, source_category, source_key, log_bundle_key, ingested_at) VALUES
  ('smp_e01', 'ops/v1', 'commerce', 'raw',    'airflow_task', 'commerce_collect_raw',      'collect_store_dir',   'scheduled__2026-08-02T15:00:00', 1, 1, 'prod', '2026-08-02T15:41:00Z', '2026-08-02T15:32:28Z', '2026-08-02T15:41:00Z',  512.0, '00:08:32', '2026-08-03', '2026-08-03', 148.0,  18432, 'collection_manifest', 21430221, 'seoul.commerce', 41, 0, 0, 'file',  'raw/commerce/store_dir/',            'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/commerce/observed_date=2026-08-03/smp_e01.json', NULL, '2026-08-02T16:50:00Z'),
  ('smp_e02', 'ops/v1', 'commerce', 'raw',    'airflow_task', 'commerce_collect_watchdog', 'watch_gaps',          'scheduled__2026-08-01T11:00:00', 1, 1, 'prod', '2026-08-01T11:05:00Z', '2026-08-01T11:04:12Z', '2026-08-01T11:05:00Z',   48.0, '00:00:48', '2026-08-01', '2026-08-01',  62.0,   NULL, 'not_applicable',      NULL,     NULL,             NULL, 0, 0, NULL,   NULL,                                  'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/commerce/observed_date=2026-08-01/smp_e02.json', NULL, '2026-08-01T16:40:00Z'),
  ('smp_e03', 'ops/v1', 'commerce', 'bronze', 'airflow_task', 'commerce_load_bronze',      'load_partition',      'scheduled__2026-07-31T19:00:00', 1, 0, 'prod', '2026-07-31T19:12:00Z', '2026-07-31T19:04:05Z', '2026-07-31T19:12:00Z',  475.0, '00:07:55', '2026-08-01', '2026-08-01', 240.0,   NULL, 'unknown',             NULL,     NULL,             NULL, 0, 1, 'table', 'commerce.bronze_store_dir',           'failed',  'ops/errors/commerce/observed_date=2026-08-01/e03.json', NULL, NULL, NULL, NULL, 'runs', 'ops/runs/commerce/observed_date=2026-08-01/smp_e03.json', NULL, '2026-08-01T16:40:00Z'),
  ('smp_e04', 'ops/v1', 'commerce', 'bronze', 'airflow_task', 'commerce_load_bronze',      'load_partition',      'scheduled__2026-07-31T19:00:00', 2, 1, 'prod', '2026-07-31T19:31:00Z', '2026-07-31T19:22:41Z', '2026-07-31T19:31:00Z',  499.0, '00:08:19', '2026-08-01', '2026-08-01', 240.0,  18004, 'bronze_rows_inserted', NULL,    NULL,             NULL, 1, 1, 'table', 'commerce.bronze_store_dir',           'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/commerce/observed_date=2026-08-01/smp_e04.json', NULL, '2026-08-01T16:40:00Z'),
  ('smp_e05', 'ops/v1', 'commerce', 'gold',   'airflow_task', 'commerce_load_gold',        'build_sales_mart',    'scheduled__2026-07-24T21:00:00', 1, 1, 'prod', '2026-07-24T21:31:00Z', '2026-07-24T21:00:30Z', '2026-07-24T21:31:00Z', 1830.0, '00:30:30', '2026-07-25', '2026-07-25',  30.0,   NULL, 'unknown',             NULL,     NULL,             NULL, 0, 1, 'table', 'commerce.gold_sales_daily',           'failed',  'ops/errors/commerce/observed_date=2026-07-25/e05.json', NULL, NULL, NULL, NULL, 'runs', 'ops/runs/commerce/observed_date=2026-07-25/smp_e05.json', NULL, '2026-08-02T02:10:00Z'),
  ('smp_e06', 'ops/v1', 'commerce', 'd1',     'publication',  'commerce_serving_export',   'export_to_d1',        'triggered__2026-07-31T21:18:00', 1, 1, 'prod', '2026-07-31T21:20:00Z', '2026-07-31T21:18:32Z', '2026-07-31T21:20:00Z',   88.2, '00:01:28', '2026-08-01', '2026-08-01',  12.0,      0, 'publication_ledger',  NULL,     NULL,             NULL, 0, 0, 'db',    'd1:commerce_sales_daily',             'success', NULL, NULL, 'pub_smp_0801', 'commerce_sales_daily', NULL, 'product-events', 'ops/product-events/commerce/observed_date=2026-08-01/smp_e06.json', NULL, '2026-08-01T16:40:00Z'),
  ('smp_e07', 'ops/v1', 'commerce', 'silver', 'dbt_node',     'commerce_load_silver',      'not_null_silver_store_id', 'scheduled__2026-08-02T20:00:00', 1, 1, 'prod', '2026-08-02T20:04:00Z', '2026-08-02T20:03:41Z', '2026-08-02T20:04:00Z', 19.0, '00:00:19', '2026-08-03', '2026-08-03', NULL, NULL, 'not_applicable',  NULL,     NULL,             NULL, 0, 0, NULL,   NULL,                                  'success', NULL, NULL, NULL, NULL, NULL, 'metrics', 'ops/metrics/commerce/observed_date=2026-08-03/smp_e07.json', NULL, '2026-08-02T21:40:00Z'),
  ('smp_e08', 'ops/v1', 'citydata', NULL,     'airflow_task', 'citydata_bronze',           'load_bronze',         'scheduled__2026-08-02T18:00:00', 1, NULL, 'prod', '2026-08-02T18:22:00Z', NULL,                NULL,                     NULL,   NULL,     '2026-08-03', '2026-08-02', NULL,   NULL, 'unknown',             NULL,     NULL,             NULL, NULL, 1, NULL, NULL,                                  'failed',  'ops/errors/citydata/load_date=2026-08-02/e08.json', NULL, NULL, NULL, NULL, 'errors', 'ops/errors/citydata/load_date=2026-08-02/e08.json', NULL, '2026-08-02T21:40:00Z'),
  ('smp_e09', 'ops/v1', 'transit',  'raw',    'airflow_task', 'transit_collect_daily',     'collect_timetable',   'scheduled__2026-08-02T16:00:00', 1, 1, 'prod', '2026-08-02T17:00:00Z', '2026-08-02T16:57:00Z', '2026-08-02T17:00:00Z',  180.0, '00:03:00', '2026-08-03', '2026-08-03', 5820.0, 8102, 'collection_manifest', 902114,  'seoul.transit',  12, 0, 0, 'file',  'raw/transit/timetable/',              'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/transit/observed_date=2026-08-03/smp_e09.json', NULL, '2026-08-02T21:40:00Z'),
  ('smp_e10', 'ops/v1', 'weather',  'raw',    'airflow_task', 'weather_collect_obs',       'collect_asos',        'scheduled__2026-08-02T10:00:00', 1, 1, 'dev',  '2026-08-02T10:12:00Z', '2026-08-02T10:09:00Z', '2026-08-02T10:12:00Z',  180.0, '00:03:00', '2026-08-02', '2026-08-02',  90.0,  1440, 'collection_manifest', 210443,  'kma.asos',        6, 0, 0, 'file',  'raw/weather/asos/',                   'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/weather/observed_date=2026-08-02/smp_e10.json', NULL, '2026-08-02T21:40:00Z'),
  ('smp_e11', 'ops/v1', 'citydata', 'raw',    'airflow_task', 'citydata_collect',          'collect_citydata',    'scheduled__2026-08-02T22:00:00', 1, 1, 'prod', '2026-08-02T22:31:00Z', '2026-08-02T22:24:00Z', '2026-08-02T22:31:00Z',  420.0, '00:07:00', '2026-08-03', '2026-08-03',  55.0,  4522, 'collection_manifest', 5120031, 'seoul.citydata', 20, 0, 0, 'file',  'raw/citydata/pop/',                   'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/citydata/observed_date=2026-08-03/smp_e11.json', NULL, '2026-08-03T02:10:00Z'),
  ('smp_e12', 'ops/v1', 'culture',  NULL,     'airflow_task', 'culture_bronze',            'recover_partition',   'manual__2026-08-02T18:00:00',    1, 1, 'prod', '2026-08-02T18:30:00Z', NULL,                  NULL,                    NULL,   NULL,     '2026-08-03', '2026-08-02', NULL,   NULL, 'unknown',             NULL,     NULL,             NULL, 0, 0, NULL,   NULL,                                  'success', NULL, NULL, NULL, NULL, NULL, 'recovery', 'ops/recovery/culture/load_date=2026-08-02/e12.json', NULL, '2026-08-03T02:10:00Z'),
  ('smp_e13', 'ops/v1', 'commerce', 'gold',   'airflow_task', 'commerce_load_gold',        'build_sales_mart',    'scheduled__2026-08-02T21:00:00', 1, 1, 'prod', '2026-08-02T21:03:00Z', '2026-08-02T20:17:48Z', '2026-08-02T21:03:00Z', 2712.4, '00:45:12', '2026-08-03', '2026-08-03',  25.0,  30414, 'iceberg_added_records', NULL,   NULL,             NULL, 0, 0, 'table', 'commerce.gold_sales_daily',           'success', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/commerce/observed_date=2026-08-03/smp_e13.json', NULL, '2026-08-03T02:10:00Z'),
  ('smp_e14', 'ops/v1', 'commerce', 'raw',    'airflow_task', 'commerce_recollect_raw',    'recollect_changed',   'scheduled__2026-08-02T09:00:00', 1, 1, 'prod', '2026-08-02T09:02:00Z', '2026-08-02T09:01:40Z', '2026-08-02T09:02:00Z',   20.0, '00:00:20', '2026-08-02', '2026-08-02',  35.0,   NULL, 'not_applicable',     NULL,     NULL,             NULL, 0, 0, NULL,   NULL,                                  'skipped', NULL, NULL, NULL, NULL, NULL, 'runs',   'ops/runs/commerce/observed_date=2026-08-02/smp_e14.json', NULL, '2026-08-02T21:40:00Z');

-- ── 로그 원문 번들 (#7 코멘트 4) — `log_bundle_key` 는 그 run 의 텍스트 로그
--    tar.gz(R2) 위치다. 번들이 **하루 1회 뒤늦게** 올라오므로 당일 실행은 NULL 이 정상이고,
--    지난 실행에만 붙는다. 화면이 이 둘을 "대기"와 경로로 구분해 보여주는지 확인하는 표본이다.
--    (실측 2026-08-04: 운영 D1 15,873건 중 log_bundle_key 가 붙은 건 0건 — ASAC-DAG 확인 요청)
UPDATE _ops_run_event SET log_bundle_key =
  'ops/logs/' || domain || '/observed_date=' || observed_date_kst || '/' || dag_id || '.tar.gz'
WHERE event_id LIKE 'smp_%' AND observed_date_kst <= '2026-08-01';
