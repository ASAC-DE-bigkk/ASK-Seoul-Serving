# 환경 규약 — 설정을 어디에 두고, 무엇이 환경마다 달라지나

> **이 문서는 API 담당자와 대시보드 담당자가 함께 관리한다.**
> 실제 실행 절차(OS별 설치·명령)는 [setup.md](setup.md), 여기는 **구조와 배분**이다.

## 0. 먼저 — 두 프로젝트는 지금 **다른 규약**을 쓴다

예전에는 "두 프로젝트가 같은 구조"였다. **2026-08-05 로 갈라졌다** — 팀이 dev D1 을 폐기하고
전체 작업·검증·배포를 운영 D1 기준으로 하기로 했는데, **콘솔만 전환됐다.**

| | 로컬이 보는 D1 | 로컬에서 쓰기 | 배포 |
|---|---|---|---|
| **게이트웨이** `marketplace/` | 로컬 Miniflare (dev D1 바인딩) | 로컬 사본에만 | `ask-seoul.kr` · `dev.` |
| 🔴 **콘솔** `ops-dashboard/` | **운영** `ask-seoul-prod-d1` | **운영에 그대로 간다** | `ops.ask-seoul.kr` |

게이트웨이 전환은 **그쪽 담당자 몫**이라 손대지 않았다(**#85**).
콘솔 쪽 정본은 [decision/0015](../ops-dashboard/docs/decision/0015-single-production-d1.md).

**그래서 이 문서는 프로젝트별로 나눠 적는다.** 읽기 전에 어느 쪽 이야기인지 먼저 본다.

| 절 | 다루는 것 |
|---|---|
| [1. 공통](#1-공통--두-프로젝트가-같이-지키는-것) | 설정 배치 · 시크릿 파일 · env 상속 · 마이그레이션 장부 |
| [2. 게이트웨이](#2-게이트웨이--marketplace) | 환경 2종(local·prod) · 명령 · D1 접속 |
| [3. 🔴 콘솔](#3--콘솔--ops-dashboard) | **환경 1종(운영뿐)** · 명령 · 원격 바인딩 함정 |
| [4. 도메인](#4-도메인--공통) | 호스트 3종 · 라우트 상태 |
| [5. 열려 있는 것](#5-아직-열려-있는-것) | 프로젝트별로 나눠 적는다 |

---

# 1. 공통 — 두 프로젝트가 같이 지키는 것

## 1-1. 설정은 `wrangler.toml` 한 파일

**환경마다 달라지는 값은 각 프로젝트 `wrangler.toml` 안에 있다.** 명령은 배포할 때만
`--env production` 을 명시한다.

```toml
# <프로젝트>/wrangler.toml
name = "..."                  # ← 여기부터 기본 환경
[dev]                         #    포트 고정 (게이트웨이 :8787 · 콘솔 :8788)
[assets]
[[d1_databases]]              #    ⚠️ 여기서 두 프로젝트가 갈린다 — 2절 · 3절

[env.production]              # ← 배포 전용. --env production 을 명시해야만 선택된다
[env.production.assets]
[[env.production.d1_databases]]
```

환경별 파일 분리(`config/local`·`config/prod` + `-c`)안도 검토했지만, 그쪽은 모든 wrangler
호출에 `-c` 를 **사람이 매번** 붙여야 해서 누락이 곧 버그가 된다 — 검증 스크립트 3곳이
실제로 깨졌다. 전말은 [ops-dashboard decision/0011](../ops-dashboard/docs/decision/0011-per-env-config.md).

## 1-2. 시크릿 파일 두 개 — 역할은 다르고 규칙은 같다

| 파일 | 누가 읽나 | 무엇 |
|---|---|---|
| `.dev.vars` | **Worker 안** | `env.OPS_TOKEN`·`env.ISSUANCE_SALT` — 화면·발급 기능용 |
| `.env` | **wrangler 라는 도구** | `CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_ACCOUNT_ID` — 원격 D1 접속용 |

역할이 갈리는 만큼 헷갈리기 쉽지만, **규칙은 하나다 — 로컬은 파일, 배포는 파일 밖.**
wrangler 는 같은 디렉토리의 `.env` 를 자동으로 읽는다(플래그 불필요).

**환경별 시크릿 파일을 만들지 않는다.** `.dev.vars.production`·`.env.production` 같은 것을
두면 *운영 시크릿이 로컬 파일에 있다*는 뜻이 되고, 그 자체가 유출 경로다. 배포용 Worker
시크릿은 Cloudflare 가 보관하고(`wrangler secret put`), 자격증명은 배포하는 사람·CI 가 가진다.

둘 다 `.gitignore` 대상이고 값이 빈 `.env.example`·`.dev.vars.example` 만 추적한다.
권한은 필요한 만큼만 준다 — 토큰이 새면 그 권한만큼이 사고 반경이다.

> ⚠️ **토큰 권한의 무게가 두 프로젝트에서 다르다.** 게이트웨이는 로컬이 사본이라 `D1:Read`
> 로 충분하지만, **콘솔은 토큰 권한이 사실상 마지막 바깥 방어선**이다 — [3-2](#3-2-자격증명--권한이-마지막-방어선이다) 참고.

## 1-3. `[env.production]` 은 상속되지 않는다 — assets·vars 를 양쪽에 적는다

env 섹션은 기본 환경을 **물려받지 않는 항목이 많다.** `[assets]`·`run_worker_first`·`[vars]` 를
기본에만 적으면 배포본에서 정적 서빙·라우팅·화면 표시가 조용히 달라진다. 그래서
`[env.production.assets]`·`[env.production.vars]` 를 **중복 명시**한다. 새 API 네임스페이스를
`run_worker_first` 에 추가할 때 **두 곳을 같이** 고친다 — 한쪽만 고치면 배포본에서만
그 경로가 정적 404 로 떨어진다.

## 1-4. `.dev.vars` 는 wrangler 설정 파일 옆에서 찾는다

지금 구조에선 설정이 프로젝트 루트라 `.dev.vars` 도 **프로젝트 루트**가 맞다.
Windows 에서 이 파일을 셸로 만들 때 인코딩을 지정하지 않으면 UTF-16LE 로 저장돼
**조용히 안 읽힌다** — 기동 로그·증상·해법은 [setup.md §3](setup.md) 실측 표 참고.

## 1-5. 마이그레이션 — 적용 여부는 장부가 추적한다

`wrangler d1 migrations apply` 는 적용된 파일을 D1 안의 장부에 기록하고 **안 된 파일만
실행**한다. 그래서:

- 새 마이그레이션은 `migrations/` 에 파일을 추가하면 끝 — 시드 체인을 손대지 않는다
  (체인 갱신을 사람이 기억하다 0004 누락으로 요청 로그가 전량 유실됐던 실사고의 재발 방지).
- 추적 전환 이전에 만든 상태는 **장부 백필**로 메운다 — 파일이 만든 객체가 실존할 때만 기록한다.

**장부 표는 프로젝트마다 분리한다** — 게이트웨이는 `d1_migrations`, 콘솔은
`d1_migrations_ops_dashboard`. 같은 D1 을 쓰면 기본 이름으로는 두 기록이 한 표에 섞이고,
파일명이 겹치는 순간 한쪽이 "이미 적용됨"으로 조용히 건너뛴다.

---

# 2. 게이트웨이 — `marketplace/`

> 이 절은 **게이트웨이 담당 영역**이다. 콘솔 이야기는 3절.

## 2-1. 환경별 실체

| | local (기본 환경) | production (`[env.production]`) |
|---|---|---|
| 호스트 | `http://localhost:8787` | 기준 도메인 `ask-seoul.kr` (+ `dev.` = `[env.dev]`) |
| D1 이름 | `ask-seoul-dev-d1` | `ask-seoul-prod-d1` |
| D1 id | `9db0e851-558e-489f-9e76-f131d25aa267` | `59a8409e-3be6-467b-8214-7938c59c8729` |
| D1 실제 접속 | **Miniflare 로컬 sqlite** | 바인딩으로 붙는다 |
| 로컬 쓰기 | 로컬 사본에만 — 팀 DB 에 영향 없음 | — |

**플래그가 없으면 언제나 로컬이다.** 이 방향이 이 구조의 핵심이다 — `--env production` 을
빠뜨린 실수는 로컬로 떨어지고(안전), prod 를 건드리려면 명시적 의도가 필요하다.

> ⚠️ 이 성질은 **게이트웨이에만 남았다.** 콘솔은 반대가 됐다(3절).

## 2-2. 사람이 치는 명령

```bash
cd marketplace
npm install
npm run seed     # 로컬 sqlite — 마이그레이션 + 픽스처
npm run dev      # :8787 — 포트는 [dev] port 가 정한다 (--port 불필요)
```

배포는 사람이 런북을 보고 직접 친다(배포 결정 — agreement §8):

```bash
npx wrangler deploy --env production
```

`--persist-to` 는 기본값(`.wrangler/state`)이라 넘길 필요가 없다.

## 2-3. 원격 D1 을 봐야 할 때 — **경로가 아직 없다**

`_burst`·`_usage`·`_gateway_request_log` 때문에 **GET 하나에도 D1 에 쓴다.** 그래서 옛
"보기 전용으로 원격에 붙는다" 방식이 애초에 성립하지 않았다.

운영 D1 로 옮길지와 계량 경로를 어떻게 할지는 **게이트웨이 담당자의 판단**이다 — **#85**.

---

# 3. 🔴 콘솔 — `ops-dashboard/`

> 이 절은 **대시보드 담당 영역**이다. 절차 정본은 [run-prod.md](run-prod.md).

## 3-1. 환경별 실체 — **환경이 하나뿐이다**

| | 기본 환경 = **운영** | production (배포) |
|---|---|---|
| 호스트 | `http://localhost:8788` | **`ops.ask-seoul.kr`** (배포 중) |
| D1 | **`ask-seoul-prod-d1`** | 같음 |
| D1 id | `59a8409e-…` (+ `preview_database_id` 동일값) | 같음 |
| D1 실제 접속 | **원격** — 바인딩의 `remote = true` | 바인딩으로 붙는다 |
| 로컬 쓰기 | ✅ **열려 있다 — 화면 조치가 실제 고객 키에 간다** | 같음 |

🔴 **"플래그가 없으면 로컬"이 여기서는 반대다.** 바인딩에 `remote = true` 가 박혀 있어
**기본값이 운영이다.** 플래그가 안전장치가 아니고, **연습할 곳이 없다**(0015 §대가).

## 3-2. 자격증명 — 권한이 마지막 방어선이다

로컬 사본이 없어 **`.env` 의 `CLOUDFLARE_API_TOKEN` 없이는 화면이 아예 안 뜬다.**

| 권한 | 할 수 있는 것 |
|---|---|
| `D1:Read` | 보기만. **조치 버튼을 눌러도 실패한다** — 실수로 지울 일이 없다 |
| `D1:Edit` | 조치까지. 실제 고객 키를 지울 수 있다 |

**평소에는 `D1:Read` 를 권한다.** 조치할 일이 생겼을 때만 올린다.

## 3-3. 사람이 치는 명령 — `seed` 가 없다

```bash
cd ops-dashboard
npm install
cp .env.example .env       # CLOUDFLARE_API_TOKEN — 없으면 아예 안 뜬다
npm run dev                # :8788 · 🔴 운영 D1
npm run migrate:list       # 스키마 적용 상태 (먼저 본다)
npm run migrate            # 장부 백필 → apply. 대상은 운영 D1
npm run d1 -- "SELECT …"   # DDL 은 거절된다
```

`npm run seed` 는 **없앴다**(0015). 합성 픽스처를 운영 D1 에 넣으면 그게 곧 오염이다.

🔴 `migrations/0002`(조회 DB 4종 미러)는 **운영에서 실행되지 않는다** — 거기엔 진짜 표가
이미 있고, 그대로 돌리면 `CREATE INDEX` 가 **남의 운영 표에** 만들어진다. 장부 백필이
"표가 이미 있으면 실행 없이 기록만" 해서 건너뛴다.

## 3-4. 🔴 원격에 붙는 방식 — **설정이지 플래그가 아니다**

콘솔이 원격에 붙는 것은 바인딩의 `remote = true` 이지 `--remote`(플래그)가 **아니다.**
플래그로 띄우면 **바인딩 이름은 맞는데 질의만 빈 결과**가 나오고, 화면은 그걸 "표가
없습니다"로 표시한다 — **연결이 틀렸는데 화면은 "운영을 보고 있다"고 답한다.**

| 시도 | 결과 |
|---|---|
| `wrangler dev --remote` (옛 플래그) | 전부 빈 결과 |
| `--remote` + `preview_database_id` | 전부 빈 결과 |
| **`remote = true` + 플래그 없는 `wrangler dev`** | **정상** |

⚠️ `experimental_remote` 는 이 버전에 **없는 필드**라 경고만 찍고 **local 로 조용히 떨어진다.**

> **예전 함정이 하나 사라졌다.** `--persist-to` 를 빠뜨려 빈 DB 를 새로 만드는 사고는
> 콘솔에 로컬 사본이 없어지면서 함께 없어졌다.
> [decision/0003](../ops-dashboard/docs/decision/0003-single-shared-local-d1.md) 의 "원본은
> 하나"라는 취지는 살아 있고, **그 하나가 운영으로 옮겨간 것**이다.

## 3-5. 화면 배지 — 이제 늘 같은 값이다

콘솔은 `[vars]` 로 `ENV_LABEL`·`ENV_D1` 을 넘겨 화면 상단에 **지금 무슨 DB 를 보고 있는지**를
띄운다. 값이 비면 "알 수 없음"이 뜬다 — 그것도 신호다.

⚠️ 콘솔은 이제 **언제나 운영**이라 이 배지가 늘 같다. 원래는 그게 경고였는데 지금은 상태
표시일 뿐이라 **눈에 익어 안 읽히기 쉽다** — 조치 버튼을 누르기 전에 한 번 더 본다.

## 3-6. 배포 — `dev` 머지가 곧 운영 배포다

```bash
npm run deploy:prod    # → ops.ask-seoul.kr
```

`dev` 브랜치 머지 시 CD 가 자동으로 같은 일을 한다(`.github/workflows/deploy-prod.yml`).
⚠️ **브랜치 이름과 배포 환경이 다르다.** `deploy:dev` 는 없앴다(0015).

CD 는 **코드만** 배포한다 — 마이그레이션은 사람이 따로 돌린다. 대신 배포 전에
`schema-ready` 가 **적용 여부를 읽기로 확인**하고, 미적용분이 있으면 배포를 막는다.

---

# 4. 도메인 — 공통

호스트 4종 중 **셋만 산다.**

| 호스트 | 무엇 | 상태 |
|---|---|---|
| `ask-seoul.kr` | 게이트웨이 운영 | 활성 |
| `dev.ask-seoul.kr` | 게이트웨이 개발 | 활성 |
| `ops.ask-seoul.kr` | **콘솔 운영** | **활성** |
| ~~`dev-ops.ask-seoul.kr`~~ | 콘솔 개발 | **폐기**(0015 — dev 환경 자체를 접었다) |

zone `ask-seoul.kr` 은 Active 다. zone 이 하나여도 Worker·배포·롤백은 따로다 — 그게 분리의
목적이다([decision/0001](../ops-dashboard/docs/decision/0001-separate-worker-from-marketplace.md)).

> 🔴 **콘솔 읽기 경로는 아직 무인증이다**(decision/0004). Cloudflare Access 를 `ops.` 로
> **한정해서** 거는 것이 선행 조건이었는데(#20 B-1) 토큰 권한 미확보로 보류다 — zone 전체나
> `*.ask-seoul.kr` 로 걸면 공개 API 까지 잠긴다.

---

# 5. 아직 열려 있는 것

## 5-1. 게이트웨이

- **운영 D1 에 게이트웨이 표 만들기** — `_keys`·`_usage`·`_burst`·`_gateway_request_log` 가
  아직 없다([deploy-runbook 1번](../marketplace/docs/deploy-runbook.md)).
  **콘솔의 네 탭이 비는 원인**이기도 하다.
- **운영 D1 전환 여부** — 계량 경로(GET 에도 쓰는 구조)를 어떻게 할지 포함. **#85**.

## 5-2. 콘솔

- 🔴 **읽기 경로가 무인증인 채 공개돼 있다** — Access 승격(#20 B-1) 보류.
  **지금 열려 있는 것 중 위험도가 가장 높다.**
- **조치 이력이 안 남는다** — 쓰기 인증이 공유 정적 토큰 하나(`OPS_TOKEN`)라 "누가 했나"에
  답할 수 없다. 0015 §대가가 미룬 숙제이고, 풀려면 decision/0004 개정이 먼저다.
- **`_ops_slo` 를 채우는 경로** — 표는 있는데 비어 있다. 정규 경로(culture DAG export)가
  아직 안 붙어서 '데이터 준비 상태' 탭은 비어 있는 것이 정상이다.

## 5-3. 공통

- **배포는 환경을 명시한 스크립트로만 한다.** 스크립트 이름이 env 를 고정하므로 "플래그를
  빼먹은 배포"가 성립하지 않고, env 없는 맨 `wrangler deploy` 는 여전히 금지다.
- **두 프로젝트가 다시 한 규약으로 합쳐지는 시점** — #85 가 정해지면 이 문서의 0절 표와
  2·3절 분리를 같이 정리한다.
