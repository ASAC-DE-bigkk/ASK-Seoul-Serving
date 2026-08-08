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

🔴 **읽기도 토큰이 필요하다**([0004](decision/0004-read-open-write-token.md) 2026-08-06 개정 —
읽기 문이 fail-closed 로 닫혔다). 헤더 없이 부르면 전부 **401** 이고, 그건 고장이 아니라
설계다. 아래 예시는 `$AUTH` 를 달고 도는 것을 전제로 한다.

⚠️ **`npm run d1` 은 이 디렉터리(`ops-dashboard/`)에만 있다.** 마켓플레이스·DAG 리포에는 없다 —
이슈나 코멘트에 이 명령을 인용할 때는 **어디서 도는지 한 줄을 같이 적는다**(#162 에서 실제로
막힌 사람이 있었다). 다른 레포에서 같은 D1 을 보려면 wrangler 를 직접 부른다:

```bash
# ops-dashboard 안에서
cd ops-dashboard && npm run d1 -- "SELECT 1"
# 아무 데서나 (같은 운영 D1)
npx wrangler d1 execute ask-seoul-prod-d1 --remote --command "SELECT 1"
```

```bash
BASE=http://localhost:8788
# 토큰은 .dev.vars 에서 읽는다 — 셸 히스토리·문서에 값을 남기지 않는다.
# §1 이 만드는 형식(따옴표 없는 한 줄) 기준이고, `tr -d '\r'` 은 Windows 줄끝 대비다.
AUTH="Authorization: Bearer $(sed -n 's/^OPS_TOKEN=//p' .dev.vars | tr -d '\r')"

# ① 요약 — 네 섹션이 다 있는지, 뭐가 비었는지(meta.missing), 샘플인지
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{missing: .meta.missing,
  pipeline_sample: .meta.pipeline_is_sample, runs_sample: .meta.runs_is_sample,
  slo_days: (.pipeline.slo|length), runs_daily: (.runs.daily|length),
  monitored_dags: (.runs.expectations|length), serving_calls: (.serving.routes|length)}'

# ② 실행 기록 상세 — 멈춤 후보 재료(기대×상태)와 실패 목록
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.runs.expectations[] |
  {dag: .dag_id, last: .last_observed_at, limit_min: .max_delay_minutes, obs: .observation_state}'
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.runs | {failures, empty_runs, environments}'

# ③ 키 목록 — 이메일이 마스킹돼 나오는지 (email 원문 키가 없어야 정상)
curl -s -H "$AUTH" "$BASE/api/keys" | jq '.keys[0]'

# ④ 이용 행동 — 여정(즉시)과 스펙 종속 축('수집 전') 구분
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{spec_pending: .meta.usage_spec_pending,
  funnel: .usage.funnel, clients_pending: .usage.clients.pending}'

# ④-0 이용자 축 — 키 있는 쪽/없는 쪽, 그리고 이용자별
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.usage.identity'
#   keyed + anon == calls 여야 한다. keys_used 는 이 기간에 키로 요청한 사람 수
#   🔴 익명은 신원 축이 없어 아래 목록에 **못 나온다** — 화면이 그 사실을 맨 위에서 밝힌다
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.usage.by_key[:3]'
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '
  (.usage.by_key[0].key_id) as $k
  | {key: $k,
     calls: (.usage.by_key[0].calls),
     listed: ([.usage.by_key_api[] | select(.key_id == $k) | .calls] | add // 0),
     rows:   ([.usage.by_key_api[] | select(.key_id == $k)] | length)}'
#   listed <= calls 다(이용자마다 상위 20만 싣는다). 화면은 그 차이를 "나머지 N건"으로 밝힌다
#   rows 가 20이면 잘린 것이다 — 0이면 그 이용자 행이 아예 안 실린 것이라 질의를 의심한다

# ④-1 제품 표시명 — 게시본(d1_catalog_display)에서 몇 종이 왔나 (ASAC-DAG#706)
curl -s -H "$AUTH" "$BASE/api/apis?days=14" | jq '{missing: .meta.missing,
  declared: .meta.display_declared, undeclared: .meta.display_undeclared}'
#   missing 에 "display" → 표를 못 읽었다. 전 제품이 표명으로 떨어진다
#   undeclared > 0       → 그 도메인이 아직 meta.serving.display 를 선언 안 한 것. **정상이다**
curl -s -H "$AUTH" "$BASE/api/apis?days=14" | jq -r '.apis[] | select(.display == null) | .product_id' | head
#   미선언 제품의 product_id — 어느 도메인이 남았는지 여기서 본다

# ④-2 응답 상태 탭의 분야 축 — 여섯 카드가 다 분야로 갈리나 (#156)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.serving.totals'
#   domain='*'  전 분야 합계 · domain=null  분야 미상 · 나머지는 분야별
#   KPI 는 이 표에서 **고른다** — 목록(상위 N)을 더해 만들지 않는다
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '
  (.serving.totals | map(select(.domain=="*")) | .[0].calls) as $all
  | (.serving.totals | map(select(.domain!="*" and .domain!=null) | .calls) | add // 0) as $byDom
  | (.serving.totals | map(select(.domain==null)) | .[0].calls // 0) as $unknown
  | {all: $all, by_domain: $byDom, unknown: $unknown, ok: (($byDom + $unknown) == $all)}'
#   🔴 by_domain + unknown == all 이어야 한다. unknown 은 제품에 안 묶이는 요청
#      (API 목록·인증·키 발급) — 어느 분야에도 안 넣는다. 화면이 그 건수를 밝힌다

# ④-2-a 그 unknown 이 **무엇인지** — 다섯 갈래로 갈렸나 (#162 🅐)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{axis: .serving.axis, ok: .serving.axis_ok}'
#   product     카탈로그 제품 — 분야로 센다
#   no_product  목록·인증·키 발급 — 애초에 제품이 없다. 정상
#   bundle      번들 요청 — 🔴 **분야로 환산하지 않는다**(정의가 시점마다 다르다, PR #161)
#   qa_probe    404 가 성공 조건인 점검(`qa-` 접두). 정상
#   not_found   카탈로그에 없는 이름 — 🔴 **여기만 조치 대상**
#   axis_ok=false 면 _catalog 를 못 읽은 것이다. 화면은 그때 카드를 **접는다**(0 으로 안 그린다)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '
  (.serving.totals | map(select(.domain=="*")) | .[0].calls) as $all
  | (.serving.axis | map(.calls) | add // 0) as $axis
  | {all: $all, axis_sum: $axis, ok: ($axis == $all)}'
#   🔴 다섯 갈래 합 == 전체. 모자라면 어느 갈래에도 안 들어간 요청이 있다는 뜻이고,
#      그건 예전의 '미상 한 덩어리'로 되돌아간 것이다
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '.serving.not_found'
#   조치 대상을 **이름째로**. `key_ids` 가 우리 팀 키면 점검 트래픽이니 `qa-` 로 바꾸게 한다

# ④-2-b 분야 등록부가 데이터 분야와 운영 축을 가르나 (#162 🅕)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{kind: .meta.domain_kind,
  data: (.pipeline.domains | map(select(.is_data_domain != 0)) | length),
  ops:  (.pipeline.domains | map(select(.is_data_domain == 0)) | length)}'
#   kind=false → 0003 마이그레이션 전이다. 화면이 파이프라인 탭에 배너로 직접 말한다
#   data 는 6, ops 는 1(common)이어야 한다 — data 가 7 이면 픽스처를 안 돌린 것이다

# ④-3 숨김이 실제로 먹는지 — CSS 가 [hidden] 을 덮고 있지 않은지 (브라우저 없이, 통과 기준 0건)
npm run check:hidden

# ⑤ 요청 추적 — 게이트웨이 응답 헤더 X-Request-Id 값으로 그 요청 한 건을 특정
RID=$(curl -si http://localhost:8787/api/catalog | tr -d '\r' | awk -F': ' '/^x-request-id/{print $2}')
curl -s -H "$AUTH" "$BASE/api/trace?request_id=$RID" | jq '{found, rows}'

# ⑥ route 계약 — 무엇을 '데이터 서빙'으로 셌고, 무엇을 못 셌나 (decision/0014)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{serve: .meta.serve_routes, mcp: .meta.mcp}'
#   serve = ["data","skill_data","mcp_query_product","mcp_run_pattern"]  ← 질의 조건과 같은 배열에서 나온다
#   mcp.unsplit    > 0 이면 화면에 "거부된 AI 호출은 못 가름" 안내가 뜬다
#   mcp.pre_split  = true 면 창 앞부분이 '가르기 전' 기록이다(기간을 좁히면 사라진다)

# ⑥-a 화면에 내부 슬러그가 새는지 — 번역표에 없는 route 값을 골라낸다 (리포 루트에서, 통과 기준: 0줄)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq -r '.serving.routes[].route' | sort -u | while read r; do
  grep -q "\b$r:" ops-dashboard/public/index.html || echo "MISSING in ROUTE_KO: $r"
done

# ⑦ 환경 스코프 — 서빙 수치가 한 환경의 것인가, 무엇을 뺐나 (#64)
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '{scope: .meta.serving_env_scope,
  mix: .meta.serving_env_mix, excluded: .meta.serving_env_excluded,
  unknown: .meta.serving_env_unknown}'
#   scope    = "prod"  ← null 이면 안 좁히고 있다는 뜻이다(ENV_SCOPE 확인)
#   mix      = 거르기 **전** 분포. 여기에 scope 아닌 값이 보이면 섞여 있는 것이다
#   excluded > 0 이면 화면 네 탭에 "prod 요청만" 안내가 뜬다
#   unknown  = env IS NULL 건수 — **운영으로 채우지 않는다**(ASAC-DAG#692)

# ⑦-a 합이 맞는가 — 스코프 적용분 + 제외분 = 전체
curl -s -H "$AUTH" "$BASE/api/summary?days=14" | jq '
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
curl -s -H "$AUTH" "$BASE/api/summary" | jq '.meta.missing'   # ["serving"] 등 — 500 이 아니라 빈 섹션
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
| **긴 표** | 행이 20을 넘으면 첫 20행만 뜨고 상자 아래에 "20 / 58"이 뜬다 — 바닥까지 스크롤하면 20씩 이어진다(#3-2) |

### 3-1. 단계별 소요와 적재량 — 세부 보기 셋

카드 위 [전체]·[평균]·[날짜별]은 **같은 데이터를 다른 각도로** 본다.

| 보기 | 무엇 | 언제 쓰나 |
|---|---|---|
| 전체 | 창 전체의 합 | "어느 단계가 무거운가" |
| 평균 | **하루치** 평균. 분모는 그 단계 기록이 있던 날 | 크기 감각의 기준선 · 날짜별 색의 근거 |
| 날짜별 | 하루가 칩 하나. 색은 기간 평균 대비 | "언제 튀었나" |

색 규약은 **초과 > 미달 > 정상** 순이다.

- 🔴 **빨강** — 평균을 넘은 인자가 하나라도 있다
- 🟡 **노랑** — (초과 없음) 평균에 못 미친 인자가 하나라도 있다
- 🟢 **초록** — 모든 인자가 평균 ±10%(`LAYER_BAND`) 안

'인자'는 **단계 × 지표**이고 지표는 이 카드가 보여주는 둘 — 소요·적재 행수다.

⚠️ **칩이 전부 같은 색이면 판정이 아니라 기준을 의심한다.** 파이프라인의 하루치 소요·적재는
원래 크게 흔들려서(실측 2026-08-07: 5일 전부 빨강) ±10% 가 좁을 수 있다. 폭을 바꿀 자리는
`public/index.html` 의 `LAYER_BAND` **한 곳**이다. 다만 **넓히는 것이 곧 개선은 아니다** —
색이 다 초록이면 그것대로 아무 말도 안 하는 화면이 된다. 무엇을 놓치기 싫은지를 먼저 정한다.

⚠️ **기록이 없는 단계는 색에 안 들어간다.** 0으로 세면 사흘에 한 번 도는 단계가 안 도는 날마다
'미달'을 찍는다. 기록 없음은 미달과 **다른 사실**이라 그 날 상세 아래에 글로 적힌다
(agreement §4 모른다 ≠ 0).

## 3-2. 긴 표 — 20행이 한 쪽, 스크롤로 이어 받는다

행이 20을 넘는 표는 **첫 쪽만** 그린다. 상자 바닥에 닿으면 20씩 이어 붙는다.
상자가 없던 카드는 `ui.js`(`UIPage`)가 부모를 스크롤 상자로 **승격**한다(`.scroll.pagehost`).

- 상자 아래 꼬리말이 **"20 / 58 · 스크롤하면 이어집니다"** → 다 받으면 **"58개 전부 불러왔습니다"**
- 20행 이하 표는 **예전과 완전히 같다** — 상자도 꼬리말도 안 붙는다

### 증상별

| 보이는 것 | 무슨 뜻인가 |
|---|---|
| 표가 20행에서 멈추고 스크롤해도 안 늘어난다 | `/ui.js` 를 못 받았을 가능성 — 다만 그때는 **애초에 안 자른다**(전부 그린다). 잘려 있는데 안 늘어나면 콘솔에서 `UIPage` 를 확인한다 |
| 꼬리말이 없는데 표가 짧아 보인다 | 페이징이 아니라 **서버가 자른 것**이다(상위 N). 그 카드의 안내 문구를 본다 |
| 개수를 세는 검사가 갑자기 틀린다 | 🔴 **첫 쪽 20행만 세고 있다.** 전체는 꼬리말이나 응답 배열에서 읽는다 |

```bash
# 표 하나가 몇 행짜리인지는 응답에서 본다(화면 행 수와 다를 수 있다 — 화면은 첫 쪽만 그린다)
curl -s -H "$AUTH" "$BASE/api/apis?days=14" | jq '.apis | length'
```

## 4. 실측으로 채우기

### 4-1. 파이프라인 SLO (`_ops_slo`)

**표는 있고 비어 있다** — `npm run migrate` 가 만들고, 채우는 것은 아직 없다.
합성 픽스처는 **넣지 않는다**(운영 D1 이므로 그게 곧 오염이다).

**이 탭은 비어 있는 것이 정상이다.** 실측을 넣는 정규 경로는 culture DAG 의 export task 이고
(팀 D1 쓰기 = 승인 주체 미정(agreement §8-3)), 그게 붙어 `is_sample=0` 행이 들어오면 '합성 샘플' 배너가
저절로 사라진다. 웨어하우스를 콘솔이 직접 훑던 임시 로더는 폐기했다
([0005](decision/0005-slo-snapshot-to-d1.md)) — 실측 파이프라인 상태는 **실행 기록 탭**이
조회 DB 4종에서 직접 읽는다.

### 4-1-1. 분야 등록부 (`_ops_domain`) — **이건 돌린다**

바로 위와 헷갈리지 않는다. `_ops_slo` 는 파이프라인이 넣는 **측정값**이라 콘솔이 손대지
않지만, `_ops_domain` 은 콘솔 소유의 **참조 내용**(분야 코드 → 한글 이름)이다.
마이그레이션은 표만 만들고 내용은 안 넣으므로 **한 번 돌려야 한다.**

🔴 **`npm run migrate` 를 먼저 돌린다.** 픽스처가 `is_data_domain`(0003)을 채우므로 순서가
바뀌면 `no such column` 으로 끝난다.

```bash
npm run migrate                                  # 0003 — is_data_domain 컬럼
npm run d1 -- --file=fixtures/ops_domain.sql     # INSERT OR REPLACE — 다시 돌려도 안전
npm run d1 -- "SELECT domain,label,has_slo,is_data_domain FROM _ops_domain ORDER BY domain"
```

`is_data_domain` 은 **데이터 분야와 파이프라인 운영 축을 가른다**(#162 🅕). `common`
(파이프라인 운영 지표) 하나만 `0` 이고, 그래야 '측정 가능한 분야' 분모가 **6**(데이터 분야
수)으로 나온다. 안 걸리면 **7** 이 뜬다 — 라벨은 맞는데 숫자가 틀린 상태이고, 화면이
파이프라인 탭에 "분야 종류를 아직 못 가릅니다" 배너로 직접 말한다.

안 하면 화면이 분야를 `culture`·`commerce`·`common` 으로 부른다 — `domLabel()` 이 등록부에
없으면 코드를 그대로 쓰기 때문이다(**화면은 라벨을 지어내지 않는다**). 실제로 운영 등록부가
0행이었고, 원인은 이 내용이 `slo_live.sql`·`slo_sample.sql` 안에 있었던 것이다 — 둘 다
`DELETE FROM _ops_slo` 로 시작해서 **등록부만 채울 방법이 없었다.**
2026-08-07 에 자기 파일로 분리했다(manual-steps §4-1).

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
| `_catalog`·`_publication_ledger`·`d1_catalog_display` | 도메인 export(dbt) |

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
| '응답 상태' 탭에서 **분야를 바꿔도 숫자가 그대로**다 | 예전 결함(2026-08-07 수정). 서버가 분야 축을 안 실어서 KPI·날짜별·요청 종류·이용자가 전체 그대로였다 | 고쳐졌다. `.serving.totals` 가 비면 서버 쪽을 본다(§2 ④-2) |
| 분야별 요청을 다 더해도 **'전체'보다 작다** | **정상이다.** 제품에 안 묶이는 요청(API 목록·인증·키 발급)은 어느 분야에도 안 넣는다 — 화면이 그 건수를 밝힌다 | 조치 없음. `.serving.totals` 의 `domain=null` 이 그 몫이다 |
| 자동 새로고침 때 **보던 탭에서 튕겨 나간다** | 예전 결함(2026-08-07 수정). `render()` 가 주소에서 탭을 다시 골랐는데, 키 탭은 주소를 안 써서 클릭으로 열면 주소가 이전 탭에 머물렀다 | 고쳐졌다. 다시 나면 `activePane()` 이 아니라 주소를 읽고 있는지부터 본다 |
| 공유받은 `#<탭>?dom=<분야>` 링크의 **스코프가 안 걸린다** | 예전 결함(2026-08-07 수정). `showTab` 이 `?dom=` 을 지운 뒤에 읽고 있었다 | 고쳐졌다. 부트에서 `showTab` 보다 **먼저** `DOMSCOPE` 를 세운다 |
| '보는 분야' 선택이 **뜨면 안 되는 탭**(이용 행동·이용자 키)에 뜬다 | `ui.css` 에 `<셀렉터>[hidden]{display:none}` 이 빠졌다 — UA 기본은 author 규칙한테 진다 | `npm run check:hidden` 이 잡는다. JS 는 멀쩡한데 CSS 가 덮는 계열이라 `el.hidden` 검사로는 안 보인다 |
| '보는 분야'를 바꿔도 **일부 카드만** 바뀐다 | 그 탭을 다시 그리는 함수가 스코프를 안 보거나, `setScope` 가 그 함수를 안 부른다 | 스코프를 노출한 탭은 **화면 전부**가 따라야 한다(§5) — KPI·요약 카드까지 확인 |
| 분야가 **영문 코드**로 뜬다 (`culture`·`commerce`·`common`) | `_ops_domain` 등록부가 비었다 — `domLabel()` 은 라벨을 지어내지 않는다 | `npm run d1 -- --file=fixtures/ops_domain.sql` (§4-1-1) |
| API 목록에 제품이 **표 이름**으로 뜬다 (`gold_…`·`d1_…`) | 그 제품이 `meta.serving.display` 를 아직 선언 안 했다 — **정상**(계약이 optional, ASAC-DAG#706) | 콘솔에서 고칠 게 없다. 이름이 필요하면 **도메인 오너**가 dbt yml 에 선언하고 `<domain>_serving_export` 를 돌린다 |
| 제품이 **전부** 표 이름으로 뜬다 | `d1_catalog_display` 를 못 읽었다(표 부재·발행 전) — 목록 위 안내가 그렇게 말한다 | 데이터 준비 상태 탭의 '데이터 소스 상태'에서 그 표의 상태를 본다(`absent`/`mismatch`) |
| :8788 충돌 | 다른 프로세스 | `lsof -i :8788` 로 확인 후 정리 |

## 7. 하지 말 것 (요약)

**남의 표 스키마 변경**(마켓플레이스·ASAC-DAG·dbt 소유) · 마이그레이션에 DROP ·
env 없는 맨 `wrangler deploy` · 이메일 원문 응답 · 토큰 커밋.
전문은 [../CLAUDE.md](../CLAUDE.md) 4절.

> ⚠️ 예전 목록에 있던 **"팀(원격) D1 쓰기 금지"** 는 [0015](decision/0015-single-production-d1.md)
> 로 **폐기**됐다. 이제 쓰기는 열려 있다 — 대신 **되돌릴 수 없다**는 사실이 그 자리를
> 대신한다. 특히 키 삭제는 `_usage`·`_burst`·`_keys` 연쇄 삭제라 복구 경로가 없다.
