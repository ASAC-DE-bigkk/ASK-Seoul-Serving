-- 서빙 메타 보조 4종 — **로컬 개발용 미러 + 표본** (ASAC-DAG#638 §2)
--
-- 🔑 이 테이블들의 스키마 정본은 파이프라인이다(`ASAC-DAG common/serving/d1_client.py`
--    의 HANDOFF_COLUMN_TYPES). 여기 DDL 은 그걸 그대로 옮긴 사본이고, marketplace 가
--    소유권을 주장하는 게 아니다 — 그래서 migrations/ 가 아니라 fixtures/ 에 둔다.
--    정본이 바뀌면 여기를 따라 고치고, 임의로 컬럼을 더하지 않는다.
--
-- 표본 구성:
--   commerce_dong_category_matrix — #638·#642 문서의 예시를 그대로 옮긴 표본
--   culture 외부 7종               — 정본(culture gold yml, ASAC-DBT#346 + #600 패턴 15건)
--                                   에서 스크립트로 생성한 전체 메타(아래 culture 블록 주석)
-- "메타가 아예 없는 제품"의 강등 경로는 여기 없는 나머지 제품(transit 등 55종)이
-- 그대로 검증한다 — 표본을 일부러 비워 둘 필요가 없어졌다.

CREATE TABLE IF NOT EXISTS "d1_catalog_columns" ("product_id" TEXT NOT NULL, "table_name" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "column_name" TEXT NOT NULL, "type" TEXT NOT NULL, "description_ko" TEXT, "publication_id" TEXT NOT NULL, PRIMARY KEY ("product_id", "column_name"));
CREATE TABLE IF NOT EXISTS "d1_catalog_ext" ("product_id" TEXT NOT NULL, "table_name" TEXT NOT NULL, "source_model" TEXT NOT NULL, "grain" TEXT, "primary_key" TEXT NOT NULL, "time_axis" TEXT, "tier" TEXT, "rollup_rule" TEXT, "publication_id" TEXT NOT NULL, PRIMARY KEY ("product_id"));
CREATE TABLE IF NOT EXISTS "d1_usage_patterns" ("product_id" TEXT NOT NULL, "pattern_id" TEXT NOT NULL, "question_ko" TEXT, "sql" TEXT NOT NULL, "axes" TEXT, "requires" TEXT NOT NULL, "verified_rows" INTEGER, "verified_at" TEXT, "verified_publication_id" TEXT, "allow_empty" INTEGER NOT NULL DEFAULT 0, "insight_sample_ko" TEXT, "publication_id" TEXT NOT NULL, PRIMARY KEY ("product_id", "pattern_id"));
CREATE TABLE IF NOT EXISTS "d1_catalog_glossary" ("vocabulary_id" TEXT NOT NULL, "code" TEXT NOT NULL, "label_ko" TEXT NOT NULL, "origin" TEXT NOT NULL, "source_type" TEXT NOT NULL, "exported_at" TEXT NOT NULL, PRIMARY KEY ("vocabulary_id", "code"));

-- 표본만 지우고 다시 넣는다(자기 범위 DELETE — 실적재와 섞이지 않게)
DELETE FROM "d1_catalog_columns" WHERE publication_id = 'local-fixture';
DELETE FROM "d1_catalog_ext"     WHERE publication_id = 'local-fixture';
DELETE FROM "d1_usage_patterns"  WHERE publication_id = 'local-fixture';
DELETE FROM "d1_catalog_glossary" WHERE exported_at = 'local-fixture';

INSERT INTO "d1_catalog_columns" ("product_id","table_name","ordinal","column_name","type","description_ko","publication_id") VALUES
 ('commerce_dong_category_matrix','d1_dong_category_matrix',0,'admin_dong','TEXT','행정동 이름.','local-fixture'),
 ('commerce_dong_category_matrix','d1_dong_category_matrix',1,'gu','TEXT','자치구 이름.','local-fixture'),
 ('commerce_dong_category_matrix','d1_dong_category_matrix',2,'category','TEXT','업종 대분류.','local-fixture'),
 ('commerce_dong_category_matrix','d1_dong_category_matrix',3,'active_cnt','INTEGER','영업(01) 업소 수.','local-fixture'),
 ('commerce_dong_category_matrix','d1_dong_category_matrix',4,'opened_last_365d','INTEGER','최근 365일 개업 수(동네 활력 — 개업일 보유분 기준).','local-fixture');

INSERT INTO "d1_catalog_ext" ("product_id","table_name","source_model","grain","primary_key","time_axis","tier","rollup_rule","publication_id") VALUES
 ('commerce_dong_category_matrix','d1_dong_category_matrix','gold_license_dong_category_matrix','행정동×업종','["admin_dong","category"]',NULL,'d1_table','none','local-fixture');
 -- culture_activity_by_dong 의 "구조만 있는 표본"은 culture 블록의 전체 메타로 대체됐다

INSERT INTO "d1_usage_patterns" ("product_id","pattern_id","question_ko","sql","axes","requires","verified_rows","verified_at","verified_publication_id","allow_empty","insight_sample_ko","publication_id") VALUES
 ('commerce_dong_category_matrix','vital_dongs_top','최근 1년 개업이 가장 활발한 동네는?',
  '-- :n=10
SELECT admin_dong, gu, opened_last_365d, active_cnt
FROM d1_dong_category_matrix
WHERE admin_dong IS NOT NULL
ORDER BY opened_last_365d DESC LIMIT :n',
  '동 랭킹 — 최근 1년 개업 수 DESC','["select_columns","sort"]',10,NULL,NULL,0,
  '목1동이 최근 1년 817곳 신규로 1위(활성 대비 40.8%).','local-fixture');

INSERT INTO "d1_catalog_glossary" ("vocabulary_id","code","label_ko","origin","source_type","exported_at") VALUES
 ('commerce:major','health','보건','commerce','code_table','local-fixture'),
 ('commerce:major','food','음식','commerce','code_table','local-fixture');

-- ── culture 외부 7종 (ASAC-DBT #346 + #600 usage_patterns 15건 — 77c0d29 기준 생성) ──
-- 아래 블록은 스크립트 생성물이다: 정본은 culture gold yml 이고, 손으로 고치지 않는다.

INSERT INTO "d1_catalog_columns" ("product_id","table_name","ordinal","column_name","type","description_ko","publication_id") VALUES
 ('culture_activity_by_dong','gold_culture_activity_by_dong',0,'admin_dong_code','TEXT','행정동 코드 — 행정안전부 표준 10자리. 다른 행정동 데이터와 붙이는 조인 키','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',1,'admin_dong','TEXT','행정동 이름(예 명동)','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',2,'gu_code','TEXT','자치구 코드(구 롤업 키)','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',3,'gu','TEXT','자치구 이름(예 중구)','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',4,'stat_region_cd','TEXT','통계청 집계구 코드 — 통계청 인구·가구 통계와 붙일 때 사용','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',5,'event_date','TEXT','활동 일자(KST). 여러 날에 걸친 행사는 날짜마다 한 행으로 펼쳐진다','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',6,'activities_count','INTEGER','그날 그 동에서 열린 전체 문화활동 수 — 아래 유형별 건수의 합','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',7,'performances_count','INTEGER','KOPIS 공연 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',8,'events_count','INTEGER','서울시 문화행사 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',9,'festivals_count','INTEGER','서울시 축제 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',10,'exhibitions_count','INTEGER','SeMA 전시 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',11,'sejong_count','INTEGER','세종문화회관 공연 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',12,'kcisa_count','INTEGER','KCISA 국립문화기관 행사 수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',13,'free_events_count','INTEGER','그날 그 동의 무료 문화행사 수. 유·무료 표기는 서울시 문화행사 출처에만 있어 그 범위의 건수','local-fixture'),
 ('culture_activity_by_dong','gold_culture_activity_by_dong',14,'edu_experience_events_count','INTEGER','그날 그 동의 교육·체험 분류 행사 수','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',0,'performance_id','TEXT','KOPIS 공연 식별자(mt20id) — 공연 한 편당 하나, 이 표의 기본 키','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',1,'performance_name','TEXT','공연명','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',2,'genre','TEXT','KOPIS 장르 원문','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',3,'venue_name','TEXT','공연장 이름','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',4,'event_start_date','TEXT','공연 시작일(KST)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',5,'event_end_date','TEXT','공연 종료일(KST)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',6,'first_seen_date','TEXT','이 공연이 예매 top50에 처음 등장한 스냅샷 일(KST)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',7,'last_seen_date','TEXT','마지막으로 top50에 있던 스냅샷 일(KST)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',8,'days_on_chart','INTEGER','예매 순위표에 등장한 누적 일수 — 체류 기간','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',9,'best_rank','INTEGER','이력 중 가장 높았던 순위(숫자가 작을수록 상위, 1이 최상위)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',10,'best_rank_date','TEXT','best_rank 를 처음 달성한 스냅샷 일(KST)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',11,'days_to_peak','INTEGER','첫 등장부터 최고 순위에 도달하기까지 걸린 일수','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',12,'first_rank','INTEGER','첫 등장일의 순위(진입 순위)','local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve',13,'last_rank','INTEGER','마지막 스냅샷의 순위(현재 순위)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',0,'snapshot_date','TEXT','순위를 집계한 날(YYYY-MM-DD). 문자열로 저장된다','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',1,'rank_no','INTEGER','예매 순위(1=최다) — snapshot_date 안에서 유일','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',2,'performance_id','TEXT','KOPIS 공연 식별자(mt20id) — 공연 상세 정보와 붙이는 조인 키','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',3,'performance_name','TEXT','공연명','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',4,'genre','TEXT','KOPIS 장르(연극·뮤지컬·클래식 등 원문 분류)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',5,'venue_name','TEXT','공연장 이름','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',6,'event_start_date','TEXT','공연 시작일(KST)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',7,'event_end_date','TEXT','공연 종료일(KST)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',8,'perf_count','INTEGER','상연 횟수(KOPIS 원문)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',9,'seat_count','INTEGER','공연장 좌석 수 — 공연 규모를 가늠하는 값','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',10,'gu_code','TEXT','공연장이 속한 자치구 코드','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',11,'gu','TEXT','공연장 자치구 이름','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',12,'rank_prev_3d','INTEGER','3일 전 같은 공연의 순위. 그때 순위표에 없었으면 비어 있다','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',13,'rank_delta_3d','INTEGER','순위 상승폭(3일 전 순위 − 오늘 순위). 양수면 상승, 비어 있으면 신규 또는 재진입','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',14,'days_on_chart','INTEGER','이 공연이 순위표에 등장한 누적 일수(오늘 포함)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',15,'is_new_entry','INTEGER','어제는 없다가 오늘 진입했는지 여부(첫 진입·재진입 공통)','local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily',16,'momentum_status','TEXT','순위 모멘텀: new(어제 부재)·rising(순위 상승)·falling(하락)·steady(변동 없음/추세 미정)','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',0,'gu_code','TEXT','자치구 코드','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',1,'gu','TEXT','자치구 이름','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',2,'event_date','TEXT','활동 일자(KST). 여러 날에 걸친 행사는 날짜마다 한 행으로 펼쳐진다','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',3,'total_events','INTEGER','그날 그 구에서 열린 전체 문화활동 수 — "볼 게 많은 날" 지표','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',4,'distinct_types','INTEGER','그날 열린 활동 유형 수(공연·행사·축제·전시·세종·kcisa 중 몇 종) — 다양성','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',5,'busiest_type','TEXT','그날 가장 많이 열린 활동 유형(동수 시 임의 1개)','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',6,'busiest_type_count','INTEGER','가장 많이 열린 유형의 행사 수 — 같은 유형끼리의 경쟁 규모','local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density',7,'concentration','REAL','경쟁 집중도(busiest_type_count / total_events, 0~1) — 1=한 유형 독점, 낮을수록 다양','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',0,'gu_code','TEXT','자치구 코드 — 혼잡 관측과 행사 데이터를 잇는 공통 키','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',1,'gu','TEXT','자치구 이름','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',2,'day_of_week','INTEGER','요일(1=월요일 … 7=일요일)','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',3,'hour_of_day','INTEGER','시각(0~23, KST). 최근 18일 관측을 요일×시각 칸으로 모아 계산했다','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',4,'avg_ppltn','INTEGER','그 시간대 그 자치구 주요 지점의 평균 실시간 인구(명)','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',5,'avg_congest_score','REAL','평균 혼잡 점수(여유 1 · 보통 2 · 약간 붐빔 3 · 붐빔 4). 높을수록 붐빈다','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',6,'typical_congest','TEXT','그 시간대 최빈 혼잡 레벨(여유/보통/약간 붐빔/붐빔)','local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd',7,'crowd_samples','INTEGER','계산에 사용한 관측 건수 — 값이 클수록 신뢰도가 높다','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',0,'event_ref','TEXT','행사 고유 키. 출처 접두어가 붙는다(예 performance:12345)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',1,'event_type','TEXT','행사 출처 유형 — 목록에서 아이콘·필터로 쓰기 좋은 축','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',2,'title','TEXT','행사명(원문)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',3,'category','TEXT','소스별 분류/장르 원문(값 체계는 event_type 마다 다름 — 통합 분류 아님)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',4,'venue_name','TEXT','개최 장소 이름','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',5,'is_free','TEXT','유·무료 원문 값(varchar — 소스별 표기가 달라 원문 보존, 예 "무료"/"유료"/요금 문구)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',6,'event_start_date','TEXT','행사 시작일(KST)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',7,'event_end_date','TEXT','행사 종료일(KST) — 기간 겹침 질의의 우측 경계','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',8,'event_at','TEXT','행사 시작 시각(KST) — 기간 조회의 표준 필터 컬럼','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',9,'gu','TEXT','자치구 이름','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',10,'gu_code','TEXT','자치구 코드','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',11,'admin_dong','TEXT','행정동 이름. quality_status 가 dong_precise 일 때만 신뢰할 수 있다','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',12,'admin_dong_code','TEXT','행정동 코드 — 행정안전부 표준 10자리','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',13,'latitude','REAL','위도(WGS84) — 좌표 없는 소스는 null','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',14,'longitude','REAL','경도(WGS84)','local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule',15,'quality_status','TEXT','위치 정밀도 — dong_precise(행정동까지 확정) / gu_only(자치구까지) / unmatched(미확정)','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',0,'admin_dong_code','TEXT','행정동 코드 — 행정안전부 표준 10자리. 이 표의 기본 키','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',1,'admin_dong','TEXT','행정동 이름','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',2,'gu_code','TEXT','자치구 코드','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',3,'gu','TEXT','자치구 이름','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',4,'events_upcoming_90d','INTEGER','앞으로 90일간 예정된 문화행사·활동 총량','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',5,'performances_upcoming_90d','INTEGER','앞으로 90일간 예정된 공연 수','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',6,'dining_active_cnt','INTEGER','영업 중인 음식점 수(식품 인허가 기준). 음식점 데이터가 연결되지 않은 동은 비어 있다','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',7,'dining_opened_365d','INTEGER','최근 365일간 새로 문을 연 음식점 수 — 상권 활력 지표','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',8,'has_dining_data','INTEGER','음식점 데이터가 연결된 동인지 여부. false 면 음식점 관련 값과 점수가 모두 비어 있다','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',9,'culture_events_pctl','REAL','426개 동 중 문화행사량 백분위(0~1, 클수록 상위)','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',10,'dining_stock_pctl','REAL','음식점 데이터가 있는 219개 동 중 음식점 수 백분위(0~1)','local-fixture'),
 ('culture_dine_around','gold_culture_dine_around',11,'dine_around_score','REAL','문화 백분위와 음식점 백분위의 기하평균(0~1). 둘 다 높아야 점수가 높다','local-fixture');

INSERT INTO "d1_catalog_ext" ("product_id","table_name","source_model","grain","primary_key","time_axis","tier","rollup_rule","publication_id") VALUES
 ('culture_activity_by_dong','gold_culture_activity_by_dong','gold_culture_activity_by_dong','행정동×날짜마다 한 행','["admin_dong_code", "event_date"]','event_date',NULL,NULL,'local-fixture'),
 ('culture_booking_curve','gold_culture_booking_curve','gold_culture_booking_curve','공연(performance_id)마다 한 행','["performance_id"]',NULL,NULL,NULL,'local-fixture'),
 ('culture_boxoffice_daily','gold_culture_boxoffice_daily','gold_culture_boxoffice_daily','스냅샷일×순위마다 한 행','["snapshot_date", "rank_no"]','snapshot_date',NULL,NULL,'local-fixture'),
 ('culture_calendar_density','gold_culture_calendar_density','gold_culture_calendar_density','구×날짜마다 한 행','["gu_code", "event_date"]','event_date',NULL,NULL,'local-fixture'),
 ('culture_event_crowd','gold_culture_event_crowd','gold_culture_event_crowd','구×요일×시간대마다 한 행','["gu_code", "day_of_week", "hour_of_day"]',NULL,NULL,NULL,'local-fixture'),
 ('culture_event_schedule','gold_culture_event_schedule','gold_culture_event_schedule','행사(event_ref)마다 한 행','["event_ref"]','event_start_date',NULL,NULL,'local-fixture'),
 ('culture_dine_around','gold_culture_dine_around','gold_culture_dine_around','행정동(admin_dong_code)마다 한 행','["admin_dong_code"]',NULL,NULL,NULL,'local-fixture');

INSERT INTO "d1_usage_patterns" ("product_id","pattern_id","question_ko","sql","axes","requires","verified_rows","verified_at","verified_publication_id","allow_empty","insight_sample_ko","publication_id") VALUES
 ('culture_activity_by_dong','free_edu_dongs','무료·교육체험 행사가 많은 동네(행정동)는 어디인가?','-- :from, :n=10
SELECT admin_dong, gu, SUM(free_events_count) AS free_cnt,
       SUM(edu_experience_events_count) AS edu_cnt
FROM gold_culture_activity_by_dong
WHERE event_date >= :from
GROUP BY admin_dong, gu ORDER BY free_cnt + edu_cnt DESC LIMIT :n
','동 랭킹 — 기간 합산 free+edu DESC','["select_columns", "aggregate", "group_by", "sort"]',10,'2026-07-31','d45c9031b04b460ab6a946b6fefa15fb',0,'사직동이 7월 무료 1,024·교육체험 671건으로 1위.','local-fixture'),
 ('culture_activity_by_dong','exhibition_dongs','전시 많이 하는 동네는 어디인가?','-- :from, :n=10
SELECT admin_dong, gu, SUM(exhibitions_count) AS ex_cnt
FROM gold_culture_activity_by_dong
WHERE event_date >= :from
GROUP BY admin_dong, gu ORDER BY ex_cnt DESC LIMIT :n
','동 랭킹 — 기간 합산 exhibitions DESC','["select_columns", "aggregate", "group_by", "sort"]',10,'2026-07-31','d45c9031b04b460ab6a946b6fefa15fb',0,'하계2동 691건 — 서울시립 북서울미술관 효과.','local-fixture'),
 ('culture_booking_curve','steady_sellers','오래 랭킹에 머무는 스테디셀러 공연은?','-- :n=10
SELECT performance_name, genre, venue_name, days_on_chart, best_rank, last_rank
FROM gold_culture_booking_curve
ORDER BY days_on_chart DESC LIMIT :n
','랭킹 — days_on_chart DESC','["select_columns", "sort"]',10,'2026-07-31','29988004f0674314a067d4c40652208f',0,'DAY6 서울 공연이 31일 최장 체류.','local-fixture'),
 ('culture_boxoffice_daily','rising_now','요즘 예매 순위가 오르는 공연은?','-- :status(momentum_status), :n=10
SELECT rank_no, performance_name, genre, venue_name, rank_delta_3d
FROM gold_culture_boxoffice_daily
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gold_culture_boxoffice_daily)
  AND momentum_status = :status
ORDER BY rank_no LIMIT :n
','최신 스냅샷 필터(momentum_status) — rank_no ASC','["select_columns", "subquery", "sort"]',10,'2026-07-31','f7f793bca4d44edfa388848ec04a1560',1,'최신 스냅샷 rising 10건 — 1위 드라큘라.','local-fixture'),
 ('culture_boxoffice_daily','genre_top','특정 장르(국악·클래식 등)에서 지금 인기 공연은?','-- :genre, :n=10
SELECT rank_no, performance_name, venue_name, days_on_chart
FROM gold_culture_boxoffice_daily
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gold_culture_boxoffice_daily)
  AND genre = :genre
ORDER BY rank_no LIMIT :n
','최신 스냅샷 필터(genre) — rank_no ASC','["select_columns", "subquery", "sort"]',2,'2026-07-31','f7f793bca4d44edfa388848ec04a1560',1,'클래식은 랭킹 내 2건 — 장르별 결과 수 편차가 큼을 명시할 것.','local-fixture'),
 ('culture_boxoffice_daily','new_entries','랭킹에 새로 들어온 공연은?','-- :n=10
SELECT rank_no, performance_name, genre, venue_name
FROM gold_culture_boxoffice_daily
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gold_culture_boxoffice_daily)
  AND is_new_entry = 1
ORDER BY rank_no LIMIT :n
','최신 스냅샷 필터(is_new_entry=1) — rank_no ASC','["select_columns", "subquery", "sort"]',2,'2026-07-31','f7f793bca4d44edfa388848ec04a1560',1,'신규 진입 2건 — 9위 대중음악 공연 포함.','local-fixture'),
 ('culture_calendar_density','calm_days','행사가 적어서 한산하게 다닐 만한 날이 언제인가?','-- :gu, :from, :to, :n=10
SELECT event_date, total_events, busiest_type
FROM gold_culture_calendar_density
WHERE gu = :gu AND event_date BETWEEN :from AND :to
ORDER BY total_events ASC, event_date LIMIT :n
','랭킹 — total_events ASC (기간 내)','["select_columns", "sort"]',10,'2026-07-31','7ed8eddecfac4ba283ce075c26b2d45d',0,'상한 없는 검증에선 2027-05-10(1건)이 1위로 떴다 — :to 필수.','local-fixture'),
 ('culture_calendar_density','crowded_days','행사가 몰리는 날(피해야 할 날)이 언제인가?','-- :from, :to, :n=10
SELECT event_date, gu, total_events, concentration, busiest_type
FROM gold_culture_calendar_density
WHERE event_date >= :from ORDER BY total_events DESC LIMIT :n
','랭킹 — total_events DESC','["select_columns", "sort"]',10,'2026-07-31','7ed8eddecfac4ba283ce075c26b2d45d',0,'7/31 중구 235건 · concentration 0.47 이 최다.','local-fixture'),
 ('culture_event_crowd','quiet_hours_in_gu','이 구는 언제(요일×시간) 제일 한산한가?','-- :gu, :n=10
SELECT day_of_week, hour_of_day, typical_congest, avg_congest_score
FROM gold_culture_event_crowd
WHERE gu = :gu ORDER BY avg_congest_score ASC LIMIT :n
','랭킹 — avg_congest_score ASC','["select_columns", "sort"]',10,'2026-07-31','2ba3ce94ac734d0487dfd93fa4999f55',0,'종로구 최한산 = 일(7) 02시, 혼잡점수 1(여유).','local-fixture'),
 ('culture_event_crowd','gu_day_profile','이 구의 특정 요일은 시간대별로 얼마나 붐비나?','-- :gu, :dow(1=월..7=일), :n=24
SELECT hour_of_day, avg_ppltn, typical_congest
FROM gold_culture_event_crowd
WHERE gu = :gu AND day_of_week = :dow ORDER BY hour_of_day LIMIT :n
','프로파일 — hour_of_day ASC (요일 고정)','["select_columns", "sort"]',24,'2026-07-31','2ba3ce94ac734d0487dfd93fa4999f55',0,'송파구 토요일 24시간 프로파일 — 00시 avg_ppltn 8,236(여유).','local-fixture'),
 ('culture_event_schedule','gu_window','이번 주(기간)에 이 구에서 무슨 문화행사가 하나?','-- :gu, :from, :to, :n=10
SELECT title, category, venue_name, is_free, event_start_date, event_end_date
FROM gold_culture_event_schedule
WHERE gu = :gu AND event_start_date <= :to AND event_end_date >= :from
ORDER BY event_start_date LIMIT :n
','기간 겹침 필터(gu) — event_start_date ASC','["select_columns", "filter_range", "sort"]',10,'2026-07-31','fd823392eac44937946e5481921223e2',0,'종로구에서 해당 주간 진행·개막 10건 — 뮤지컬 ''스폿라이트'' 등.','local-fixture'),
 ('culture_event_schedule','free_in_gu','이 구에서 하는 무료 행사가 있나?','-- :gu, :from, :n=10
SELECT title, category, venue_name, event_start_date, event_end_date
FROM gold_culture_event_schedule
WHERE gu = :gu AND is_free = ''무료'' AND event_end_date >= :from
ORDER BY event_start_date LIMIT :n
','필터(gu, is_free=''무료'') — event_start_date ASC','["select_columns", "filter_range", "sort"]',1,'2026-07-31','fd823392eac44937946e5481921223e2',1,'양천구 무료 1건 — 서울문화예술교육센터 상설 체험(교육/체험, ~10/8).','local-fixture'),
 ('culture_event_schedule','category_upcoming','특정 장르(국악·전시 등) 행사가 어디서 하나?','-- :category, :from, :n=10
SELECT title, gu, venue_name, event_start_date, event_end_date
FROM gold_culture_event_schedule
WHERE category = :category AND event_end_date >= :from
ORDER BY event_start_date LIMIT :n
','필터(category) — event_start_date ASC','["select_columns", "filter_range", "sort"]',10,'2026-07-31','fd823392eac44937946e5481921223e2',0,'국악 진행·예정 10건 — 삼청각 수요 상설 공연 등.','local-fixture'),
 ('culture_event_schedule','today_in_gu','오늘 당장 이 구(또는 근처)에서 하는 행사는?','-- :gu, :today, :n=10
SELECT title, category, venue_name, event_start_date, event_end_date
FROM gold_culture_event_schedule
WHERE gu = :gu AND event_start_date <= :today AND event_end_date >= :today
ORDER BY event_start_date DESC LIMIT :n
','필터(gu, 오늘이 기간 안) — event_start_date DESC','["select_columns", "filter_range", "sort"]',10,'2026-07-31','fd823392eac44937946e5481921223e2',1,'gu_window 의 :from=:to=오늘 특수형.','local-fixture'),
 ('culture_dine_around','hotspots','행사 많은 동네 주변 외식 상권은 어디인가?','-- :n=10
SELECT admin_dong, gu, events_upcoming_90d, dining_active_cnt, dine_around_score
FROM gold_culture_dine_around
WHERE has_dining_data = 1
ORDER BY dine_around_score DESC LIMIT :n
','동 랭킹 — dine_around_score DESC','["select_columns", "sort"]',10,'2026-07-31','8a03a1e6d2ec48eeb02cf5bf2b5e5c35',0,'종로1·2·3·4가동 — 90일 내 행사 240건·요식업 3,529곳.','local-fixture');

INSERT INTO "d1_catalog_glossary" ("vocabulary_id","code","label_ko","origin","source_type","exported_at") VALUES
 ('culture:event_type','performance','공연(KOPIS 공연목록)','culture','warehouse','local-fixture'),
 ('culture:event_type','event','서울시 문화행사','culture','warehouse','local-fixture'),
 ('culture:event_type','festival','축제(KOPIS 축제목록)','culture','warehouse','local-fixture'),
 ('culture:event_type','exhibition','전시(서울시립미술관)','culture','warehouse','local-fixture'),
 ('culture:event_type','sejong','세종문화회관 공연·전시','culture','warehouse','local-fixture'),
 ('culture:event_type','kcisa','문화포털 행사(한국문화정보원)','culture','warehouse','local-fixture');
