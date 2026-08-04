# 로컬 실행 매뉴얼 — macOS / Windows

> **이 문서는 API 담당자와 대시보드 담당자가 함께 관리한다.**
> `marketplace/`(API)와 `ops-dashboard/`(대시보드)는 코드를 공유하지 않지만
> **로컬에서는 같은 D1 상태를 공유**한다. 그래서 **로컬 실행 절차는** 두 개가 아니라 하나다 —
> 한쪽 절차만 고치면 다른 쪽이 조용히 깨진다. 실행·시드·포트·비밀값 규약을 바꾸는 변경은
> 같은 커밋에서 이 문서를 고치고, 상대 담당자에게 알린다.

| 담당 | 프로젝트 | 로컬 포트 | 이 문서에서의 위치 |
|---|---|---|---|
| API | [marketplace/](../marketplace/) | `:8787` | **먼저 시드해야 하는 쪽** — 로컬 D1 상태의 주인 |
| 대시보드 | [ops-dashboard/](../ops-dashboard/) | `:8788` | 저쪽 상태에 `--persist-to`로 붙어 읽는다 |

## ⚠️ 이 문서의 범위 — 로컬 개발뿐이다

**두 Worker는 별개 배포 단위다.** 별도 Worker · 별도 호스트가 기초 결정이고
([ops-dashboard decision/0001](../ops-dashboard/docs/decision/0001-separate-worker-from-marketplace.md)),
배포도 각자 나간다 — 청중이 다르고, 배포 단위가 갈려야 사고 반경도 갈리기 때문이다.

이 문서가 말하는 "절차가 하나"는 **그 분리를 되돌리는 말이 아니라, 분리의 대가**다.
0001이 "대가" 절에 이미 적어 둔 그대로다 — 호스트를 나눴으니 로컬에서는 상태를 붙여 줘야 한다.

| | 로컬 (이 문서) | 배포 |
|---|---|---|
| 프로세스 | 두 개를 내가 띄운다 | 각자 Worker로 따로 나간다 |
| 호스트 | `localhost:8787` / `:8788` | 기준 도메인 / `ops.` 서브도메인 (zone 확인 대기) |
| 설정 | `wrangler.toml` 기본 환경 | 같은 파일의 `[env.production]` + `--env production` 명시 |
| D1 공유 방법 | `--persist-to` 로 파일 상태를 겹친다 | 두 설정이 **같은 `database_id`** 를 바인딩한다 |
| 순서 | marketplace 시드 먼저 | 순서 의존 없음 — 콘솔은 저쪽 **Worker** 가 아니라 **테이블**에 의존한다 |
| 절차 문서 | **이 문서 하나** | 프로젝트마다 따로 ([marketplace/docs/deploy-runbook.md](../marketplace/docs/deploy-runbook.md)) |

`--persist-to`는 **로컬 전용 장치**라 배포판에 대응물이 없다. 배포에서 같은 역할을 하는 건
두 설정이 같은 D1을 가리키는 것이다.

**환경마다 달라지는 값이 어디에 있는지는 [environments.md](environments.md)가 정본이다** —
설정 배치, 로컬/운영 도메인·D1 값, env 섹션 비상속 함정. 이 문서는 그 구조 위에서
**OS별로 어떻게 실행하는가**만 다룬다.

