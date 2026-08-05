# 콘솔 실행 — 운영 D1 (읽기 **그리고 쓰기**)

> **환경 매뉴얼.** 게이트웨이 개발은 [run-local.md](run-local.md),
> 구조와 배분은 [environments.md](environments.md), 지도는 [index.md](index.md).
>
> ⚠️ 2026-08-05 전면 개정. 예전엔 "운영을 **보기만** 하는 환경"이었다.
> **dev D1 폐기로 이제 콘솔의 유일한 환경이고, 쓰기가 열려 있다**
> ([decision/0015](../ops-dashboard/docs/decision/0015-single-production-d1.md)).

**콘솔 개발·검증·조치를 전부 여기서 한다.** 워커는 내 노트북에서 돌고 D1 만 운영 것에
붙는다 — 그것 자체는 배포가 아니다(공개 URL 이 생기지 않는다). 다만 **데이터는 실물이다.**

| | |
|---|---|
| D1 | `ask-seoul-prod-d1` (원격) — **하나뿐이다** |
| 플래그 | **없다.** 바인딩에 `remote = true` 가 박혀 있다 |
| 쓰기 | ✅ **열려 있다** — 화면 조치가 실제 고객 키에 간다 |
| 잠긴 것 | **스키마뿐** — 남의 표 DDL 은 `npm run d1` 이 막는다 |
| 주소 | `:8788` |

## 🔴 먼저 읽을 것

