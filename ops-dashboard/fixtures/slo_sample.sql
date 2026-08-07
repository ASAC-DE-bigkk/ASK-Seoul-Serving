-- 로컬 검증용 **합성** SLO (ASK-Seoul#58) — 실측이 아니다.
--
-- 팀 D1 쓰기가 금지돼 있어 실제 gold_culture_slo_daily 를 가져올 수 없다. 화면 동작을
-- 확인하려면 데이터가 있어야 하므로 14일치를 합성해 둔다. 모든 행에 is_sample=1 이 박혀
-- 있고 UI 는 그걸 읽어 '샘플' 배지를 띄운다 — 이 데이터로 운영 판단을 하면 안 된다.
-- 실적재 경로가 붙으면 이 파일은 지운다.

-- 🔴 **운영 D1 에 돌리지 않는다.** D1 이 운영 하나뿐이라(0015) 이 합성 14일치를 넣으면
-- 그게 곧 운영 오염이다. 화면은 `is_sample=1` 행을 질의에서 아예 뺀다.

DELETE FROM _ops_slo;

-- 분야 등록부는 여기 없다 — `fixtures/ops_domain.sql` 이 정본이고, **그건 합성이 아니라
-- 참조 내용이라 운영에 돌려도 된다.** 예전에는 이 파일이 등록부까지 들고 있어서 둘이 묶여
-- 있었고, 그래서 운영 등록부가 0행으로 남았다(라벨이 전부 영문 코드로 노출).

-- culture 14일치 (합성). 7/22 정기런 실패·7/25 부분 실패를 넣어 화면의 경고 경로를 확인한다
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-15',1,1,99.5,0,0,41900,4.1,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-16',1,1,99.4,0,0,39273,4.4,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-17',1,1,98.6,0,0,42646,4.1,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-18',1,1,99.1,0,0,38925,3.9,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-19',1,1,99.1,0,0,38368,3.2,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-20',1,1,97.0,0,0,38923,3.3,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-21',1,1,96.9,0,0,42491,5.1,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-22',0,1,71.4,2,1,43997,3.1,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-23',1,1,97.2,0,0,39234,2.8,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-24',1,1,96.2,0,0,42396,3.2,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-25',0,0,42.9,4,3,43619,4.0,1,0,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-26',1,1,96.9,0,0,39029,4.0,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-27',1,1,98.6,0,0,42972,3.2,1,1,1);
INSERT INTO _ops_slo (domain,event_date,scheduled_slo_passed,eod_slo_passed,best_coverage_pct,failed_dataset_count,violation_count,total_rows,ingest_duration_min,transform_runs,transform_all_success,is_sample) VALUES ('culture','2026-07-28',1,1,97.0,0,0,38335,5.4,1,1,1);
