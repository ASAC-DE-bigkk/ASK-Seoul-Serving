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
--
-- 스키마는 wrangler 가 만드는 것과 동일해야 한다(실측 사본). 팀 전체 로컬 상태가
-- 장부를 갖게 되면 이 파일과 시드 체인의 이 단계는 지워도 된다.
CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations(name)
SELECT '0001_keys_usage.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_keys')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0001_keys_usage.sql');
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
