# ops-dashboard 개발·운영 가이드 (runbook)

화면을 띄우고, 맞게 떴는지 확인하고, 실측으로 채우고, 사고 없이 조치하는 절차를
**설명 + 명령어** 단위로 묶었다. 왜 이런 구조인지는 [decision/](index.md#결정--docsdecision),
경계는 [../CLAUDE.md](../CLAUDE.md) 4절이 정본이다.

---

## 1. 처음 여는 사람 — 구동까지

> 🔴 **띄우면 운영이다.** D1 은 `ask-seoul-prod-d1` 하나뿐이고 `npm run dev` 는
> 바인딩에 `remote = true` 가 걸려 있다([0015](decision/0015-single-production-d1.md)). 로컬
> 사본이 없으므로 **연습 삼아 눌러 볼 곳이 없다.** 조치(폐기·복구·쿼터·삭제)는 실제 고객 키에 간다.

```bash
cd ops-dashboard
npm install
cp .env.example .env   # CLOUDFLARE_API_TOKEN — 원격 바인딩이라 자격증명 없이는 안 뜬다
echo "OPS_TOKEN=$(openssl rand -hex 16)" > .dev.vars    # 조치(쓰기) 잠금 해제용 — .gitignore 대상
npm run dev            # http://localhost:8788  🔴 운영 D1
```

- 토큰 없이도 화면은 뜬다 — 잠기는 건 **조치**(폐기·복구·쿼터·삭제)뿐이다.
- 게이트웨이를 따로 시드할 필요가 없다. `_gateway_request_log`·`_keys` 는 운영 D1 에 있고
  콘솔이 거기서 직접 읽는다. **게이트웨이 로컬 구동은 아직 dev D1 을 본다** — 그쪽 전환은
  담당자 몫이라(#85) 그때까지 두 프로젝트의 로컬이 서로 다른 DB 를 본다.
- 인스펙터 포트는 콘솔이 9230 으로 고정돼 있어 게이트웨이 기본값(9229)과 겹치지 않는다.

### 1-1. 스키마 적용 — 코드 배포와 분리돼 있다

```bash
npm run migrate:list   # 무엇이 적용됐나 먼저 본다
npm run migrate        # 장부 백필 → migrations apply (운영 D1, 원격)
```

CD 는 **코드만** 배포한다. 마이그레이션이 자동으로 돌면 운영 스키마가 머지 타이밍에
바뀌는데, D1 이 하나뿐인 지금 그건 되돌릴 창이 없다는 뜻이다.

`migrations/` 는 전부 `CREATE TABLE IF NOT EXISTS` 이고 DROP·ALTER 가 없다
([0007](decision/0007-schema-single-file-reset.md)) — **있는 표는 건드리지 않는다.**
0002 가 만드는 조회 DB 4종은 운영에 이미 있으므로 그대로 no-op 이다.

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

# ④ 이용 행동 — 여정(즉시)과 스펙 종속 축('수집 전') 구분
curl -s "$BASE/api/summary?days=14" | jq '{spec_pending: .meta.usage_spec_pending,
  funnel: .usage.funnel, clients_pending: .usage.clients.pending}'

# ⑤ 요청 추적 — 게이트웨이 응답 헤더 X-Request-Id 값으로 그 요청 한 건을 특정
RID=$(curl -si http://localhost:8787/api/catalog | tr -d '\r' | awk -F': ' '/^x-request-id/{print $2}')
curl -s "$BASE/api/trace?request_id=$RID" | jq '{found, rows}'

# ⑥ route 계약 — 무엇을 '데이터 서빙'으로 셌고, 무엇을 못 셌나 (decision/0014)
curl -s "$BASE/api/summary?days=14" | jq '{serve: .meta.serve_routes, mcp: .meta.mcp}'
#   serve = ["data","skill_data","mcp_query_product"]  ← 질의 조건과 같은 배열에서 나온다
#   mcp.unsplit    > 0 이면 화면에 "거부된 AI 호출은 못 가름" 안내가 뜬다
#   mcp.pre_split  = true 면 창 앞부분이 '가르기 전' 기록이다(기간을 좁히면 사라진다)

# ⑥-a 화면에 내부 슬러그가 새는지 — 번역표에 없는 route 값을 골라낸다 (리포 루트에서, 통과 기준: 0줄)
curl -s "$BASE/api/summary?days=14" | jq -r '.serving.routes[].route' | sort -u | while read r; do
  grep -q "\b$r:" ops-dashboard/public/index.html || echo "MISSING in ROUTE_KO: $r"
done

# ⑦ 환경 스코프 — 서빙 수치가 한 환경의 것인가, 무엇을 뺐나 (#64)
curl -s "$BASE/api/summary?days=14" | jq '{scope: .meta.serving_env_scope,
  mix: .meta.serving_env_mix, excluded: .meta.serving_env_excluded,
  unknown: .meta.serving_env_unknown}'
#   scope    = "prod"  ← null 이면 안 좁히고 있다는 뜻이다(ENV_SCOPE 확인)
#   mix      = 거르기 **전** 분포. 여기에 scope 아닌 값이 보이면 섞여 있는 것이다
#   excluded > 0 이면 화면 네 탭에 "prod 요청만" 안내가 뜬다
#   unknown  = env IS NULL 건수 — **운영으로 채우지 않는다**(ASAC-DAG#692)

# ⑦-a 합이 맞는가 — 스코프 적용분 + 제외분 = 전체
curl -s "$BASE/api/summary?days=14" | jq '
  (.serving.routes | map(.calls) | add // 0) as $scoped
  | (.meta.serving_env_mix | map(.calls) | add // 0) as $all
  | {scoped: $scoped, excluded: .meta.serving_env_excluded, all: $all,
     ok: (($scoped + .meta.serving_env_excluded) == $all)}'
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

아래는 **화면이 무엇을 드러내야 하는지**의 목록이다. 운영 D1 의 실측에서 해당 상황을 만나면
탭(`#runs`)이 이렇게 보여야 한다 — 예전에는 합성 시드로 재현했지만 그 시드는 없어졌다(0015).

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

**표는 있고 비어 있다** — `npm run migrate` 가 만들고, 채우는 것은 아직 없다.
합성 픽스처는 **넣지 않는다**(운영 D1 이므로 그게 곧 오염이다).

**이 탭은 비어 있는 것이 정상이다.** 실측을 넣는 정규 경로는 culture DAG 의 export task 이고
(팀 D1 쓰기 = 승인 주체 미정(agreement §8-3)), 그게 붙어 `is_sample=0` 행이 들어오면 '합성 샘플' 배너가
저절로 사라진다. 웨어하우스를 콘솔이 직접 훑던 임시 로더는 폐기했다
([0005](decision/0005-slo-snapshot-to-d1.md)) — 실측 파이프라인 상태는 **실행 기록 탭**이
조회 DB 4종에서 직접 읽는다.

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
npm run migrate:list          # 현재 적용 상태
npm run migrate               # 새 파일까지 적용 (운영 D1)
```

🔴 **되돌릴 로컬이 없다.** 예전에는 `rm -rf .wrangler/state` 로 로컬을 통째로 리셋할 수
있었지만 D1 이 운영 하나뿐이라 그 경로가 사라졌다([0015](decision/0015-single-production-d1.md)).
**적용 전에 파일을 두 번 읽는다.**

🔴 **콘솔 소유 표에만 쓴다** — `_ops_slo`·`_ops_domain`. 그 밖의 표는 정본이 남에게 있다:

| 표 | 정본 |
|---|---|
| `_keys`·`_usage`·`_burst`·`_gateway_request_log` | `../../marketplace/migrations/` |
| `_ops_run_event` 외 3종 | ASAC-DAG `common/ops/d1_ops.py` |
| `_catalog`·`_publication_ledger` | 도메인 export(dbt) |

정본이 바뀌면 미러(`migrations/0002`)를 **따라** 고치고, 임의로 컬럼을 더하지 않는다.
손으로 치는 DDL 은 `npm run d1` 이 막는다 — 장부를 안 거친 스키마 변경은 다음 사람의
`migrate` 를 어긋나게 하기 때문이다.

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
| 아예 안 뜬다 / D1 바인딩 오류 | 원격 바인딩인데 `.env` 의 `CLOUDFLARE_API_TOKEN` 없음·만료 | `.env` 확인 — 로컬 사본이 없어 자격증명 없이는 못 뜬다 |
| '조회 DB 표가 없습니다' | 운영 D1 에 `_ops_slo`·`_ops_domain` 미적용 | `npm run migrate` |
| 배지가 "운영"이라고 뜬다 | **정상이다** | 이제 언제나 운영이다([0015](decision/0015-single-production-d1.md)) |
| 조치 버튼이 안 보인다 | 토큰 미입력 | 상단 잠금 해제 (`.dev.vars` 의 `OPS_TOKEN`) |
| 조치가 503 | `OPS_TOKEN` 미설정 | `.dev.vars` 작성 후 `npm run dev` 재시작 |
| `npm run d1` 이 DDL 을 거부 | 의도된 동작 | 스키마는 `migrations/` + `npm run migrate`. 남의 표면 소유자에게 |
| :8788 충돌 | 다른 프로세스 | `lsof -i :8788` 로 확인 후 정리 |

## 7. 하지 말 것 (요약)

**남의 표 스키마 변경**(마켓플레이스·ASAC-DAG·dbt 소유) · 마이그레이션에 DROP ·
env 없는 맨 `wrangler deploy` · 이메일 원문 응답 · 토큰 커밋.
전문은 [../CLAUDE.md](../CLAUDE.md) 4절.

> ⚠️ 예전 목록에 있던 **"팀(원격) D1 쓰기 금지"** 는 [0015](decision/0015-single-production-d1.md)
> 로 **폐기**됐다. 이제 쓰기는 열려 있다 — 대신 **되돌릴 수 없다**는 사실이 그 자리를
> 대신한다. 특히 키 삭제는 `_usage`·`_burst`·`_keys` 연쇄 삭제라 복구 경로가 없다.
