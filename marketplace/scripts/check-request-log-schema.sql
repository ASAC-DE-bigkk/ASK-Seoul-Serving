-- 남의 표 무손상 확인 — 배포 전후 필수 (agreement §2-5 4단계)
--
-- **역할이 바뀌었다.** 예전엔 "우리 표 이름을 남이 선점했나"를 보는 충돌 검사였는데,
-- `0005` 로 게이트웨이가 `_gateway_request_log` 로 비키면서 충돌 자체가 없어졌다.
-- 지금 이 파일이 답하는 질문은 하나다 — **우리가 남의 표를 건드리지 않았는가.**
--
-- 왜 계속 필요한가: `_request_log` 는 transit 워커 소유로 남아 있고(#44 §2), 우리
-- 마이그레이션 `0004` 는 조건을 달 수 없는 `ALTER TABLE _request_log ADD COLUMN` 이다.
-- 장부(`d1_migrations`)가 비어 있는 D1 에 apply 를 돌리면 그 ALTER 가 재실행돼
-- **남의 표에 우리 컬럼이 붙는다.** dev D1 에서 실제로 일어난 일이고, 그래서
-- `scripts/backfill-migrations-ledger.sql` 이 `route` 컬럼 유무로 우리 표인지를 가른다(PR #50).
--
-- ⚠️ **행 수만 보면 못 잡는다.** ALTER 로 컬럼이 붙는 사고는 행 수가 그대로다.
--    그래서 컬럼 수를 같이 본다.
--
-- 실측 기준(2026-08-04, 읽기만): prod 4컬럼 `ts·path·query·token` ·
-- dev 5컬럼(= 위 사고로 `request_id` 가 이미 얹혀 있다. 그 자체가 이 검사가 필요한 증거다).
--
-- **사용법**: 원격 적용 전후로 돌려 값이 **변하지 않았음**을 본다.
--   `npm run preflight` 가 같은 것을 보지만, 이건 apply 직후 한 줄로 확인하는 용도다.

-- 판정은 **두 축의 조합**으로 한다. 이름만 보면 로컬이 오탐한다 — 로컬에는 `0002` 가 만든
-- 우리 옛 표가 그 이름으로 남아 있고, 그건 사고가 아니다.
--   · 남의 축(`path`·`query`·`token`) = transit 워커가 만든 표의 표식
--   · 우리 축(`route`)                = 게이트웨이 스키마의 표식
-- 둘이 **한 표에 같이 있으면** 그게 오염이다. 우리 컬럼이 하나만 얹혀도(dev 의 `request_id`)
-- 남의 축은 그대로라 이 조합으로 잡힌다.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
      THEN 'OK: 그 이름의 표가 없다'
    WHEN EXISTS (SELECT 1 FROM pragma_table_info('_request_log') WHERE name IN ('path','query','token'))
     AND EXISTS (SELECT 1 FROM pragma_table_info('_request_log') WHERE name IN ('route','request_id','product_id','env'))
      THEN 'STOP: 남의 표에 우리 컬럼이 얹혔다 — 우리 마이그레이션이 손댄 것이다'
    WHEN EXISTS (SELECT 1 FROM pragma_table_info('_request_log') WHERE name IN ('path','query','token'))
      THEN 'OK: 남의 표 그대로 — 컬럼 수를 대조할 것 (prod 4 · dev 5)'
    ELSE 'OK: 0002 가 만든 우리 옛 표다 (로컬). 게이트웨이는 이제 _gateway_request_log 를 쓴다'
  END AS verdict,
  (SELECT COUNT(*) FROM _request_log) AS rows,
  (SELECT COUNT(*) FROM pragma_table_info('_request_log')) AS cols,
  (SELECT group_concat(name, ', ') FROM pragma_table_info('_request_log')) AS actual_columns;
