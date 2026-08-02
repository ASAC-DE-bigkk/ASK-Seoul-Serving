# ops-dashboard 개발·운영 가이드 (runbook)

화면을 띄우고, 맞게 떴는지 확인하고, 실측으로 채우고, 사고 없이 조치하는 절차를
**설명 + 명령어** 단위로 묶었다. 왜 이런 구조인지는 [decision/](index.md#결정--docsdecision),
경계는 [../CLAUDE.md](../CLAUDE.md) 4절이 정본이다.

---

## 1. 처음 여는 사람 — 구동까지

콘솔은 게이트웨이([../../marketplace/](../../marketplace/))와 **같은 로컬 D1 상태**를 읽는다
(`--persist-to`). 서빙 품질(`_request_log`)·키(`_keys`)는 저쪽이 만들기 때문에, 게이트웨이도
한 번은 시드해 두는 게 화면이 온전하다.

```bash
# (선택이지만 권장) 게이트웨이 먼저 — _catalog·_keys·_request_log 가 생긴다
cd marketplace && npm install && npm run seed

# 콘솔
cd ../ops-dashboard
npm install
npm run seed          # _ops_slo/_ops_domain + 조회 DB 4종 미러 + 합성 샘플 → 공유 로컬 D1
echo "OPS_TOKEN=$(openssl rand -hex 16)" > .dev.vars    # 조치(쓰기) 잠금 해제용 — .gitignore 대상
npm run dev           # http://localhost:8788  (게이트웨이 :8787 과 동시 구동 가능)
```

- 토큰 없이도 화면은 뜬다 — 잠기는 건 **조치**(폐기·복구·쿼터·삭제)뿐이다.
- 시드는 몇 번을 다시 돌려도 안전하다 — 마이그레이션은 `CREATE IF NOT EXISTS` 뿐이고
  (DROP 금지, [0007](decision/0007-schema-single-file-reset.md)), 픽스처는 **자기 샘플 범위만**
  지우고 다시 넣는다.

## 2. 맞게 떴는지 — API 검증 세트

화면 없이 curl 로 확인한다. `jq` 가 있으면 편하다.

```bash
BASE=http://localhost:8788

# ① 요약 — 네 섹션이 다 있는지, 뭐가 비었는지(meta.missing), 샘플인지
curl -s "$BASE/api/summary?days=14" | jq '{missing: .meta.missing,
  pipeline_sample: .meta.pipeline_is_sample, runs_sample: .meta.runs_is_sample,
  slo_days: (.pipeline.slo|length), runs_daily: (.runs.daily|length),
  monitored_dags: (.runs.expectations|length), serving_calls: (.serving.routes|length)}'

# ② 실행 기록 상세 — 멈춤 후보 재료(기대×상태)와 실패 목록
curl -s "$BASE/api/summary?days=14" | jq '.runs.expectations[] |
  {dag: .dag_id, last: .last_observed_at, limit_min: .max_delay_minutes, obs: .observation_state}'
curl -s "$BASE/api/summary?days=14" | jq '.runs | {failures, empty_runs, environments}'

# ③ 키 목록 — 이메일이 마스킹돼 나오는지 (email 원문 키가 없어야 정상)
curl -s "$BASE/api/keys" | jq '.keys[0]'
```

**쓰기 문 3종 세트** — 쓰기 경로를 고쳤다면 반드시 셋 다 본다
([0004](decision/0004-read-open-write-token.md)):

```bash
# 토큰 미설정(.dev.vars 없음) → 503 "ops write disabled"
# 토큰 없이            → 401 "unauthorized"
curl -si -X POST "$BASE/api/keys" -H 'content-type: application/json' \
  -d '{"action":"revoke","key_hash":"'$(printf 'a%.0s' {1..64})'"}' | head -1
# 올바른 토큰 + 없는 키 → 404 "unknown key"   (형식만 맞는 가짜 해시라서)
TOKEN=$(cut -d= -f2 .dev.vars)
curl -si -X POST "$BASE/api/keys" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"revoke","key_hash":"'$(printf 'a%.0s' {1..64})'"}' | head -1
```

**강등 확인** — 게이트웨이 테이블이 없어도 콘솔이 죽지 않고 그 섹션만 비워야 한다:

```bash
# 게이트웨이를 시드하지 않은(또는 상태를 지운) 상태에서
curl -s "$BASE/api/summary" | jq '.meta.missing'   # ["serving"] 등 — 500 이 아니라 빈 섹션
```

## 3. 실행 기록 탭 — 샘플에 박힌 검증 시나리오

`npm run seed` 의 합성 데이터에는 화면 경로가 하나씩 박혀 있다. 탭(`#runs`)에서 눈으로 확인한다.

| 시나리오 | 어디서 보이나 |
|---|---|
| 멈춤 후보 | `commerce_collect_watchdog` — 침묵 한도(13시간)를 넘겨 '멈춤 후보' 빨강 |
| 기록 없음 | `weather_traffic_bronze` — 감시 대상인데 상태 행 자체가 없다 |
| 재시도로 살림 | KPI '재시도로 살림' ≥ 1 (07-31 raw·bronze) — 성공률만 보면 안 보인다 |
| 빈 실행(초록 위장) | KPI + '빈 실행' 카드 (08-01 d1 export, 성공인데 0행) |
| 최종 실패 vs 재시도 중 | '최근 실패' 카드의 시도 칸 — 최종 실패·재시도 중·정보 없음 3구분 |
| 모른다 ≠ 0 | KPI '행수 미측정' (silver 의 dbt 검증 — 행수 개념이 없다) |
| 관측 공백 | 매트릭스 — commerce 만 5단계, citydata 는 raw 만, 나머지는 — |
| 단계 미기록 | 매트릭스 아래 각주 "단계 미기록 n건(관문 이전 기록)" |
| 환경 섞임 | 상단 경고 배너 + '환경' 카드 (dev 1건이 섞여 있다) |
| 지연 | '지연 상위' — transit 97분 지연 |
| 탭 점 | 위 문제들 때문에 '실행 기록' 탭 라벨의 점이 빨갛다 |

## 4. 실측으로 채우기

### 4-1. 파이프라인 SLO (`_ops_slo`)

```bash
python scripts/load_slo.py             # Trino 조회 → fixtures/slo_live.sql → 로컬 D1 적용
python scripts/load_slo.py --dry-run   # SQL 만 생성
TRINO_URL=http://127.0.0.1:30586 python scripts/load_slo.py   # 포트가 다르면
```

적용되면 파이프라인 탭의 '합성 샘플' 배너가 사라진다(`is_sample=0`).

### 4-2. 운영 기록 (조회 DB 4종)

**정규 경로는 이 리포 밖이다** — ASAC-DAG 의 관문(쓸 때 한 줄, C-2)·일일 점검(C-3)·백필
통로(#658)가 팀 조회 DB 에 적재한다. 콘솔은 그 표를 읽는 소비자다
([0009](decision/0009-ops-records-consumption.md)).

```bash
# (ASAC-DAG 리포에서, 참고용) 과거 구간을 하루씩 끊어 적재 — 기본은 dry-run
python domains/commerce/scripts/backfill_ops_records.py --since 2026-07-01 --until 2026-07-31
python domains/commerce/scripts/backfill_ops_records.py --since 2026-07-01 --until 2026-07-31 --apply
```

로컬 콘솔이 **팀 조회 DB 를 직접 읽는 경로는 아직 없다**(로컬 전용,
[0002](decision/0002-local-only-mentor-gate.md)). 그때까지 이 탭은 합성 샘플로 화면 계약을
검증하고, 승격 시 표 이름·컬럼이 그대로라 화면 코드는 바뀌지 않는다.

샘플만 걷어내고 싶으면(실측과 섞임 방지):

```bash
npx wrangler d1 execute ask-seoul-dev-d1 --local --persist-to ../marketplace/.wrangler/state \
  --command "DELETE FROM _ops_run_event WHERE event_id LIKE 'smp_%';
             DELETE FROM _ops_daily_metric WHERE updated_at='sample';
             DELETE FROM _ops_pipeline_state WHERE updated_at='sample';
             DELETE FROM _ops_pipeline_expectation WHERE updated_at='sample';"
```

## 5. 스키마를 바꿔야 할 때 — 증분 규약

**마이그레이션에 DROP 을 넣지 않는다** (#78 D-6, [0007](decision/0007-schema-single-file-reset.md)).

```bash
# 새 컬럼 → 새 파일로 추가만 (예: migrations/0003_add_x.sql 에 ALTER TABLE ... ADD COLUMN ...)
npx wrangler d1 execute ask-seoul-dev-d1 --local --persist-to ../marketplace/.wrangler/state \
  --file=migrations/0003_add_x.sql
# package.json 의 seed 체인에도 같은 파일을 추가한다

# 로컬을 통째로 리셋하고 싶을 때 — 마이그레이션이 아니라 상태를 지운다 (게이트웨이 데이터도 지워진다!)
rm -rf ../marketplace/.wrangler/state && (cd ../marketplace && npm run seed) && npm run seed
```

조회 DB 4종의 정본은 ASAC-DAG `common/ops/d1_ops.py` 다 — 정본이 바뀌면 미러
(`migrations/0002`)를 따라 고치고, 임의로 컬럼을 더하지 않는다.

## 6. 운영 조치 시나리오

### 키 조치 (키 관리 탭)

1. 상단 **잠금 해제**에 `OPS_TOKEN` 입력 → 운영자 모드.
2. 폐기·삭제는 버튼을 **두 번** 눌러야 실행된다(`정말 폐기`/`정말 삭제`). 폐기는 복구
   가능, **삭제는 불가역**(이용자 삭제 요청 대행 경로 — 키·이메일·사용량이 지워진다).
3. curl 로 할 때는 `key_hash`(64hex)를 쓴다 — prefix 는 충돌한다
   ([0006](decision/0006-key-hash-identifier.md)):

```bash
curl -s -X POST "$BASE/api/keys" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"quota","key_hash":"<64hex>","daily_quota":500}' | jq .
# action: revoke · restore · quota · delete
```

### 멈춤 후보를 봤을 때

콘솔은 조회 전용이다 — 조치는 파이프라인 쪽에서 한다.

1. '감시 대상 DAG' 표에서 **owner** 확인 → 그 도메인 담당에게.
2. '최근 실패'의 **근거(`error_ref`)** 경로가 R2 실패 상세다 — 그걸 열면 원인이 있다.
3. Airflow 웹에서 해당 `dag_id` 의 최근 run 을 확인한다.
4. '미확인'(unverified)은 아직 점검이 안 지난 구간이다 — 장애 선언 전에 기대 주기 초과
   여부(멈춤 후보 판정)와 같이 읽는다(#78 C-9).

### 콘솔이 이상할 때

| 증상 | 원인 | 조치 |
|---|---|---|
| '합성 샘플' 배너 | 픽스처 데이터로 동작 중 | §4 실적재. 배너는 실측이 들어오면 사라진다 |
| '조회 DB 표가 없습니다' | `npm run seed` 전 | `npm run seed` |
| '서빙 로그를 찾지 못했습니다' | 게이트웨이 미시드 / `--persist-to` 불일치 | `cd ../marketplace && npm run seed`, 경로 확인 |
| 조치 버튼이 안 보인다 | 읽기 전용 모드 | 상단 잠금 해제 (`.dev.vars` 의 `OPS_TOKEN`) |
| 조치가 503 | `OPS_TOKEN` 미설정 | `.dev.vars` 작성 후 `npm run dev` 재시작 |
| :8788 충돌 | 다른 프로세스 | `lsof -i :8788` 로 확인 후 정리 |

## 7. 하지 말 것 (요약)

`wrangler deploy` · 팀(원격) D1 쓰기 · 게이트웨이 소유 테이블 스키마 변경 · 마이그레이션에
DROP · 이메일 원문 응답 · 토큰 커밋. 전문은 [../CLAUDE.md](../CLAUDE.md) 4절.
