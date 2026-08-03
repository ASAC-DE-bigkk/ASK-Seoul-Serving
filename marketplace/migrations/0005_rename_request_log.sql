-- `_request_log` → `_gw_request_log` 개명 — 이름 충돌 완전 회피 (ASAC-DAG#681)
--
-- **왜 개명하나**: 같은 D1 에 `_request_log` 라는 이름의 **다른 표**가 이미 있다.
-- 팀 계정에 배포된 우리 워커 두 개(`ask-seoul-citydata-api`·`ask-seoul-transit-api`)가
--   INSERT INTO _request_log (ts, path, query) VALUES (?, ?, ?)
-- 로 쓰고 있고, 실제 표는 `(ts, path, query, token)` 4컬럼이다. 게이트웨이 정본은
-- `(ts, route, table_name, status, key_hash, filters, row_count, ms, request_id)` 9컬럼이라
-- 겹치는 것이 `ts` 하나뿐이다.
--
-- 먼저 있던 쪽이 그 워커들이다(2026-07-21 ~). 게이트웨이는 7/28 에 같은 이름을 골랐다.
-- **양보하는 쪽이 이름을 바꾸는 게 맞고, 나중에 고른 우리가 바꾼다.**
--
-- **왜 표를 지우지 않고 개명만 하나**: 그 워커들은 지금도 배포돼 있고 소스가 레포에 없다.
-- 우리가 `_request_log` 를 건드리면 살아 있는 배포본이 깨진다. 손대지 않고 **비켜선다.**
--
-- 이 파일은 세 경우를 다 통과해야 한다 — 마이그레이션은 어느 환경에서든 같게 끝나야 한다.
--   ① 로컬(우리 9컬럼 표만 있다)        → RENAME 으로 옮긴다
--   ② 원격(남의 4컬럼 표만 있다)         → 우리 것이 없으므로 새로 만든다. 남의 표는 그대로 둔다
--   ③ 이미 개명됨(재실행)                → 아무것도 하지 않는다
--
-- SQLite 에는 조건부 DDL 이 없어 `ALTER TABLE ... RENAME` 을 조건에 따라 건너뛸 수 없다.
-- 그래서 **새 표를 먼저 만들고**(항상 안전) **있으면 옮겨 담는** 순서로 짠다.

-- 1) 게이트웨이 정본 스키마로 새 표를 만든다. 이미 있으면 넘어간다.
CREATE TABLE IF NOT EXISTS _gw_request_log (
  ts         TEXT    NOT NULL,  -- ISO8601 UTC
  route      TEXT    NOT NULL,  -- catalog | preview | data | me | keys
  table_name TEXT,              -- 조회 대상 (해당 없으면 NULL)
  status     INTEGER NOT NULL,
  key_hash   TEXT,              -- 인증 요청만. 익명은 NULL
  filters    TEXT,              -- 사용한 필터 컬럼명 CSV — 값은 저장하지 않는다
  row_count  INTEGER,           -- 응답 행수 (0행이 반복되면 그 자체가 신호)
  ms         INTEGER,           -- 처리 시간
  request_id TEXT               -- 응답 헤더 x-request-id 와 같은 값 (0004 에서 추가된 축)
);

CREATE INDEX IF NOT EXISTS idx_gw_request_log_ts ON _gw_request_log (ts);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_table ON _gw_request_log (table_name, ts);

-- 2) 옛 표가 **우리 것일 때만** 기록을 옮긴다.
--    `route` 컬럼의 존재가 판별자다 — 남의 표(ts·path·query·token)에는 없다.
--    SELECT 가 0행이면 아무것도 안 들어가므로, 남의 표가 있어도 안전하다.
INSERT INTO _gw_request_log (ts, route, table_name, status, key_hash, filters, row_count, ms, request_id)
SELECT ts, route, table_name, status, key_hash, filters, row_count, ms, request_id
FROM _request_log
WHERE (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name = 'route') = 1
  AND (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name = 'request_id') = 1
  -- 재실행 안전 — 이미 옮겼으면 다시 넣지 않는다
  AND (SELECT COUNT(*) FROM _gw_request_log) = 0;

-- 3) 옮겨 담았으면 **우리 옛 표만** 비운다.
--    남의 표(route 컬럼이 없다)는 이 UPDATE 가 한 행도 건드리지 않는다 — 조건이 거짓이라
--    WHERE 가 0행을 고른다. 이름을 비켜준 뒤에도 옛 이름에 우리 흔적이 남아 있으면
--    "개명이 끝났나"를 판정할 수 없다(점검 스크립트가 ⚠️ 를 낸다).
--
--    ⚠️ DROP 을 쓰지 않는다. 같은 이름을 **남이 쓰고 있을 수 있어서**다 —
--    우리 것인지 아닌지를 SQLite DDL 로는 조건부 판정할 수 없다. 대신 행만 비우고,
--    빈 껍데기는 그대로 둔다(로컬 전용 잔재라 해가 없다).
DELETE FROM _request_log
WHERE (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name = 'route') = 1
  AND (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name = 'request_id') = 1
  AND (SELECT COUNT(*) FROM _gw_request_log) > 0;
