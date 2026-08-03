# 0007 — `_ops_*` 마이그레이션은 증분이다 (DROP+CREATE 리셋 폐지)

- 상태: **개정** (2026-08) — 초판(2026-07)의 "단일 파일 DROP+CREATE 리셋"을 **폐지**한다
- 관련: [0003](0003-single-shared-local-d1.md)(공유 D1) · [0005](0005-slo-snapshot-to-d1.md)(공급자)
- 근거 규약: **ASK-Seoul#78 D-6**

## 왜 바뀌었나

초판의 전제는 **"리셋이 공짜"** 였다 — `_ops_slo` 내용물은 로더나 픽스처가 매번 다시 채우니
잃을 상태가 없다는 것. 그 전제가 깨졌다.

- **#78 D-6**: "대시보드 마이그레이션이 `DROP TABLE IF EXISTS` 로 시작한다. 팀 조회 DB 에
  테이블을 만들기 **전에** 증분 방식으로 바꿔야 한다. **안 바꾸면 첫 스키마 수정이 팀
  데이터를 지운다.**"
- 파이프라인은 이미 같은 D1 에 실행 기록을 싣고 있다(ASAC-DAG#647 · #655). 콘솔이 거기
  붙는 순간 "다시 채우면 그만"인 값이 아니게 된다.
- 파이프라인 쪽 정본(`common/ops/d1_ops.py`)은 이미 이 규약을 지킨다 —
  `create_table_statement()` 주석이 **"이 모듈은 DROP 을 만들지 않는다(D-6)"**. 콘솔만 어겼다.

## 결정

- **`migrations/` 에 DROP 을 쓰지 않는다.** 표 생성은 `CREATE TABLE IF NOT EXISTS` 뿐이고,
  컬럼이 늘면 **새 파일에 ALTER 를 추가**한다. `0001_ops_slo.sql` 은 더 이상 고치지 않는다.
- **적용 여부는 D1 안의 장부가 추적한다** — `wrangler d1 migrations apply`. 사람이
  "어디까지 적용했나"를 기억하지 않는다(게이트웨이가 같은 방식으로 전환했고, 그 기억에
  의존하던 시절 `0004` 누락으로 요청 로그가 전량 유실된 실사고가 있다).
- **장부 표는 소유자별로 가른다** — 콘솔은 `d1_migrations_ops_dashboard`
  (`wrangler.toml` 의 `migrations_table`). 게이트웨이와 D1 을 공유하므로
  ([0003](0003-single-shared-local-d1.md)) 기본 이름을 쓰면 두 프로젝트 기록이 한 표에 섞이고,
  파일명이 겹치는 순간(양쪽 다 `0002_*.sql` 을 만들 수 있다) 한쪽이 "이미 적용됨"으로
  **조용히 건너뛴다.**
- 전환 이전에 만들어진 상태는 `scripts/backfill-migrations-ledger.sql` 이 소급 기록한다 —
  **그 파일이 만든 표가 실제로 있을 때만** 적어서, 새 DB 는 정상 적용되고 기존 DB 는 건너뛴다.

## 🔴 남의 표를 만들거나 지우지 않는다

이 경계가 이번 개정의 핵심이다. **파이프라인·dbt 가 만든 산출물은 콘솔이 절대 건드리지 않는다.**

| 표 | 소유(정본) | 콘솔의 권한 |
|---|---|---|
| `_ops_slo` · `_ops_domain` | **콘솔** (`migrations/0001`) | 스키마·내용 모두 |
| `_ops_run_event` · `_ops_daily_metric` · `_ops_pipeline_state` · `_ops_pipeline_expectation` | ASAC-DAG (`common/ops/d1_ops.py`) | **읽기 전용** |
| `_keys` · `_usage` · `_burst` · `_request_log` | 게이트웨이 (`../marketplace/migrations/`) | 읽기 + 정해진 키 조치만([0006](0006-key-hash-identifier.md)) |
| `_catalog` · 제품 표 (`d1_*`) | 도메인 export (`meta.serving` 계약) | **읽기 전용** |

- 콘솔 `migrations/` 에 **남의 표 이름이 등장하면 그 자체가 위반**이다(생성·삭제·ALTER 전부).
- 개발용으로 4종 표본이 필요하면 `migrations/` 가 아니라 **`fixtures/`** 에 둔다 —
  스키마 정본이 저쪽이므로 콘솔이 소유를 주장하지 않는다는 뜻이다(게이트웨이가
  `handoff_meta_sample.sql` 을 fixtures 에 둔 것과 같은 이유).

## 대가

- 컬럼을 고치려면 파일이 하나 는다. 프로토타입 속도를 조금 잃는 대신, 팀 DB 에 붙는 날
  데이터를 지우지 않는다 — 되돌릴 수 없는 쪽을 막는 거래다.
- `_ops_slo` 의 기존 컬럼을 **빼거나 이름을 바꿀 수 없다**(#78 D-3: 추가는 허용, 삭제·이름
  변경은 금지). 잘못 만든 컬럼은 새 컬럼을 더하고 옛것을 안 쓰는 쪽으로 정리한다.

## 재검토 조건

없음 — 되돌리려면 "팀 데이터를 지워도 되는 이유"를 먼저 적어야 한다.
