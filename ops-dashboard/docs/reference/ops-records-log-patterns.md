# 운영 기록 로그 패턴 — 형태와 도출 가능한 인사이트 카탈로그

> **문서 성격 — 참조 (구속력 없음).** 팀 규약(ASK-Seoul#78)과 그 구현(ASAC-DAG#647·#655·#658)이
> 정의한 **로그의 형태를 패턴으로 정리**하고, 그 로그가 조회 DB(D1)에 적재됐을 때 **뽑아낼 수
> 있는 인사이트를 카탈로그**로 남긴다. 어디까지 채택해 화면으로 만들었는지는
> [../decision/0009](../decision/0009-ops-records-consumption.md)가 정한다.

## 1. 로그는 어디서 와서 어디로 가나

```text
Airflow task / dbt node (각 도메인)
   │  공용 관문(common/ops) — 경로·필수 항목·값 집합을 쓰는 순간 강제
   ▼
R2 ops/<category>/<domain>/observed_date=…   ← 원본 (C-1)
   │  ① 쓸 때 같은 자리에서 DB 한 줄 (C-2, 실패해도 본 작업에 무해)
   │  ② 일 1회 점검이 저장소↔DB 대조, 빠진 것만 채움 (C-3, event_id 기준 멱등 C-6)
   │  ③ 과거분은 백필 스크립트로 하루씩 (ASAC-DAG#658, 기본 dry-run)
   ▼
조회 DB(D1) — 표 4종                          ← 화면·알림이 읽는 곳 (D-5)
```

## 2. 기록 1건의 패턴 (F 표 — `_ops_run_event` 와 1:1)

필드는 여섯 묶음이다. **빼거나 이름을 바꾸지 않고 추가만 한다**(F-1·D-3).

| 묶음 | 필드 | 패턴이 말하는 것 |
|---|---|---|
| 식별 | `event_id`(sha256) · `schema_version` · `domain` · `layer` · `grain` · `dag_id` · `task_id` · `run_id` · `try_number` · `is_final_try` · `environment` | 무엇의 몇 번째 시도인가, 어느 환경인가. `event_id` 가 멱등의 열쇠 |
| 시각 | `observed_at`(UTC) · `started_at` · `ended_at` · `duration_s` · `duration_hms` · `observed_date_kst` · `source_path_date` · `schedule_delay_s` | **날짜 축이 두 개다**(F-5) — 집계는 `observed_date_kst`, 저장소 대조는 `source_path_date` |
| 양 | `row_count` · `rows_source` · `bytes` | **모른다 ≠ 0**(F-3) — 못 잰 값은 NULL, `rows_source` 가 왜 그런지 밝힌다 |
| 출처 | `api_name` · `api_call_count` · `retry_count` · `failure_count` | URL 은 저장 금지(X-1, 인증키가 URL 에 실리는 원천 때문) |
| 목적지 | `sink_type` · `sink_target` | 파일/테이블/DB 어디에 썼나 |
| 결과 | `status` · `error_ref` · `quality` · `publication_id` · `product_id(s)` | `error_ref` 는 실패 상세(R2)로 가는 포인터 |

적재기가 붙이는 컬럼: `source_category` · `source_key` · `log_bundle_key` · `ingested_at`.

## 3. 값 집합 — 섞으면 안 되는 세 벌 (V 표)

| 어디 | 값 | 주의 |
|---|---|---|
| 실행 기록 `status` | `success` \| `failed` \| `skipped` \| `degraded` | R2 확인서의 `complete*`, Iceberg 명세서의 `SUCCESS` 등과 **다른 집합** — 전역 치환 금지 |
| `layer` (단계) | `raw` \| `bronze` \| `silver` \| `gold` \| `d1` | 관문 이전 기록은 **NULL** — 추측해 채우지 않는다 |
| `grain` (기록 단위) | `airflow_task` \| `dbt_node` \| `product_transition` \| `product_health` \| `publication` \| `control_state` | runs=작업 1건, metrics=모델 1건 (V-6) |

## 4. 조회 모델 — 표 4종 (D 표, 정본: ASAC-DAG `common/ops/d1_ops.py`)

| 테이블 | 한 행 | 자연키 | 보관 |
|---|---|---|---|
| `_ops_run_event` | 기록 1건 | `event_id` | 180일 |
| `_ops_daily_metric` | 날짜×도메인×단계 집계 | (`observed_date_kst`,`domain`,`layer`) | 영구 |
| `_ops_pipeline_state` | DAG 현재 상태 (`observation_state` = C-9 의 complete/partial/unverified) | `dag_id` | 현재값만 |
| `_ops_pipeline_expectation` | DAG 기대치 — **정본은 DAG 선언, 이 표는 사본**(S-1) | `dag_id` | 관리용 |

집계표(`_ops_daily_metric`)에는 성공률이 가리는 두 축이 **컬럼으로** 준비돼 있다:
`retried_run_count`(재시도로 살림) · `empty_run_count`(빈 실행) — 그리고 `rows_observed_count`
vs `rows_unknown_count`(모른다 ≠ 0)가 관측 신뢰도를 같이 싣는다.

## 5. 인사이트 카탈로그 — 이 로그로 답할 수 있는 질문들

규약 D-7 의 지표 목록에 실측(#655)에서 드러난 것을 더했다. **번호는 이후 문서·화면에서
이 인사이트를 지목하는 데 쓴다.**

| # | 질문 | 축 | 출처 |
|---|---|---|---|
| I-1 | 어제(이 기간) 파이프라인이 잘 돌았나 | 날짜×도메인×단계 성공/실패 | `_ops_daily_metric` |
| I-2 | 성공률 뒤에 숨은 열화 — **재시도로 살아난 실행**이 얼마나 되나 | `retried_run_count` | `_ops_daily_metric` |
| I-3 | **빈 실행(초록 위장 일반화)** — 성공인데 0행인 실행 | `empty_run_count` · `status='success' AND row_count=0` | 두 표 |
| I-4 | **모른다 ≠ 0** — 행수를 못 잰 기록이 얼마나 되나, 왜 못 쟀나 | `rows_unknown_count` · `rows_source` | 두 표 |
| I-5 | **멈춘 파이프라인** — 기대 주기를 넘겨 조용한 DAG | expectation × state + `max_delay_minutes` | 기대치·상태 표 |
| I-6 | "기록 없음"이 장애인가 미점검인가 (**미확인 ≠ 정상**, C-9) | `observation_state` | `_ops_pipeline_state` |
| I-7 | 지연 실행 — 예정보다 늦게 돈 작업 | `schedule_delay_s` | `_ops_run_event` |
| I-8 | 소요 추이 — 갑자기 오래 걸리기 시작한 단계 | `duration_s_sum / event_count` | `_ops_daily_metric` |
| I-9 | **관측 공백** — 어느 도메인·단계가 아예 기록을 안 남기나 | 매트릭스의 빈 칸 · `layer IS NULL` 건수 | 두 표 |
| I-10 | **환경 섞임**(Z-7 실해) — dev 기록이 운영 지표에 섞이나 | `environment` 별 분포 | `_ops_run_event` |
| I-11 | 외부 API 를 얼마나 부르나 | `api_call_count_sum` | `_ops_daily_metric` |
| I-12 | 적재가 살아있나 — 조회 DB 가 언제 것까지 아나 | `MAX(ingested_at)` | `_ops_run_event` |
| I-13 | 실패의 근거로 점프 — 왜 실패했나 | `error_ref` (R2 실패 상세 포인터) | `_ops_run_event` |
| I-14 | 저장소↔DB 가 맞나 (대조) | `source_path_date` · `source_category` | `_ops_run_event` |

서빙 쪽 대응물: 게이트웨이 `_request_log`(값이 아니라 축만·해시만·30일)는 같은 콘솔의
서빙 탭이 이미 소비한다 — 파이프라인 기록(이 문서)과 **한 화면에서 나란히 보일 때**
"만든 쪽 문제인가, 파는 쪽 문제인가"가 갈린다.
