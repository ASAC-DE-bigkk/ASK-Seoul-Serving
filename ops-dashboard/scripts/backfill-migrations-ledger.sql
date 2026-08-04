-- d1_migrations 장부 백필 — 증분 전환(#78 D-6) 이전에 만들어진 상태용.
--
-- 콘솔의 `_ops_*` 는 예전에 DROP+CREATE 로 통째 리셋했다. 이제 적용 여부의 정본이
-- "사람이 기억"에서 D1 안의 장부로 바뀌는데, 전환 이전 DB 는 표가 이미 있는데 장부가
-- 없다. 그대로 apply 하면 wrangler 가 0001 을 다시 실행하려 든다(지금은 IF NOT EXISTS 라
-- 무해하지만, 앞으로 붙을 ALTER 파일은 그렇지 않다).
--
-- 그래서 **그 파일이 만든 표가 실제로 있을 때만** 장부에 소급 기록한다.
--   · 새 DB          → 아무것도 기록 안 됨 → apply 가 전부 실행 (정상 경로)
--   · 기존 DB        → 0001 만 기록 → apply 가 건너뜀 (전환 경로)
-- 게이트웨이(../marketplace/scripts/backfill-migrations-ledger.sql)와 같은 방식이다.
--
-- ⚠️ 여기서 다루는 것은 **콘솔 소유 표뿐**이다. 파이프라인 4종·게이트웨이 표는
--    소유자가 자기 장부로 관리한다 — 남의 표를 이 장부에 적지 않는다.
--
-- 표 이름은 wrangler.toml 의 `migrations_table` 과 같아야 한다 — 게이트웨이와 D1 을
-- 공유하므로 기본 이름(`d1_migrations`)을 쓰면 두 프로젝트 기록이 한 표에 섞인다.
-- 스키마는 wrangler 가 만드는 것과 동일해야 한다(실측 사본).
CREATE TABLE IF NOT EXISTS d1_migrations_ops_dashboard(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations_ops_dashboard(name)
SELECT '0001_ops_slo.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_slo')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_domain')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations_ops_dashboard WHERE name='0001_ops_slo.sql');
