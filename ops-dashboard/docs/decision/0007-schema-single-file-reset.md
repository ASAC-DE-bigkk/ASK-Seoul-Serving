# 0007 — `_ops_*` 마이그레이션은 증분이다 (DROP+CREATE 리셋 폐지)

- 상태: **개정** (2026-08) — 초판(2026-07)의 "단일 파일 DROP+CREATE 리셋"을 **폐지**한다
- 관련: [0003](0003-single-shared-local-d1.md)(공유 D1) · [0005](0005-slo-snapshot-to-d1.md)(공급자) ·
  [0009](0009-ops-records-consumption.md)(조회 DB 4종 소비)
- 근거 규약: **ASK-Seoul#78 D-6** — 선행 필수, 적용 순서 **0단계**.
  참고: [reference/](../reference/) 의 "D1 Migration 정책(증분·하위 호환)" 항목

## 왜 바뀌었나

초판의 전제는 **"리셋이 공짜"** 였다 — `_ops_slo` 내용물은 픽스처가 매번 다시 채우니
잃을 상태가 없다는 것. 그 전제가 깨졌다.

- **#78 D-6**: "대시보드 마이그레이션이 `DROP TABLE IF EXISTS` 로 시작한다. 팀 조회 DB 에
  테이블을 만들기 **전에** 증분 방식으로 바꿔야 한다. **안 바꾸면 첫 스키마 수정이 팀
  데이터를 지운다.**"
- 팀 규약(#78)이 조회 DB 를 공유 자산으로 만들었고, ASAC-DAG 적재기가 **실제 팀 D1 에
  `_ops_*` 가족 테이블을 만들어 데이터를 쌓기 시작했다**(ASAC-DAG#647 · #655). 콘솔이 거기
  붙는 순간 "다시 채우면 그만"인 값이 아니게 된다.
- 파이프라인 쪽 정본(`common/ops/d1_ops.py`)은 이미 이 규약을 지킨다 —
  `create_table_statement()` 주석이 **"이 모듈은 DROP 을 만들지 않는다(D-6)"**. 콘솔만 어겼다.

## 결정

- **`migrations/` 에 DROP 을 쓰지 않는다.** 표 생성은 `CREATE TABLE IF NOT EXISTS` 뿐이고,
  컬럼이 늘면 **새 파일에 ALTER 를 추가**한다(0003, 0004 …). `0001_ops_slo.sql` 은 더 이상
  고치지 않는다. 항목 추가는 허용, **삭제·이름 변경은 금지**(#78 D-3).
- **내용물 리프레시는 마이그레이션이 아니라 픽스처의 몫**이다 — 이미 그렇게 돼 있다
  (`slo_sample.sql`·`ops_records_sample.sql` 모두 자기 범위를 DELETE 하고 다시 넣는다).
  ⚠️ **그 규칙이 안 맞는 픽스처가 하나 있다**: `ops_domain.sql`(분야 등록부)은 표본이 아니라
  **참조 내용**이고 운영에 돌리는 파일이라, `DELETE` 없이 `INSERT OR REPLACE` 로 겹쳐 쓴다 —
  지웠다 넣는 사이 운영 화면이 라벨을 잃고, 퇴역한 분야의 라벨도 남겨야 하기 때문이다
  (2026-08-07 · [manual-steps §4-1](../../../docs/manual-steps.md)).
- 로컬에서 스키마를 통째로 리셋하고 싶으면 마이그레이션에 DROP 을 넣는 게 아니라
  **로컬 상태를 지운다**: `rm -rf ../marketplace/.wrangler/state` 후 양쪽 재시드.
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
| `_ops_run_event` · `_ops_daily_metric` · `_ops_pipeline_state` · `_ops_pipeline_expectation` | ASAC-DAG (`common/ops/d1_ops.py`, `ops-d1/v1`) | **읽기 전용** |
| `_keys` · `_usage` · `_burst` · `_request_log` | 게이트웨이 (`../marketplace/migrations/`) | 읽기 + 정해진 키 조치만([0006](0006-key-hash-identifier.md)) |
| `_catalog` · `d1_catalog_display` · 제품 표 (`d1_*`) | 도메인 export (`meta.serving` 계약) | **읽기 전용** |

- 콘솔 `migrations/` 에 **남의 표 이름이 등장하면 원칙적으로 위반**이다(생성·삭제·ALTER 전부).
- **유일한 예외가 `migrations/0002` 다** — 조회 DB 4종의 **로컬 미러**. 원격 없이 화면을
  돌려보려면 빈 껍데기라도 있어야 해서 뒀고, 그래서 조건이 셋 붙는다:
  ① `CREATE TABLE IF NOT EXISTS` 만 — 팀 D1 에 이미 있으면 **아무 일도 하지 않는다**,
  ② DROP·ALTER 금지 — 스키마가 갈리면 정본(`d1_ops.py`)을 따라 이쪽을 고친다,
  ③ 미러는 **소유 주장이 아니다** — 정본이 바뀌면 무조건 따라간다([0009](0009-ops-records-consumption.md)).
- 개발용 **표본 데이터**는 `migrations/` 가 아니라 **`fixtures/`** 에 둔다
  (게이트웨이가 `handoff_meta_sample.sql` 을 fixtures 에 둔 것과 같은 이유).

## 대가

- 컬럼을 고치려면 파일이 하나 는다. 프로토타입 속도를 조금 잃는 대신, 팀 DB 에 붙는 날
  데이터를 지우지 않는다 — 되돌릴 수 없는 쪽을 막는 거래다.
- `_ops_slo` 의 기존 컬럼을 **빼거나 이름을 바꿀 수 없다**(#78 D-3). 잘못 만든 컬럼은
  새 컬럼을 더하고 옛것을 안 쓰는 쪽으로 정리한다.

## 재검토 조건

없음 — 되돌리려면 "팀 데이터를 지워도 되는 이유"를 먼저 적어야 한다. 예외적으로 로컬 전용
테이블을 새로 만드는 경우에도 같은 규약을 따른다(습관이 사고를 막는다).
