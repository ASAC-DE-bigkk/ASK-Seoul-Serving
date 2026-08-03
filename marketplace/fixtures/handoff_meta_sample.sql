-- 서빙 메타 보조 4종 — **로컬 개발용 미러 + 표본** (ASAC-DAG#638 §2)
--
-- 🔑 이 테이블들의 스키마 정본은 파이프라인이다(`ASAC-DAG common/serving/d1_client.py`
--    의 HANDOFF_COLUMN_TYPES). 여기 DDL 은 그걸 그대로 옮긴 사본이고, marketplace 가
--    소유권을 주장하는 게 아니다 — 그래서 migrations/ 가 아니라 fixtures/ 에 둔다.
--    정본이 바뀌면 여기를 따라 고치고, 임의로 컬럼을 더하지 않는다.
--
-- 표본 구성은 의도적으로 불균등하다. /v1 번들이 두 경우를 다 처리해야 하기 때문이다:
--   commerce_dong_category_matrix — 컬럼·구조·패턴이 다 있는 제품
--   culture_activity_by_dong      — 구조만 있고 컬럼 설명·패턴이 없는 제품
--                                   (실제로 culture 는 아직 게시 전이다 — ASAC-DAG#668)
-- 값은 #638·#642 문서의 예시를 그대로 썼다(지어낸 수치 아님).

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
 ('commerce_dong_category_matrix','d1_dong_category_matrix','gold_license_dong_category_matrix','행정동×업종','["admin_dong","category"]',NULL,'d1_table','none','local-fixture'),
 -- 구조만 있고 컬럼 설명·패턴이 없는 제품 — 번들의 강등 경로 검증용
 ('culture_activity_by_dong','gold_culture_activity_by_dong','gold_culture_activity_by_dong','행정동×날짜','["admin_dong_code","event_date"]','event_date',NULL,NULL,'local-fixture');

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
