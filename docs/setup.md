# 로컬 실행 매뉴얼 — macOS / Windows

> **이 문서는 API 담당자와 대시보드 담당자가 함께 관리한다.**
> 실행·시드·포트·비밀값 규약을 바꾸는 변경은 같은 커밋에서 이 문서를 고치고 상대 담당자에게 알린다.

> 🔴 **2026-08-06 — 두 프로젝트 다 로컬에서 운영 D1 에 붙는다.**
> 예전에는 로컬에서 **같은 로컬 D1 상태를 공유**했다. dev D1 폐기로
> **두 프로젝트 다 운영 D1 에 직접 붙는다**([decision/0015](../ops-dashboard/docs/decision/0015-single-production-d1.md) ·
> 게이트웨이는 **#85** 로 2026-08-06 전환). 그래도 이 문서는 **절마다 프로젝트를 나눠
> 적는다** — D1 은 같아졌지만 시크릿·명령·배포면이 다르다.

| 담당 | 프로젝트 | 포트 | 무엇을 보나 | 시드 |
|---|---|---|---|---|
| API | [marketplace/](../marketplace/) | `:8787` | 🔴 **운영 D1** | **없음** |
| 대시보드 | [ops-dashboard/](../ops-dashboard/) | `:8788` | 🔴 **운영 D1** | **없음** |

**콘솔 절차의 정본은 [run-prod.md](run-prod.md)** 다. 이 문서에는 OS별 설치·실행까지만 적고,
운영 D1 을 다룰 때의 주의(토큰 권한·스키마 잠금·조치 검증)는 그쪽이 정본이다.

## ⚠️ 이 문서의 범위 — 로컬에서 띄우는 것까지다

**두 Worker는 별개 배포 단위다.** 별도 Worker · 별도 호스트가 기초 결정이고
([decision/0001](../ops-dashboard/docs/decision/0001-separate-worker-from-marketplace.md)),
배포도 각자 나간다 — 청중이 다르고, 배포 단위가 갈려야 사고 반경도 갈리기 때문이다.

| | 게이트웨이 | 콘솔 |
|---|---|---|
| 로컬에서 보는 것 | 🔴 **운영 D1** (바인딩 `remote = true`) | 🔴 **운영 D1** (같음) |
| 로컬 쓰기의 범위 | **운영 `_keys`·`_usage`·`_burst` 에 간다** | **실제 고객 키에 간다** |
| 설정 | `wrangler.toml` 기본 환경 = 운영 | 같음 |
| 배포 | `npm run deploy:prod` | `npm run deploy:prod` · `main` 머지 시 CD 자동 |
| 절차 정본 | 이 문서 + [deploy-runbook](../marketplace/docs/deploy-runbook.md) | [run-prod.md](run-prod.md) |

예전에는 콘솔이 `--persist-to` 로 게이트웨이의 로컬 상태에 붙어 두 프로젝트가 한 **로컬**
D1 을 공유했다. 지금은 둘 다 **운영 D1** 을 직접 본다 — **게이트웨이 로컬에서 발급한 키가
콘솔 화면에 그대로 보인다.** 쓰고 나면 `DELETE /api/v1/keys?purge=true` 로 지운다.

**환경마다 달라지는 값이 어디에 있는지는 [environments.md](environments.md)가 정본이다** —
설정 배치, 도메인·D1 값, env 섹션 비상속 함정. 이 문서는 그 구조 위에서
**OS별로 어떻게 실행하는가**만 다룬다.

## 0. 순서 — **없다**

예전에는 한 로컬 D1 을 공유해서 "marketplace 시드 먼저"라는 순서가 있었다. 지금은 아니다.

```text
게이트웨이   npm run dev                          (:8787 · 🔴 운영 D1)
콘솔         npm run dev                          (:8788 · 🔴 운영 D1)
```

**두 프로젝트가 서로를 기다리지 않는다.** 둘 다 운영 D1 을 직접 보므로 시드 단계 자체가
없다 — 아무 순서로 띄워도 되고, 한쪽만 띄워도 된다.

> 🔴 **게이트웨이 로컬에서 발급한 키가 콘솔 화면에 그대로 보인다.** 같은 DB 다(#85).
> 검증용으로 발급했다면 `DELETE /api/v1/keys?purge=true` 로 지운다.

### 콘솔의 네 탭 — 이제 채워진다

응답 상태·이용 패턴 분석·API 사용량·이용자 키. 운영 D1 에 게이트웨이 표(`_keys`·
`_gateway_request_log` 등)가 **2026-08-06 에 생겼다.** 그 전에는 비는 것이 정상이었지만
지금은 아니다 — 비면 `npm run migrate:list` 로 적용 상태를 본다. `GET /api/summary` 의
`meta.missing` 에 비는 **구획** 이름이 실리고(설계상 강등이지 고장이 아니다), 어느 **표**가
문제인지는 '데이터 준비 상태' 탭의 '데이터 소스 상태'가 `없음`·`구조 다름`으로 알린다.

## 1. 사전 준비

| | macOS | Windows |
|---|---|---|
| Node **20+** | `brew install node` | `winget install OpenJS.NodeJS.LTS` |
| Python **3.11+** (SLO 실적재만) | 내장 / `brew install python` | `winget install Python.Python.3.13` |
| Trino (SLO 실적재만) | `ask-seoul` 레포 docker-compose | 동일 |

`openssl`은 **필요 없다.** 예전 매뉴얼이 토큰 생성에 썼지만 Windows PowerShell에는 없다 —
아래 절차는 Node로 대체한다(3절).

### Windows: 설치 후 터미널·IDE를 반드시 재시작

winget 설치는 **이미 열려 있는 셸의 PATH에 반영되지 않는다.** 설치 직후 같은 창에서
`node -v`를 치면 `'node'은(는) 내부 또는 외부 명령...`이 그대로 나온다. 고장이 아니라
PATH 미갱신이다. PowerShell 창과 IntelliJ/VS Code를 닫았다 연다.

### 확인

```bash
node -v      # v20 이상
npm -v
python3 --version    # macOS
```

```powershell
node -v
npm -v
python --version     # Windows 는 python (python3 아님)
npm config get script-shell   # null 이어야 정상 — 아래 6절 참고
```

## 2. 실행

**두 프로젝트를 따로 적는다.** 순서 의존이 없으니 필요한 쪽만 보면 된다.

### 2-1. 🔴 게이트웨이 (`marketplace`) — 운영 D1

```bash
# macOS / Linux
cd marketplace
cp .dev.vars.example .dev.vars     # ISSUANCE_SALT
cp .env.example .env               # CLOUDFLARE_API_TOKEN — 원격 바인딩에 필요
npm install
npm run dev                        # http://localhost:8787 · 🔴 운영 D1
```

```powershell
# Windows (PowerShell)
cd marketplace
Copy-Item .dev.vars.example .dev.vars
Copy-Item .env.example .env
npm install
npm run dev                        # http://localhost:8787 · 🔴 운영 D1
```

**`--remote` 플래그를 붙이지 않는다.** 붙이면 바인딩 이름은 맞는데 질의만 비고, 화면은
그걸 "표가 없습니다"로 표시한다 — 콘솔이 먼저 밟은 함정이다([environments.md §3-4](environments.md)).
기동 로그에 `Mode: remote` 가 뜨는지로 확인한다.

### 2-2. 🔴 콘솔 (`ops-dashboard`) — 운영 D1

**`npm run seed` 가 없다.** 띄우는 순간 운영 DB 에 붙는다 — 절차 정본은 [run-prod.md](run-prod.md).

```bash
# macOS / Linux
cd ops-dashboard
npm install
cp .env.example .env               # CLOUDFLARE_API_TOKEN — 없으면 아예 안 뜬다
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
npm run dev                        # http://localhost:8788  🔴 운영 D1
```

```powershell
# Windows (PowerShell) — -Encoding ascii 를 빼지 말 것 (3절)
cd ops-dashboard
npm install
Copy-Item .env.example .env
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" | Set-Content .dev.vars -Encoding ascii
npm run dev                        # http://localhost:8788  🔴 운영 D1
```

### 2-3. 공통 — PowerShell 과 npm 경고

`&&`는 Windows PowerShell 5.1에서 **파서 오류**다. 명령을 이어 쓸 땐 `;`를 쓰거나 한 줄씩
실행한다. (`package.json` 안의 `&&`는 npm이 `cmd.exe`로 실행하므로 그대로 동작한다 —
게이트웨이의 마이그레이션 스크립트는 손댈 필요 없다.)

`npm install` 중 아래 경고가 나오지만 **무시해도 된다** — workerd 실행 파일은 postinstall이
아니라 플랫폼 optional 의존성(`@cloudflare/workerd-windows-64`)으로 들어오므로
`wrangler dev`는 정상 동작한다(실측 확인).

```text
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   esbuild@... / workerd@...
```

## 3. 🔴 콘솔 전용 — `OPS_TOKEN` (Windows에서 가장 많이 깨지는 곳)

`ops-dashboard`의 폐기·복구·쿼터·삭제는 `.dev.vars`(프로젝트 루트)의 `OPS_TOKEN`으로 잠겨 있다.
미설정이면 조치가 `503`으로 닫힌다(열리는 게 아니라 닫힌다 — 설계).

### 토큰 생성 — openssl 없이

옛 매뉴얼의 `openssl rand -hex 16`은 Windows PowerShell에서 그대로 실패한다
(`'openssl'은(는) ... 인식되지 않습니다`). Node로 대체한다 — 어차피 Node는 이미 깔려 있다.

```bash
# macOS / Linux
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
```

```powershell
# Windows — -Encoding ascii 를 빼지 말 것 (아래 표)
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" | Set-Content .dev.vars -Encoding ascii
```

위 명령은 `.dev.vars`를 **통째로 새로 쓴다.** 변수의 의미는
[`ops-dashboard/.dev.vars.example`](../ops-dashboard/.dev.vars.example)에
있으니, 주석까지 남기고 싶으면 그 파일을 복사한 뒤 에디터로 값만 채운다(에디터 편집이 가장 안전하다).

### 왜 인코딩을 지정해야 하나 (실측)

| 쓰는 방법 | 파일 인코딩 | wrangler | 증상 |
|---|---|---|---|
| `Set-Content -Encoding ascii` | ASCII | ✅ 읽음 | 정상 |
| `echo "..." > .dev.vars` | UTF-8 **BOM** | ✅ 읽음 | 정상 (BOM은 허용됨) |
| `Set-Content -Encoding Unicode` | UTF-16LE | ❌ 못 읽음 | 조치가 전부 **503** |

UTF-16LE가 위험한 이유는 **조용히** 실패하기 때문이다. 기동 로그에는
`Using secrets defined in .dev.vars`가 **그대로 뜨고**, 화면도 정상으로 보이고,
오직 조치만 `503 ops write disabled`로 막힌다. PowerShell `>`의 기본 인코딩은 프로필·버전에 따라
달라지므로(이 레포 실측 환경에서는 UTF-8 BOM) **`>`에 의존하지 말고 `-Encoding ascii`를 명시**한다.

기동 로그에 그 줄 자체가 없으면 인코딩이 아니라 **위치** 문제다 — wrangler 는 `.dev.vars` 를
`wrangler.toml` 옆(= 프로젝트 루트)에서 찾는다. 다른 디렉토리에서 만들지 않았는지 본다.

## 4. 뜬 다음 확인

**판정 기준이 프로젝트마다 다르다.** 콘솔은 `meta.missing` 이 비어 있지 **않은 것이 정상**이다.

### 4-1. 게이트웨이 (`marketplace`)

```bash
curl -s "http://localhost:8787/api/v1/catalog" -o /dev/null -w "%{http_code}
"   # 200
```

```powershell
(Invoke-WebRequest "http://localhost:8787/api/v1/catalog" -UseBasicParsing).StatusCode
```

### 4-2. 🔴 콘솔 (`ops-dashboard`)

```bash
curl -s "http://localhost:8788/api/summary?days=14" | jq '{env: .meta.env, missing: .meta.missing, runs: (.runs.daily|length)}'
```

```powershell
(Invoke-WebRequest "http://localhost:8788/api/summary?days=14" -UseBasicParsing).Content.Substring(0,300)
```

| 보이는 것 | 뜻 |
|---|---|
| `env.d1 = "ask-seoul-prod-d1"` | 운영 D1 을 보고 있다 |
| `runs > 0` | **연결이 실제로 됐다.** 0 이면 조용히 로컬로 떨어진 것 — [run-prod.md §3](run-prod.md) |
| `missing` 에 `serving` | 🔴 **더는 정상이 아니다** — 표는 2026-08-06 에 생겼다. 비면 마이그레이션 미적용을 의심한다 |

> 옛 매뉴얼은 *"`meta.missing` 이 `[]` 면 두 프로젝트가 같은 D1 을 공유하는 것"* 이라고 했다.
> **더는 성립하지 않는다** — 두 프로젝트는 다른 DB 를 보고, `missing` 은 당분간 비지 않는다.
> 연결 여부는 `missing` 이 아니라 **`runs` 건수**로 본다.

### 4-3. 콘솔 토큰 게이트 3종 (대시보드 담당자 필수)

미설정 `503` · 토큰 없음 `401` · 올바른 토큰 `400`(없는 키라서 — 게이트는 통과한 것):

```powershell
$tok = ((Get-Content .dev.vars -Raw) -replace '^OPS_TOKEN=','').Trim()
$body = '{"action":"quota","key_hash":"nonexistent","daily_quota":10}'
Invoke-WebRequest "http://localhost:8788/api/keys" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing
Invoke-WebRequest "http://localhost:8788/api/keys" -Method POST -Headers @{Authorization="Bearer $tok"} -Body $body -ContentType 'application/json' -UseBasicParsing
```

🔴 **정상 경로(200) 검증은 실제 고객 키에 하지 않는다.** 확인용 키를 직접 발급해 그것으로만 한다.

## 5. ~~SLO 실적재~~ — **폐기된 절** (콘솔)

⚠️ **이 절은 낡았다** — `load_slo.py` 경로는 폐기됐고([decision/0005](../ops-dashboard/docs/decision/0005-slo-snapshot-to-d1.md)),
콘솔에는 로컬 D1 자체가 없다(0015). `_ops_slo` 를 채우는 정규 경로는 culture DAG 의 export
task 이고 아직 안 붙었다 — 그래서 '데이터 준비 상태' 탭은 비어 있는 것이 정상이다.

<!-- 아래는 폐기된 절차의 기록이다. `ops-dashboard/scripts/load_slo.py`는 Trino의 `gold_*_slo_daily`를 읽어 로컬 D1에 넣었다.
안 돌려도 콘솔은 합성 샘플로 뜬다(`is_sample=1` 배너).

**환경변수 주입 문법이 OS마다 다르다.** `VAR=값 명령` 접두 문법은 PowerShell에 없다.

```bash
# macOS / Linux
python3 scripts/load_slo.py --dry-run
TRINO_URL=http://127.0.0.1:30586 TRINO_CATALOG=iceberg_dev python3 scripts/load_slo.py
```

```powershell
# Windows
python scripts\load_slo.py --dry-run
$env:TRINO_URL  = 'http://127.0.0.1:30586'
$env:TRINO_CATALOG = 'iceberg'
python scripts\load_slo.py
```

### 카탈로그 이름은 환경마다 다르다

스크립트 기본값은 `iceberg_dev`지만 docker-compose 구성에 따라 `iceberg`인 환경이 있다.
`Catalog 'iceberg_dev' not found`가 뜨면 **Trino 접속은 성공한 것**이고 이름만 다른 것이다.
확인:

```bash
curl -s -X POST -H "X-Trino-User: ops" -H "Content-Type: text/plain" \
  --data "SHOW CATALOGS" http://127.0.0.1:30586/v1/statement
```

포트(`30586`)는 `docker ps`의 `trino` 컨테이너 매핑에서 확인한다.
-->

## 6. 증상별 해결

### 6-1. 공통 (설치·셸·포트)

| 증상 | 원인 | 해결 |
|---|---|---|
| `'node'은(는) 내부 또는 외부 명령...` | 설치 후 PATH 미갱신 | 터미널·IDE 재시작 (1절) |
| `'openssl'은(는) ... 인식되지 않습니다` | Windows에 openssl 없음 | `node -e` 로 토큰 생성 (3절) |
| `The token '&&' is not a valid statement separator` | PowerShell 5.1엔 `&&` 없음 | `;` 로 바꾸거나 한 줄씩 (2-3절) |
| npm 스크립트가 `&&`에서 멈춤 | npm의 script-shell이 PowerShell로 잡힘 | `npm config delete script-shell` |
| dev 가 `:8789` 등 엉뚱한 포트로 뜸 | 8787/8788 을 이전 프로세스가 쥐고 있음 | 아래 포트 항목 — 포트는 `[dev] port` 로 고정돼 있으나 점유 시 밀린다 |
| `Address already in use :8787/:8788` | 이전 dev가 살아 있음 | `Get-Process workerd \| Stop-Process -Force` (전부 정리) |
| 첫 `wrangler dev`에서 방화벽 팝업 | workerd가 포트 대기 | **개인 네트워크만** 허용 |

### 6-2. 게이트웨이 (`marketplace`)

| 증상 | 원인 | 해결 |
|---|---|---|
| 카탈로그가 비었다 | 운영 D1 에 안 붙었다(조용히 로컬로 떨어짐) | 기동 로그에 `Mode: remote` 가 뜨는지 · `--remote` 를 붙이지 않았는지 |
| `npm run seed` 가 없다 | ⚠️ **정상** — #85 로 삭제됐다 | 스키마 적용은 `migrate:backfill` → `migrate:apply` |
| `Catalog '...' not found` | Trino 카탈로그 이름 차이 | `SHOW CATALOGS` 로 확인 (5절은 폐기됨 — 참고만) |

### 6-3. 🔴 콘솔 (`ops-dashboard`)

| 증상 | 원인 | 해결 |
|---|---|---|
| **아예 안 뜬다** / D1 바인딩 오류 | `.env` 의 `CLOUDFLARE_API_TOKEN` 없음·만료 — 원격 바인딩이라 로컬 사본이 없다 | `cp .env.example .env` 후 채운다 ([run-prod.md §1](run-prod.md)) |
| 배지는 "운영"인데 **전부 비었다** | 🔴 연결이 조용히 로컬로 떨어졌다 | `remote = true` 인지, `experimental_remote` 오타가 아닌지 ([run-prod.md §3](run-prod.md) 실측표) |
| `_keys`·`_gateway_request_log` 가 `없음` · 네 탭이 빔 | 🔴 **더는 정상이 아니다** — 표는 2026-08-06 에 생겼다 | 게이트웨이 `npm run migrate:list` 로 적용 상태 확인 |
| '데이터 준비 상태' 탭이 빔 | ⚠️ **정상** — `_ops_slo` 를 채우는 경로가 아직 없다 | culture DAG export 대기 |
| `npm run seed` 가 없다 | ⚠️ **정상** — 0015 로 삭제됐다 | 스키마 적용은 `npm run migrate` |
| 조치만 `503 ops write disabled` | `.dev.vars`가 UTF-16LE | `-Encoding ascii`로 다시 쓰기 (3절) |
| 조치만 `503` + 기동 로그에 `Using secrets...` 줄이 **아예 없음** | `.dev.vars`가 프로젝트 루트에 없음 | `wrangler.toml` 옆(루트)으로 옮긴다 (3절) |
| 조치가 `401` | 토큰 불일치 | 화면 우상단 `잠금 해제`에 `.dev.vars` 값 그대로 입력 |
| 조치가 `403`/권한 오류 | 토큰이 `D1:Read` | 의도한 것이면 그대로 둔다 ([environments.md §3-2](environments.md)) |
| `npm run d1` 이 DDL 거부 | ⚠️ **정상** | 스키마는 `migrations/` + `npm run migrate` |

## 7. 이 문서가 실측한 환경

아래 조합에서 **1~5절 전 구간을 실제로 실행해 확인**했다(2026-08-03).

| | 값 |
|---|---|
| OS | Windows 11 Pro 26200 / PowerShell 5.1 |
| Node · npm | v24.18.1 · 11.16.0 |
| wrangler | 4.114.0 (ops-dashboard) · 4.115.0 (marketplace) |
| Python | 3.13.12 |
| 확인 결과 | 두 Worker 동시 구동(:8787 · :8788) · `meta.missing=[]` · 토큰 401/401/400 · Trino 실적재 35행 |
| 환경 구조 | 기본 환경으로 시드·구동·토큰 게이트 재확인 · `[env.production]` 은 `deploy --dry-run --env production` 으로 빌드까지만 |

macOS 절차는 기존 매뉴얼을 그대로 옮긴 것으로, **이 문서 작성 시점에 재검증하지는 않았다.**
macOS에서 어긋나는 부분을 발견하면 이 문서를 고치고 상대 담당자에게 알린다.
