# marketplace 배포 런북 (통합 검증용 타겟)

> **이 문서는 승인 후 실행 절차다.** `wrangler deploy` 는 공개 URL 신설이라 팀 결정 사항
> (agreement §8)이고, 승인 없이 실행하지 않는다. 결정 상태는 ASK-Seoul-Serving#20.
>
> 대상 범위는 **팀 통합 검증용 비공개 타겟 1개**다 — 외부 공지·문서 링크 없이 올리고,
> 정식 공개는 별도 판단(#20)이다. 이유는 ASK-Seoul-Serving#4 가 V1 단일 제품 계약 검증에
> 실제 게시본을 읽는 타겟을 요구하기 때문이다.

## 0. 배포 전 검사 — **먼저 이것부터**

```bash
cd marketplace
npm run preflight -- <D1이름> [--env production]
```

위 기본 검사는 **마이그레이션 전 안전성**을 본다. 우리 표가 `없음`이면 apply 가 만들 수 있으므로
통과한다. route 배포 직전에는 아래 배포 모드로, 필수 Gateway 표가 실제로 존재하는지까지 본다:

```bash
npm run preflight -- ask-seoul-prod-d1 --env dev --require-applied
```

`--require-applied` 에서는 우리 표의 `없음`도 중단이며 `--ack` 로 우회할 수 없다.

**표가 있는지만이 아니라 모양(컬럼)까지 봅니다.** 이름은 같은데 컬럼이 다른 표가 실제로
있었고(`_request_log`), 그걸 못 잡으면 `CREATE TABLE IF NOT EXISTS` 가 조용히 넘어가
**요청 로그가 전량 버려집니다**. 조건 없는 `ALTER` 가 있으면 **남의 표에 컬럼이 얹힙니다** —
dev D1 에서 실제로 일어난 일입니다(`0004` 가 남의 표에 `request_id` 를 붙였다).

| 판정 | 뜻 | 배포 |
|---|---|---|
| `없음` | 표가 없다 — apply 가 만든다 | ✅ 진행 |
| `일치` | 있고 모양이 같다 | ✅ 진행 |
| `일치+` | 컬럼이 더 있다 — 증분 규약상 추가는 허용 | ✅ 진행 |
| **`모양 다름`** | 있는데 컬럼이 다르다 | 🔴 **중단** |
| `남의 표` | 우리 소유가 아니다 — 다른 게 정상 | ⚠️ 감시만 |
| **`오염`** | **남의 표에 우리 컬럼이 얹혀 있다** | 🔴 **중단** |
| **`인수됨`** | 남의 표가 통째로 우리 모양이 됐다 | 🔴 **중단** |

종료 코드 `0` 진행 가능 · `1` **중단** · `2` 검사 실패(자격증명·네트워크).

**기대 모양은 `migrations/*.sql` 에서 나옵니다** — 인메모리 sqlite 에 실제로 적용해 뽑으므로
하드코딩 드리프트가 없습니다. 원격·로컬 D1 을 전혀 건드리지 않습니다.

`오염` 판정은 남의 표마다 **기준 모양(`baseline`)** 을 함께 두고
`우리 컬럼 ∩ 실제 − baseline` 으로 봅니다(#55). `ts` 는 우리 스키마에도 남의 표에도 있어서
단순 교집합으로는 멀쩡한 prod 까지 잡힙니다 — baseline 이 있어야 `request_id` 만 골라냅니다.
**남의 표가 자기 컬럼을 늘린 건 막지 않습니다** — 그건 그쪽 사정입니다.

### 🔴 중단됐을 때

**되돌리는 것보다 멈추는 게 쌉니다.** prod D1 은 62개 제품이 사는 파이프라인의 DB 이고,
**D1 Time Travel 은 테이블 단위가 아니라 DB 전체를 덮어씁니다** — 제품 publish 하나를
되돌리면 발급된 키·쿼터·요청 로그가 같이 과거로 갑니다(ASAC-DAG#476).

1. 그 표가 누구 것인지 확인합니다 — [`../../docs/agreement.md` §5 소유 경계](../../docs/agreement.md)
2. **이름을 비킬지 / 스키마를 맞출지 사람이 정합니다** (#52 에 적습니다)
3. 정하고 나서 사유를 달아 다시 돌립니다:

```bash
npm run preflight -- <D1이름> --env production --ack "#52 합의: <결정과 근거>"
```

`--ack` 는 **판정을 바꾸지 않습니다.** 판정을 그대로 출력하고, 사유를 함께 찍고,
종료 코드만 0 으로 바꿉니다 — 기록이 남아야 다음 사람이 "왜 통과시켰나"를 압니다.

> `오염` 은 *"이대로 가면 생길 일"* 이 아니라 **이미 일어난 일**입니다. 재발은 장부 백필이
> 막고 있고(PR #50), `DROP COLUMN` 은 쓰는 쪽 합의가 먼저입니다 — **그대로 두는 것도
> 선택지**입니다(NULL 만 든 컬럼이라 남의 표 동작에는 영향이 없습니다).

### 실측 (2026-08-05)

```
prod  _keys · _usage · _issuance_log · _burst · _gateway_request_log   없음 (apply 가 만든다)
      _request_log                                                     남의 표  → 진행 가능

dev   _keys · _usage · _issuance_log · _burst                          일치
      _gateway_request_log                                             없음
      _request_log   ts,path,query,token                               남의 표  → 진행 가능
```

`request_id` 오염은 작성자가 제거해 dev 도 기본 preflight exit 0 이다(#52). 다만
`_gateway_request_log` 가 아직 없으므로 `--require-applied` 배포 검사는 migrations apply 전까지
중단한다. 적용 뒤 확인은 §1 의 `check-request-log-schema.sql` 이 같은 기준으로 한 번 더 봅니다.

> ⚠️ **자격증명이 필요합니다.** `marketplace/.env` 에 `CLOUDFLARE_API_TOKEN`·
> `CLOUDFLARE_ACCOUNT_ID` 를 넣으십시오(`.env.example` 참고). 읽기 검사만 하면 `D1:Read`
> 로 충분합니다. 실측 시점에 자격증명이 `ops-dashboard/.env` 에만 있어 이쪽은 비어 있었습니다.

## 0-1. 전제 확인

배포는 **환경을 반드시 지정한다** — 언제나 `--env production`.
env 없이 실행하면 라우트 없는 워커가 하나 더 생긴다. 배포면은 하나이고 `wrangler.toml` 이 정본이다:

| 환경 | 워커 | 주소 | D1 |
|---|---|---|---|
| `production` | `ask-seoul-gateway` | `https://ask-seoul.kr` | `ask-seoul-prod-d1` |

> **dev 배포면 폐지(2026-08-06, 팀 합의).** `dev.ask-seoul.kr`·`[env.dev]`·`deploy:dev`·
> 워커를 함께 지웠다. D1 이 운영 하나뿐이 된 뒤(decision/0015) dev 배포면은 같은 데이터를
> 다른 주소로 한 번 더 보여주는 것뿐이라 두 벌 유지 비용이 컸다. 브랜치도 그에 맞췄다 —
> `dev` 는 통합, `main` 이 배포다.

| 항목 | 확인 방법 | 기대 |
|---|---|---|
| **배포 승인** | [`../../docs/agreement.md` §8-3](../../docs/agreement.md) | prod D1 은 파이프라인의 DB 다 — 스키마를 새로 만들 때는 조율이 먼저다(표는 2026-08-06 생성 완료) |
| **배포 전 검사** | 위 §0 `npm run preflight` | 🔴 **종료 코드 1 이면 배포 금지** |
| 대상 D1 | `wrangler.toml` 해당 env 의 `d1_databases` | **세 환경 전부 운영 D1** — 갈리는 것은 `ASK_ENV` 값과 주소뿐이다(#85) |
| Cloudflare 계정 | 팀 계정 로그인 | `npx wrangler whoami` — **publisher 와 같은 계정**이어야 바인딩이 같은 DB 로 풀린다(개인 계정 배포 금지) |
| 도메인 | zone `ask-seoul.kr` 이 Active | 해당 env 의 `routes` 가 이 zone 을 가리킨다 (2026-08-04 확인) |
| 코드 | 머지된 `dev` | 로컬 `npm test` · `npm run verify:log` 통과 |

### ~~`_request_log` 이름 충돌 검사~~ — 위 `npm run preflight` 로 **대체됨**

> 아래는 개명(#53) 이전의 절차다. **지우지 않고 기록으로 남긴다** — 왜 이 검사가 있었는지가
> 개명의 근거이고, 지우면 같은 논의가 다시 열린다(`agreement.md` 갱신 규칙과 같은 취지).
>
> `migrations/0002_request_log.sql` 이 `CREATE TABLE IF NOT EXISTS` 라 **다른 주체가 같은
> 이름을 선점하면 조용히 넘어가고**, 그 상태로 배포하면 게이트웨이 INSERT 가 `ctx.waitUntil`
> 안에서 실패해 요청 로그가 전량 버려진다(#23 에서 겪은 형태). 실측(2026-08-04)에서 운영·개발
> 양쪽에 `(ts, path, query, token)` 4컬럼 표가 있었고, **transit 워커 소유**로 확인돼
> 게이트웨이가 `_gateway_request_log` 로 비켰다(#44 §2 · #53).

**로컬에서 먼저 통과시킨다** — 배포본이 아니라 코드가 맞는지는 여기서 본다.

```bash
cd marketplace
npm test            # 계약 테스트
npm run verify:log  # 요청 로그 유실 검증(C-10)
```

## 1. 팀 D1 에 운영 테이블 만들기 (최초 1회)

게이트웨이가 쓰는 `_keys`·`_usage`·`_burst`·`_issuance_log`·`_gateway_request_log` 는
**원격 D1 에 환경마다 최초 1회 만들어야 한다.** 안 하면 배포해도 키 발급·인증이 전부 죽는다.
✅ **2026-08-06 완료** — 운영 D1 에 `_keys`·`_usage`·`_burst`·`_issuance_log`·
`_gateway_request_log` 5종이 실측 확인됐다. dev D1 은 폐기됐으므로 만들 대상이 아니다.

> ⚠️ **팀(원격) D1 쓰기다.** 스키마 생성만 하고 기존 표(`_catalog`·제품 테이블)는 건드리지
> 않지만, 실행 전에 팀에 알린다. 이 명령은 **직접 실행한다** — 에이전트가 대신 돌리지
> 않는다(`0004` 오염이 정확히 에이전트 대리 실행에서 나온 사고다).

### 🔴 0단계 — 장부 백필이 **먼저다** (건너뛰면 남의 표가 오염된다)

```bash
cd marketplace
npm run migrate:backfill
```

**대상은 운영 D1 하나뿐이다** — dev D1 은 폐기됐다(#85 · decision/0015). 예전 이 자리에
`ask-seoul-dev-d1` 줄이 같이 있었는데, 그대로 치면 폐기한 DB 를 다시 만들어 만진다.

장부가 없으면 apply 는 `0001` 부터 전부 재실행하고, 그중 `0004` 는 조건을 달 수 없는
`ALTER TABLE _request_log ADD COLUMN request_id` 다 — 그 이름의 표는 **남의 것**이라
(transit 워커, agreement §2) **남의 표에 우리 컬럼이 붙는다.** dev D1 에서 이미 일어난 사고이고,
백필은 이름이 아니라 `route` 컬럼 유무로 우리 표인지를 가려 그 재연을 막는다(PR #50).

### 1단계 — 적용

```bash
npm run migrate:apply
```

🔴 **0단계와 한 명령으로 묶지 않는다.** 예전엔 `npm run migrate` 하나가 `백필 && apply` 였는데,
apply 프롬프트에서 취소하니 **백필까지 안 남아 장부가 0행이 됐다**(2026-08-06 실측). 그 상태로
적용했으면 `0004` 가 transit `_request_log` 389행에 컬럼을 붙일 뻔했다. 두 단계로 나눠 치고,
**0단계 뒤에 `npm run migrate:list` 로 장부가 찼는지 확인한 다음** 1단계로 간다.

파일을 나열하지 않는다 — 적용 여부는 D1 안의 장부가 추적하고, **안 된 파일만** 실행된다.
그래서 여러 번 돌려도 안전하다("이미 적용된 ALTER 실패는 정상" 같은 예외 규칙이 필요 없다).

확인:

```bash
npx wrangler d1 execute ask-seoul-prod-d1 --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\_%' ESCAPE '\'"
```

`_keys`·`_usage`·`_burst`·`_issuance_log`·`_gateway_request_log`·`_catalog` 가 보이면 된다.

그리고 **남의 표를 안 건드렸는지** 같이 본다 — 행 수만 보면 못 잡는다(ALTER 로 컬럼이
붙는 사고는 행 수가 그대로다):

```bash
npx wrangler d1 execute ask-seoul-prod-d1 --remote --env production \
  --file=scripts/check-request-log-schema.sql
```

기대: `cols` 가 prod·dev 모두 4 그대로.

## 2. 시크릿 넣기 (최초 1회)

`ISSUANCE_SALT` 가 없으면 **발급이 503 으로 닫힌다**(무염 해시 방지 — 의도된 fail-closed).

시크릿은 워커별이다 — 환경마다 따로 넣고, 값도 환경마다 다르게 생성한다.
(2026-08-04 에 dev 에 설정했지만 **구 워커에 들어갔다** — §0-1 개명 후 첫 배포 때
새 워커에 다시 넣어야 한다.)

```bash
cd marketplace
openssl rand -hex 32 | npx wrangler secret put ISSUANCE_SALT --env dev
openssl rand -hex 32 | npx wrangler secret put ISSUANCE_SALT --env production
# 파이프로 바로 넣는다 — 값이 화면·히스토리에 남지 않는다
```

## 3. 배포

```bash
cd marketplace
npm run deploy:prod   # test·preflight 통과 후 wrangler deploy --env production
```

**운영은 자동 배포된다** — **`main`** 브랜치에 머지되면 GitHub Actions
(`.github/workflows/deploy-prod.yml`)가 테스트 후 게이트웨이·콘솔을 `--env production` 으로
배포한다. `dev` 머지는 배포하지 않는다(통합 브랜치).
자동화는 원격 D1 마이그레이션을 실행하지 않고 `--require-applied` 읽기 검사만 한다. 필수
Gateway 표가 없으면 Gateway·콘솔 두 배포 모두 시작하지 않는다. 원격 D1 마이그레이션(§1)은
여전히 사람이 직접 실행한다.

env 플래그 없는 맨 `wrangler deploy` 는 금지다 — 기본 환경은 로컬 전용이고(wrangler.toml
[vars] 주석), 라우트 없는 워커가 하나 더 생긴다. 각 환경의 `routes`(`custom_domain = true`)가
DNS·TLS 를 자동 생성하고, `workers_dev = false` 라 workers.dev 주소는 만들지 않는다.
**주소는 한 번 정해지면 사실상 못 바꾼다**(소비자가 붙으면 변경 = 파손) — #476 ② 결정과
어긋나지 않는지 배포 전에 다시 확인한다.

🔴 **커스텀 도메인이 409 로 실패하면 DNS 레코드 충돌이다.** 에러는
`code 100117: Hostname 'ask-seoul.kr' already has externally managed DNS records`.
같은 호스트에 손으로 만든 A/CNAME 레코드가 있으면 워커 커스텀 도메인을 붙이지 못한다 —
**대시보드 DNS 에서 그 레코드를 지우고 다시 배포**한다(wrangler OAuth 에는 DNS 편집
스코프가 없어 CLI 로는 못 지운다). 2026-08-06 `ask-seoul.kr` 루트가 이 상태였다.

dev D1 오염은 2026-08-05 제거됐다(#52). 이제 배포 전에는 ack 가 아니라 마이그레이션 완료를
증명한다:

```bash
npm test
npm run preflight -- ask-seoul-prod-d1 --env dev --require-applied
npx wrangler deploy --env dev
```

## 4. 스모크 (배포 직후 필수)

코드가 맞는지가 아니라 **배포본이 서비스 가능한지**를 본다.

```bash
cd marketplace
npm run smoke -- https://<배포주소>
```

13항목 중 무인증 12개가 자동으로 돈다(MCP initialize·tools/list 포함 — PlayMCP·claude.ai
등록 관문). 인증 경로까지 보려면 키를 하나 발급해서:

```bash
curl -s -X POST https://<배포주소>/api/v1/keys -H 'content-type: application/json' \
  -d '{"email":"<본인 주소>"}'          # 응답의 key 는 이때 한 번만 보인다
SMOKE_KEY=ask_… npm run smoke -- https://<배포주소>
```

**전부 PASS 여야 한다.** 주요 실패 신호:

| 실패 항목 | 원인 | 조치 |
|---|---|---|
| `발급 경로 활성` 이 503 | `ISSUANCE_SALT` 미설정 | 2번 다시 |
| `catalog` 가 0종 | D1 바인딩이 다른 DB / `external=1` 제품 없음 | `wrangler.toml` 확인 |
| `data 401` 이 500 | `_keys` 테이블 없음 | 1번 다시 |
| `X-Request-Id` 누락 | 구 버전 배포본 | 코드 SHA 확인 후 재배포 |

### 🔴 이 스모크가 **보지 않는 것** — `/skill/v1`

실측(2026-08-05): `scripts/smoke.mjs` 에 **skill·bundle 검사가 0건**이고, 정적 확인도
`/legal`·`/llms.txt`·`/openapi.json` 셋뿐이라 **`/skill-openapi.json` 이 빠져 있다.**

```
확인되는 것    카탈로그·미리보기·발급 경로·데이터 401·없는 제품 404·
              MCP initialize/tools-list·X-Request-Id·정적 3종
확인 안 되는 것 K-Skill 계약 — bundle 단일 제품(weather_place_risk_window) 상세·데이터 ·
              범위 밖 제품 404 · publication/evidence parity
```

**PASS 를 계약 검증으로 읽지 않는다.** 이 스모크가 답하는 질문은 *"배포본이 서비스
가능한가"* 까지이고, *"K-Skill 이 쓸 수 있는 상태인가"* 는 #4 담당이 따로 돌리는
authenticated remote smoke 의 몫이다. 두 검사는 겹치지 않고 **보완 관계**이므로 둘 다 돌린다.

> 이 경계를 적어 두는 이유: 13항목이 전부 초록이면 "다 됐다"로 읽는 게 자연스럽고,
> 실제로 그렇게 오독한 적이 있다(#4 에서 "말씀하신 4가지가 여기 들어 있다"고 답했다가
> 세어 보니 하나도 없어 정정). dev 자동 배포(#79)로 CI 에서 돌게 되면서 초록불의 뜻이
> 더 중요해졌다.
>
> `/skill/v1` 검사를 이 스모크에 넣을지는 **계약 소유자 판단**이다 — 그쪽 remote smoke 와
> 같은 것을 두 곳에서 재게 되므로, 넣는다면 역할을 먼저 가른다.

## 5. 되돌리기

```bash
npx wrangler deployments list --env dev                # 이전 배포 확인
npx wrangler rollback --env dev --message "<사유>"      # 직전 배포로 (운영은 --env production)
```

데이터는 롤백되지 않는다 — 1번에서 만든 표는 그대로 남는다(비어 있어도 무해하다).

**완전히 내리려면** Cloudflare 대시보드에서 Worker 를 삭제한다. 그러면 그 URL 은
다시 쓰지 않는 게 좋다(캐시·북마크가 남는다).

## 6. 도메인·환경 구조 (2026-08-04 적용 — 기록)

도메인 `ask-seoul.kr` 은 팀 계정 zone 으로 등록·활성화됐다(네임서버
rita/sam.ns.cloudflare.com, 공개 DNS 반영 확인). 주소 체계는 4종으로 고정:
`ask-seoul.kr`(서비스 운영) · `dev.`(서비스 개발) · `ops.`(콘솔 운영) ·
`dev-ops.`(콘솔 개발). 이 절은 무엇이 왜 그렇게 돼 있는지의 기록이다.

- **환경은 `wrangler.toml` 의 `[env.dev]`·`[env.production]` 으로 분리한다** —
  워커·주소·D1·`ASK_ENV` 를 환경마다 따로 갖는다(§0-1 표). 호스트를 코드·설정에 한 벌만
  박아 두면 운영 배포 때 전부 다시 손대야 하기 때문이다. 바인딩·vars 는 env 에 상속되지
  않으므로 환경마다 재선언돼 있다.
- `custom_domain = true` 는 DNS 레코드·TLS 인증서를 Cloudflare 가 자동 생성한다 —
  DNS 를 손으로 만들지 않는다.
- `workers_dev = false` (전 환경). 첫 배포 전에 정했으므로 workers.dev 주소는
  아예 없다. 진입점이 둘이면 소비자가 붙은 뒤 하나를 못 끈다(#476 ② — URL 변경 = 파손).
- **정적 산출물은 상대 경로를 유지한다** — `openapi.json` 의 `servers`(`"/"`),
  `sitemap.xml` 의 `<loc>`, `robots.txt` 의 `Sitemap:`. 같은 파일이 dev·production
  양쪽에 배포되므로 환경별 절대 URL 을 박으면 다른 환경이 오염된다. sitemap 스펙은
  절대 URL 을 요구하므로, 정식 공개로 색인이 실제로 중요해지면 이 두 파일을 워커
  런타임 생성(요청 origin 기준)으로 전환한다.
- 서브도메인 `dev.` 는 개발 환경 표식이다. `api.ask-seoul.kr` 같은 기능 분리는
  하지 않았다 — 사이트와 API 가 한 워커라 호스트 하나면 충분하다.
- 내부용 3종(dev·dev-ops·ops)의 Cloudflare Access 적용은 팀 결정(agreement §8-2 B)이나
  **보류 중** — API 토큰의 Access 편집 권한을 확보하지 못했다(콘솔 decision/0002 참조).

## 7. 배포 후 알아둘 것

- **운영 콘솔은 별도 워커로 따로 배포된다** — `ops.ask-seoul.kr`
  (`../ops-dashboard` 에서 `npm run deploy:prod`). 같은 D1 을 읽으므로 게이트웨이와
  D1 이 어긋나면 남의 데이터를 보게 된다. `main` CD 는 둘을 같은 실행에서 배포한다.
- **키·이메일이 팀 D1 에 쌓인다.** 통합 검증 단계라 팀원 테스트 키뿐이지만, 누군가 그 D1 을
  리셋하면 발급된 키가 같이 사라진다. 정식 공개 전에 prod D1 로 옮기면서 해소한다(#20 결정 A).
  production 은 파이프라인 게시본과 같은 DB 라 리셋 반경이 더 크다(agreement §8-3).
- **요청 로그는 30일 후 자동 삭제**된다(로그 100건당 약 2회 sweep). 발급 IP 해시는 24시간.
