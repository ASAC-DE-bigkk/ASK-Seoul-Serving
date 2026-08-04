-- d1_migrations 장부 백필 — 추적 전환(#27) 이전에 만들어진 로컬 상태용.
--
-- 시드가 `wrangler d1 migrations apply` 로 넘어가면서, 적용 여부의 정본이
-- "사람이 기억"에서 D1 안의 장부(d1_migrations)로 바뀌었다. 문제는 전환 이전의
-- 로컬 상태다 — 마이그레이션은 이미 적용됐는데 장부가 없어서, 첫 apply 가
-- 전부를 재실행하려 들고 0004(ALTER)에서 죽는다.
--
-- 그래서 각 파일이 만든 객체가 **실제로 존재할 때만** 장부에 소급 기록한다.
--   · 새 DB          → 아무것도 기록 안 됨 → apply 가 전부 실행 (정상 경로)
--   · 손으로 적용된 DB → 존재하는 것만 기록 → apply 가 건너뜀 (전환 경로)
--   · 0004 만 빠진 DB → 0001~0003 만 기록 → apply 가 0004 만 실행 (유실 사고 치유)
--   · **남의 `_request_log` 가 있는 DB → 0004 도 기록** → apply 가 남의 표를 안 건드림 (아래)
--
-- 스키마는 wrangler 가 만드는 것과 동일해야 한다(실측 사본). 팀 전체 로컬 상태가
-- 장부를 갖게 되면 이 파일과 시드 체인의 이 단계는 지워도 된다.
--
-- ⚠️ 이 파일은 **기록만 한다** — 표를 만들거나 고치지 않는다. 판정이 틀리면 손해는
-- 여기가 아니라 그 다음에 도는 `migrations apply` 에서 난다. 그래서 판정을 실제
-- 스키마에서 읽고, 애매하면 "이미 적용됨"으로 기울인다(실행 안 함 = 안전한 쪽).
CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations(name)
SELECT '0001_keys_usage.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_keys')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0001_keys_usage.sql');
-- 0002 는 이름만 보고 기록한다. 그 표가 남의 것이어도 무해하다 — 0002 는
-- `CREATE TABLE IF NOT EXISTS` 라 실행돼도 어차피 no-op 이기 때문이다. 다만 그래서
-- **이 기록은 "우리 표가 있다"는 뜻이 아니다.** 이름 충돌 여부는 여기가 아니라
-- `check-request-log-schema.sql` 이 판정한다.
INSERT INTO d1_migrations(name)
SELECT '0002_request_log.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0002_request_log.sql');
INSERT INTO d1_migrations(name)
SELECT '0003_burst.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_burst')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0003_burst.sql');
INSERT INTO d1_migrations(name)
SELECT '0004_request_id.sql'
WHERE EXISTS (SELECT 1 FROM pragma_table_info('_request_log') WHERE name='request_id')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0004_request_id.sql');

-- 여기 있는 `_request_log` 가 **우리 표가 아니면** 0004 는 할 일이 없다 — 기록만 하고
-- 넘어간다. 우리 표의 표식은 `route` 컬럼이다(0002 가 만든 것 중 남이 쓸 리 없는 이름).
--
-- 이 절이 없으면 다음이 일어난다. 실측(2026-08-04, 읽기만):
--   prod `_request_log` = (ts, path, query, token) — 남의 표, request_id 없음
--   → 위 절이 "0004 아직 안 됨"으로 읽고 → apply 가 `ALTER TABLE _request_log
--     ADD COLUMN request_id` 를 **남의 표에** 실행한다.
-- 위 주석의 "유실 사고 치유"가 이 상황에서는 정확히 반대로 작동한다 — 치유가 아니라
-- 오염이고, 되돌리려면 남의 표를 또 건드려야 한다. ALTER 는 조건을 못 다니 여기서 막는다.
--
-- 우리 표가 있는데 request_id 만 없는 경우(진짜 치유 대상)는 `route` 가 있으므로
-- 이 절에 걸리지 않는다 — 기록 안 됨 → apply 가 0004 를 실행한다. 두 절은 겹치지 않는다.
INSERT INTO d1_migrations(name)
SELECT '0004_request_id.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
  AND NOT EXISTS (SELECT 1 FROM pragma_table_info('_request_log') WHERE name='route')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0004_request_id.sql');