**운영 D1 은 62개 제품이 사는 파이프라인의 DB 다.** 그리고 **D1 의 Time Travel 은 표 단위가
아니라 DB 전체를 덮어쓴다** — 되돌리는 순간 발급된 키·쿼터·요청 로그가 같이 과거로 간다
(ASAC-DAG#476). **"일단 해 보고 안 되면 되돌린다"가 성립하지 않는다.**

예전에는 그 위험을 **환경으로** 막았다(연습은 로컬에서). 지금은 **연습할 곳이 없다.**
남은 방어선은 셋뿐이다:

1. **화면의 2단 확인** — 폐기·삭제는 버튼을 두 번 눌러야 한다
2. **`OPS_TOKEN`** — 조치는 잠금 해제 뒤에만 (읽기는 열려 있다)
3. **스키마 잠금** — 남의 표 모양은 못 바꾼다(아래 §4)

**조치 이력은 안 남는다.** 토큰이 공유 정적값 하나라 "누가 했나"에 답할 수 없다
(0015 §대가 — 0004 개정이 선행돼야 한다).

## 1. 자격증명

```bash
cd ops-dashboard
cp .env.example .env      # CLOUDFLARE_API_TOKEN · CLOUDFLARE_ACCOUNT_ID
```

원격 바인딩이라 **자격증명이 없으면 화면이 아예 안 뜬다** — 로컬 사본이 없기 때문이다.

권한은 하는 일에 맞춘다. **토큰 권한이 이제 유일한 바깥 방어선이다**:

| 권한 | 할 수 있는 것 |
|---|---|
| `D1:Read` | 보기만. **조치 버튼을 눌러도 실패한다** — 실수로 지울 일이 없다 |
| `D1:Edit` | 조치까지. 실제 고객 키를 지울 수 있다 |

> **평소에는 `D1:Read` 를 권한다.** 조치할 일이 생겼을 때만 올린다.

## 2. 띄우기

```bash
cd ops-dashboard
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
npm run dev               # :8788 — 🔴 띄우는 순간 운영이다
```

## 3. 운영을 보고 있는지 확인한다 — **이걸 건너뛰지 않는다**

```bash
curl -s "http://localhost:8788/api/summary?days=14" | jq '{env: .meta.env, scope: .meta.runs_env_scope, runs: (.runs.daily|length)}'
# { "env": { "label": "운영 D1 (로컬 구동)", "d1": "ask-seoul-prod-d1" },
#   "scope": "prod", "runs": 98 }
```

🔴 **`runs` 가 0 이면 연결이 틀린 것이다.** 실측(2026-08-05)에서 잡은 함정인데,
**배지도 `meta.env` 도 "운영"이라고 답하면서 질의만 빈 결과**가 나왔다. 강등 로직이 그걸
"표가 없습니다"로 표시해서 **화면만 보면 "운영에 데이터가 없다"로 읽힌다.**

| 시도 | 결과 |
|---|---|
| `wrangler dev --remote` (옛 플래그) | 전부 빈 결과 |
| `--remote` + `preview_database_id` | 전부 빈 결과 |
| **바인딩 `remote = true` + 플래그 없는 `wrangler dev`** | **정상** |

`--remote` **플래그는 폐기 경로다**(wrangler 가 기동 로그에서 직접 안내한다).
`experimental_remote` 는 없는 필드라 **경고만 찍고 local 로 조용히 떨어진다.**

### 운영 화면은 prod 기록만 센다

`ENV_SCOPE = "prod"` 라 실행 기록을 `environment='prod'` 로 좁힌다. 실측 운영 D1 에
`environment='dev'` 17행이 섞여 있다 — 도메인 쪽 환경 판정 결함은 고쳐졌지만 **과거 행은
남는다**(#78 Z-7). 거르지 않으면 개발 실행이 운영 지표에 들어간다.

**무엇이 빠졌는지는 화면이 직접 밝힌다** — `meta.runs_env_excluded` 에 제외 건수가,
`meta.runs_env_scope_partial` 에 "집계표는 `environment` 컬럼이 없어 **못 걸렀다**"가 실린다
([decision/0012](../ops-dashboard/docs/decision/0012-runs-tab-observation-boundaries.md)).

## 4. SQL 로 직접 볼 때 — 쓰기는 되고 스키마는 안 된다

```bash
cd ops-dashboard
npm run d1 -- "SELECT COUNT(*) AS n FROM _ops_run_event"
npm run d1 -- "UPDATE _keys SET daily_quota = 500 WHERE key_hash = '...'"   # 경고를 찍고 실행
npm run d1 -- "ALTER TABLE _keys ADD COLUMN x TEXT"                          # ❌ 거절
```

**`CREATE`·`ALTER`·`DROP`·`TRUNCATE`·`VACUUM`·`ATTACH` 는 대상 표가 무엇이든 거절된다.**
스키마는 마이그레이션 장부를 거쳐야 하기 때문이다([0007](../ops-dashboard/docs/decision/0007-schema-single-file-reset.md)) —
손으로 친 DDL 은 장부에 안 남아 다음 사람의 `migrate` 를 어긋나게 한다.

남의 표에 **데이터를** 쓰면 막지는 않고 경고를 찍는다 — 키 조치가 그 경로다.

## 5. 스키마를 적용해야 할 때

```bash
npm run migrate:list      # 무엇이 적용됐나 먼저
npm run migrate           # 장부 백필 → apply
```

`migrations/` 는 전부 `CREATE TABLE IF NOT EXISTS` 이고 DROP·ALTER 가 없다 —
**있는 표는 건드리지 않는다.**

🔴 **`0002` 는 운영에서 실행되지 않는다.** 조회 DB 4종의 미러인데, 운영엔 ASAC-DAG 가 만든
진짜 표가 있어 `CREATE TABLE IF NOT EXISTS` 는 넘어가도 **`CREATE INDEX` 3개가
`_ops_run_event`(수만 행, 남의 운영 표)에 실제로 만들어진다.** 장부 백필이 **표가 이미
있으면 실행 없이 기록만** 해서 건너뛴다(`scripts/backfill-migrations-ledger.sql`).

**CD 는 마이그레이션을 돌리지 않는다** — 코드만 배포한다. 운영 스키마가 머지 타이밍에
바뀌면 되돌릴 창이 없다.

## 6. 배포

```bash
npm run deploy:prod       # → ops.ask-seoul.kr
```

**`dev` 브랜치에 머지하면 CD 가 자동으로 같은 일을 한다**
(`.github/workflows/deploy-prod.yml`). ⚠️ **브랜치 이름과 배포 환경이 다르다** —
`dev` 머지 = 운영 배포다.

⚠️ 읽기 경로는 여전히 무인증이라([0004](../ops-dashboard/docs/decision/0004-read-open-write-token.md))
Access 승격(#20 B-1)이 미완인 채 공개된다.

## 7. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 아예 안 뜬다 / D1 바인딩 오류 | `.env` 의 토큰 없음·만료 | 로컬 사본이 없어 자격증명 없이는 못 뜬다 |
| **배지는 "운영"인데 전부 비었다** | 🔴 연결이 로컬로 떨어졌다 | §3 표 — `remote = true` 인지, 오타(`experimental_remote`)가 아닌지 |
| 응답 상태·이용 행동·API 사용량·이용자 키 탭이 비었다 | 운영 D1 에 게이트웨이 표가 **아직 없다** | 정상 — 게이트웨이 전환(#85) 후 채워진다 |
| 조치가 `403`/권한 오류 | 토큰이 `D1:Read` | 의도한 것이면 그대로 둔다(§1) |
| 조치가 `503` | `OPS_TOKEN` 미설정 | `.dev.vars` 작성 후 재시작 |
| `npm run d1` 이 DDL 거부 | **정상이다** | §4 — 스키마는 `migrations/` 로 |

## marketplace 는?

게이트웨이는 **아직 전환되지 않았다.** `_burst`·`_usage`·`_gateway_request_log` 때문에
**GET 하나에도 D1 에 쓰므로**, 옛 "보기 전용" 방식이 애초에 성립하지 않았다. 운영 D1 로
옮길지와 계량 경로를 어떻게 할지는 **게이트웨이 담당자의 판단**이다 — **#85** 에 정리해 뒀다.

그때까지 게이트웨이 로컬 개발은 [run-local.md](run-local.md) 대로 Miniflare 를 쓴다.
**두 프로젝트의 로컬이 서로 다른 DB 를 본다** — 콘솔에서 발급한 키가 게이트웨이 로컬에
안 보이는 것이 지금은 정상이다.
