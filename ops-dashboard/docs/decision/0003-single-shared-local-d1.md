# 0003 — 게이트웨이와 같은 로컬 D1 을 공유한다 (원본 하나)

> ⚠️ **2026-08-05 개정** — [0015](0015-single-production-d1.md).
> **"원본은 하나"라는 취지는 그대로고, 그 하나가 운영으로 옮겨갔다.**
>
> 콘솔은 더 이상 `--persist-to` 로 게이트웨이의 로컬 상태를 공유하지 않는다 — 로컬 사본
> 자체가 없고 운영 D1 에 직접 붙는다. 아래 본문의 `--persist-to`·`npm run seed` 서술은
> **게이트웨이 기준으로만** 읽는다.
>
> 이 문서가 경고한 **`table_name` 은 물리명이라 위험하다**(제품 축)는 지적과 **소유 경계**는
> 그대로 유효하다 — 오히려 운영에 직접 쓰게 된 지금 더 중요해졌다.

- 상태: **채택** (2026-07)
- 관련: [reference/](../reference/) 의 "Queue + Log Consumer" 및 "D1/PostgreSQL 이중 원본 금지" 항목

## 맥락

서빙 품질의 원본 `_request_log` 는 게이트웨이가 쌓는다. 콘솔이 이걸 보려면
(a) 같은 D1 을 읽거나, (b) 복제 경로(Queue → Consumer → 별도 저장소)를 만들어야 한다.

## 결정

`npm run dev` 와 `npm run seed` 모두 `--persist-to ../marketplace/.wrangler/state` 로
**게이트웨이와 같은 로컬 D1 상태를 읽는다.** 데이터 원본은 하나다. 복제·이중 저장 없음.

## 근거

- reference 의 Queue+Consumer 구조는 "호출 이력이 사용자 기능·과금 근거"일 때의 방법이다.
  지금 호출 이력은 운영 관찰용이고, 과금은 없다 — 복제 계층은 순수 비용이다.
- 원본이 하나면 상태 불일치라는 장애 유형 자체가 없다.

## 경계 (이 결정이 부과하는 규칙)

**같은 D1 을 여럿이 쓴다 = 남의 표가 옆에 있다.** 공유의 대가는 "안 건드리기"다.

- **게이트웨이 소유 테이블(`_keys`·`_usage`·`_burst`·`_request_log`)의 스키마는 여기서
  바꾸지 않는다.** 정본은 `../marketplace/migrations/` 다.
- 그 테이블에 대한 쓰기는 [0006](0006-key-hash-identifier.md)에 정의된 키 조치뿐이다.
- **파이프라인·dbt 산출물은 읽기 전용이다** — 조회 DB 4종(`_ops_run_event`·
  `_ops_daily_metric`·`_ops_pipeline_state`·`_ops_pipeline_expectation`, 정본은 ASAC-DAG
  `common/ops/d1_ops.py`)과 `_catalog`·제품 표(`d1_*`). 콘솔이 만들지도, 지우지도, 고치지도
  않는다. 전체 소유 표는 [0007](0007-schema-single-file-reset.md)에 있다.
- **마이그레이션 장부도 소유자별로 가른다** — 콘솔은 `d1_migrations_ops_dashboard`.
  한 표를 공유하면 파일명이 겹칠 때 한쪽이 조용히 건너뛴다([0007](0007-schema-single-file-reset.md)).
- 테이블이 아직 없을 수 있다(한쪽만 시드된 상태, 또는 로컬에 4종이 없는 상태) — 콘솔은
  죽는 대신 그 섹션만 비우고 `meta.missing` 으로 알린다(`safeRows`).

## 대가

- 게이트웨이 로컬 상태에 종속된다 — 저쪽이 리셋하면 여기 화면도 빈다(강등으로 흡수).

## 재검토 조건

공개 배포 승격으로 실제 팀 D1 을 읽게 될 때, 또는 두 Worker 의 쓰기 경합이 실측될 때.
