-- _request_log 이름 충돌 검사 — 배포 전 필수
--
-- **왜 이 파일이 있나**: `migrations/0002_request_log.sql` 은 `CREATE TABLE IF NOT EXISTS` 다.
-- 다른 주체가 같은 이름을 **선점하고 있으면 조용히 넘어간다.** 그러면 게이트웨이가 없는
-- 컬럼(route·status·table_name·key_hash)에 INSERT 하다 실패하는데, 그 INSERT 는
-- `ctx.waitUntil` 안이라 응답에 영향을 주지 않고 **요청 로그가 전량 버려진다.**
-- 로컬에서 이미 한 번 겪은 형태다(0004 누락 → 몇 주간 전량 유실, #23 에서 수리).
--
-- **실측(2026-08-04)**: 운영·개발 D1 에 `(ts, path, query, token)` 4컬럼 표가 선점돼 있고
-- 389~401행이 7/21 부터 쌓여 있었다. 조사 결과 **transit·citydata 쪽에서 쓰던 표**이고,
-- **운영자 협의로 게이트웨이 스키마로 정리하는 데 합의**했다(../../docs/agreement.md §2).
-- 기존 행은 보존 대상이 아니다 — `query`·`token` 은 수집 원칙("값이 아니라 축만")상
-- 애초에 남기면 안 되는 값이다.
--
-- **사용법**: 배포 전 런북 0번에서 `--remote` 로 돌린다.
--   verdict 가 'OK' 가 아니면 **배포하지 말고** agreement.md §2-1 절차로 정리한 뒤 진행한다.
--   `IF NOT EXISTS` 는 이 사실을 숨기므로 마이그레이션만 믿으면 안 된다.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
      THEN 'OK: 표가 없다 — 마이그레이션이 새로 만든다'
    WHEN (SELECT COUNT(*) FROM pragma_table_info('_request_log')
          WHERE name IN ('route','table_name','status','key_hash','filters','row_count','ms')) = 7
      THEN 'OK: 게이트웨이 스키마다'
    ELSE 'STOP: 다른 스키마의 표가 이름을 선점하고 있다 — agreement.md §2-1 절차로 정리할 것'
  END AS verdict,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_request_log') AS table_exists,
  (SELECT group_concat(name, ', ') FROM pragma_table_info('_request_log')) AS actual_columns;