원격 배포는 아직 하지 않는다(`wrangler deploy` 금지 — 멘토 게이트 ASAC-DAG#476 ①).
아래는 전부 `wrangler dev` 로컬 구동이다.

## 0. 순서가 정해져 있다

```text
marketplace 시드  →  ops-dashboard 시드  →  둘 다 dev
     (_keys · _request_log 생성)   (_ops_slo 생성)
```

`ops-dashboard`의 `seed`·`dev`는 `--persist-to ../marketplace/.wrangler/state`로 돈다.
**marketplace를 먼저 시드하지 않으면** 콘솔은 뜨지만 서빙 품질·키 관리 탭이 비고
`GET /api/summary`의 `meta.missing`에 테이블 이름이 실린다(설계상 강등이지, 고장이 아니다).

이 순서는 **로컬 한정**이다. 콘솔이 기다리는 건 marketplace의 *실행*이 아니라 그쪽이 만든
*테이블*이라, 배포에서는 마이그레이션이 그 자리를 대신한다(런북 2번). 배포된 게이트웨이가
꺼져 있어도 콘솔은 뜬다 — 그게 별도 호스트로 나눈 이유다.

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

### macOS / Linux (bash·zsh)

```bash
# 1) API — D1 상태의 주인. 먼저.
cd marketplace
cp .dev.vars.example .dev.vars     # ISSUANCE_SALT
npm install
npm run seed
npm run dev &                      # http://localhost:8787

# 2) 대시보드
cd ../ops-dashboard
npm install
npm run seed
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
npm run dev                        # http://localhost:8788
```

### Windows (PowerShell)

`&&`는 Windows PowerShell 5.1에서 **파서 오류**다. 명령을 이어 쓸 땐 `;`를 쓰거나
한 줄씩 실행한다. (`package.json` 안의 `&&`는 npm이 `cmd.exe`로 실행하므로 그대로 동작한다 —
아래 `npm run seed`는 손댈 필요 없다.)

```powershell
# 1) API — D1 상태의 주인. 먼저.
cd marketplace
Copy-Item .dev.vars.example .dev.vars
npm install
npm run seed
Start-Process powershell -ArgumentList '-NoExit','-Command','npm run dev'   # :8787, 새 창

# 2) 대시보드
cd ..\ops-dashboard
npm install
npm run seed
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" | Set-Content .dev.vars -Encoding ascii
npm run dev                        # http://localhost:8788
```

`npm install` 중 아래 경고가 나오지만 **무시해도 된다** — workerd 실행 파일은 postinstall이
아니라 플랫폼 optional 의존성(`@cloudflare/workerd-windows-64`)으로 들어오므로
`wrangler dev`는 정상 동작한다(실측 확인).

```text
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   esbuild@... / workerd@...
```

## 3. `OPS_TOKEN` — Windows에서 가장 많이 깨지는 곳

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

```bash
# macOS / Linux
curl -s "http://localhost:8788/api/summary?days=14" | head -c 300
curl -s "http://localhost:8787/api/catalog" -o /dev/null -w "%{http_code}\n"
```

```powershell
# Windows — curl 은 PowerShell 5.1 에서 Invoke-WebRequest 별칭이라 옵션이 다르다
(Invoke-WebRequest "http://localhost:8788/api/summary?days=14" -UseBasicParsing).Content.Substring(0,300)
(Invoke-WebRequest "http://localhost:8787/api/catalog" -UseBasicParsing).StatusCode
```

`meta.missing`이 `[]`면 두 프로젝트가 같은 D1을 제대로 공유하고 있다는 뜻이다.

토큰 게이트까지 보려면(대시보드 담당자 필수 확인 3종 — 미설정 `503` · 토큰 없음 `401` ·
틀린 토큰 `401`):

```powershell
$tok = ((Get-Content .dev.vars -Raw) -replace '^OPS_TOKEN=','').Trim()
$body = '{"action":"quota","key_hash":"nonexistent","daily_quota":10}'
# 토큰 없음 → 401
Invoke-WebRequest "http://localhost:8788/api/keys" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing
# 올바른 토큰 → 400 (key_hash 가 없으니 400 이 정상 — 401·503 이 아니면 게이트는 통과한 것)
Invoke-WebRequest "http://localhost:8788/api/keys" -Method POST -Headers @{Authorization="Bearer $tok"} -Body $body -ContentType 'application/json' -UseBasicParsing
```

## 5. SLO 실적재 (선택 — Trino가 떠 있을 때만)

`ops-dashboard/scripts/load_slo.py`는 Trino의 `gold_*_slo_daily`를 읽어 로컬 D1에 넣는다.
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

## 6. 증상별 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `'node'은(는) 내부 또는 외부 명령...` | 설치 후 PATH 미갱신 | 터미널·IDE 재시작 (1절) |
| `'openssl'은(는) ... 인식되지 않습니다` | Windows에 openssl 없음 | `node -e` 로 토큰 생성 (3절) |
| `The token '&&' is not a valid statement separator` | PowerShell 5.1엔 `&&` 없음 | `;` 로 바꾸거나 한 줄씩 (2절) |
| 조치만 `503 ops write disabled` | `.dev.vars`가 UTF-16LE | `-Encoding ascii`로 다시 쓰기 (3절) |
| 조치만 `503` + 기동 로그에 `Using secrets...` 줄이 **아예 없음** | `.dev.vars`가 프로젝트 루트에 없음 | `wrangler.toml` 옆(루트)으로 옮긴다 (3절) |
| 조치가 `401` | 토큰 불일치 | 화면 우상단 `잠금 해제`에 `.dev.vars` 값 그대로 입력 |
| `meta.missing`에 `_keys`·`_request_log` | marketplace 미시드 **또는** 콘솔 `--persist-to` 누락 | marketplace `npm run seed` 먼저 (0절) / [environments.md §4-③](environments.md) |
| dev 가 `:8789` 등 엉뚱한 포트로 뜸 | 8787/8788 을 이전 프로세스가 쥐고 있음 | 아래 포트 항목 — 포트는 `[dev] port` 로 고정돼 있으나 점유 시 밀린다 |
| `npm run seed`가 `&&`에서 멈춤 | npm의 script-shell이 PowerShell로 잡힘 | `npm config delete script-shell` |
| `Address already in use :8787/:8788` | 이전 dev가 살아 있음 | `Get-Process workerd \| Stop-Process -Force` (전부 정리) |
| `Catalog '...' not found` | Trino 카탈로그 이름 차이 | `SHOW CATALOGS` 로 확인 후 `$env:TRINO_CATALOG` (5절) |
| 첫 `wrangler dev`에서 방화벽 팝업 | workerd가 포트 대기 | **개인 네트워크만** 허용 |

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
