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

-- 🔴 0002 는 **남의 표를 만드는 파일**이라 더 조심해야 한다 (2026-08-05, decision/0015).
--
-- 이 파일은 조회 DB 4종이 **없는** 곳(옛 로컬 Miniflare)에서 화면을 돌려보려고 만든
-- 미러였다. D1 이 운영 하나뿐이 되면서 그 전제가 사라졌다 — 운영에는 ASAC-DAG 적재기가
-- 만든 진짜 표가 이미 있고, 거기엔 실측 수만 행이 들어 있다.
--
-- ⚠️ 그대로 apply 하면 `CREATE TABLE IF NOT EXISTS` 는 무해하게 넘어가지만
--    **`CREATE INDEX IF NOT EXISTS` 3개가 `_ops_run_event` 에 실제로 만들어진다.**
--    남의 운영 표에 인덱스를 얹는 것은 우리가 할 일이 아니다(CLAUDE.md §6 소유 경계) —
--    스키마 판단은 정본 소유자의 몫이고, 라이브 표에 인덱스를 거는 비용도 그쪽 몫이다.
--
-- 그래서 **표가 이미 있으면 실행하지 않고 장부에만 적는다.** 표가 없는 곳(새 D1)에서는
-- 그대로 실행돼 미러가 생긴다 — 두 경우 다 맞게 동작한다.
INSERT INTO d1_migrations_ops_dashboard(name)
SELECT '0002_ops_records.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_run_event')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_daily_metric')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_pipeline_state')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_ops_pipeline_expectation')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations_ops_dashboard WHERE name='0002_ops_records.sql');
