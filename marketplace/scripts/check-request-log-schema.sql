-- 요청 로그 표 상태 점검 — 배포 전 확인 (ASAC-DAG#681)
--
-- **배경**: 같은 D1 에 `_request_log` 라는 이름의 **다른 표**가 있다. 팀 계정에 배포된
-- 우리 워커 두 개(`ask-seoul-citydata-api`·`ask-seoul-transit-api`)가 그 이름으로
-- `(ts, path, query)` 를 쓴다. 실제 표는 `(ts, path, query, token)` 4컬럼이고 2026-07-21
-- 부터 쌓였다 — 게이트웨이(7/28)보다 먼저다.
--
-- **그래서 나중에 고른 우리가 비켰다** — 게이트웨이는 `_gw_request_log` 를 쓴다
-- (`migrations/0005_rename_request_log.sql`). 남의 표는 **건드리지 않는다.** 그 워커들은
-- 지금도 배포돼 있고 소스가 레포에 없어서, 지우면 살아 있는 배포본이 깨진다.
--
-- **이 점검이 확인하는 것**: 우리 표가 제대로 서 있고, 옛 이름과 얽히지 않았나.
--   ⚠️ `_request_log`(옛 이름)에 게이트웨이 컬럼이 보이면 개명이 안 끝난 것이다.
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM pragma_table_info('_gw_request_log')
          WHERE name IN ('route','table_name','status','key_hash','filters','row_count','ms')) = 7
      THEN 'OK: 게이트웨이 표(_gw_request_log)가 정상이다'
    WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_gw_request_log')
      THEN 'STOP: _gw_request_log 가 없다 — 마이그레이션(0005)을 적용할 것'
    ELSE 'STOP: _gw_request_log 스키마가 정본과 다르다'
  END AS verdict,
  (SELECT group_concat(name, ', ') FROM pragma_table_info('_gw_request_log')) AS gw_columns,
  -- 옛 이름 쪽. 남의 표면 조치 대상이 아니고, 우리 옛 표면 **행이 남았는지**가 관건이다.
  -- 빈 껍데기는 무해하다 — DROP 을 못 쓰는 이유(같은 이름을 남이 쓸 수 있다)가 그대로라
  -- 0005 는 행만 비우고 표는 남긴다.
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
      THEN '없음'
    WHEN (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name = 'route') = 0
      THEN '남의 표(워커 접근 로그) — 건드리지 않는다'
    WHEN (SELECT COUNT(*) FROM _request_log) > 0
      THEN '⚠️ 우리 옛 데이터가 남아 있다 — 0005 를 적용할 것'
    ELSE '빈 껍데기(개명 완료 잔재) — 무해'
  END AS legacy_request_log,
  (SELECT group_concat(name, ', ') FROM pragma_table_info('_request_log')) AS legacy_columns;
