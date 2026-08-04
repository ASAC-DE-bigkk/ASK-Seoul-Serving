# marketplace 배포 런북 (통합 검증용 타겟)

> **이 문서는 승인 후 실행 절차다.** `wrangler deploy` 는 공개 URL 신설이라 팀 결정 사항
> (agreement §8)이고, 승인 없이 실행하지 않는다. 결정 상태는 ASK-Seoul-Serving#20.
>
> 대상 범위는 **팀 통합 검증용 비공개 타겟 1개**다 — 외부 공지·문서 링크 없이 올리고,
> 정식 공개는 별도 판단(#20)이다. 이유는 ASK-Seoul-Serving#4 가 V1 6개 제품 계약 검증에
> 실제 게시본을 읽는 타겟을 요구하기 때문이다.

## 0. 배포 전 검사 — **먼저 이것부터**

```bash
cd marketplace
npm run preflight -- <D1이름> [--env production]
```

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

### 실측 (2026-08-04, 읽기만)

```
prod  _keys · _usage · _issuance_log · _burst · _gateway_request_log   없음 (apply 가 만든다)
      _request_log                                                     남의 표  → 진행 가능

dev   _keys · _usage · _issuance_log · _burst                          일치
      _gateway_request_log                                             없음
      _request_log   ts,path,query,token,request_id                    🔴 오염  → 중단
```

**dev 는 중단됩니다** — `0004` 가 남의 표에 얹은 `request_id` 를 문지기가 잡습니다.
적용 뒤 확인은 §1 의 `check-request-log-schema.sql` 이 같은 기준으로 한 번 더 봅니다.

> ⚠️ **자격증명이 필요합니다.** `marketplace/.env` 에 `CLOUDFLARE_API_TOKEN`·
> `CLOUDFLARE_ACCOUNT_ID` 를 넣으십시오(`.env.example` 참고). 읽기 검사만 하면 `D1:Read`
> 로 충분합니다. 실측 시점에 자격증명이 `ops-dashboard/.env` 에만 있어 이쪽은 비어 있었습니다.

## 0-1. 전제 확인

| 항목 | 확인 방법 | 기대 |
|---|---|---|
| **배포 승인** | [`../../docs/agreement.md` §8-3](../../docs/agreement.md) | ⚠️ **승인 주체 미정** — prod D1 은 파이프라인의 DB 다. #476 ① 은 팀 투표였고 이미 통과했으므로 이 자리의 근거가 아니다 |
| **배포 전 검사** | 위 §0 `npm run preflight` | 🔴 **종료 코드 1 이면 배포 금지** |
| 대상 D1 | `wrangler.toml` `[env.production]` | `ask-seoul-prod-d1` — 파이프라인이 게시하는 prod D1. 기본 환경의 dev D1 은 로컬 전용이다 |
| Cloudflare 계정 | 팀 계정 로그인 | `npx wrangler whoami` — **publisher 와 같은 계정**이어야 바인딩이 같은 DB 로 풀린다(개인 계정 배포 금지) |
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

게이트웨이가 쓰는 `_keys`·`_usage`·`_burst`·`_issuance_log`·`_gateway_request_log` 는 지금까지
`--local` 로만 적용해서 **prod D1 에는 없다.** 이걸 안 하면 배포해도 키 발급·인증이 전부 죽는다.

> ⚠️ **팀(원격) D1 쓰기다.** 스키마 생성만 하고 기존 표(`_catalog`·제품 테이블)는 건드리지
> 않지만, 실행 전에 팀에 알린다. 이 명령은 **직접 실행한다** — 에이전트가 대신 돌리지 않는다.

### 🔴 0단계 — 장부 백필이 **먼저다** (건너뛰면 남의 표가 오염된다)

```bash
cd marketplace
npx wrangler d1 execute ask-seoul-prod-d1 --remote --env production \
  --file=scripts/backfill-migrations-ledger.sql
```

**두 D1 모두 `d1_migrations` 장부가 없다**(2026-08-04 실측, 읽기만). 장부가 없으면 apply 는
`0001` 부터 전부 재실행하고, 그중 `0004` 는 조건을 달 수 없는
`ALTER TABLE _request_log ADD COLUMN request_id` 다 — 그 이름의 표는 **남의 것**이라
(transit 워커, agreement §2) **남의 표에 우리 컬럼이 붙는다.** dev D1 에서 이미 일어난 사고이고,
백필은 이름이 아니라 `route` 컬럼 유무로 우리 표인지를 가려 그 재연을 막는다(PR #50).

### 1단계 — 적용

```bash
npx wrangler d1 migrations apply ask-seoul-prod-d1 --remote --env production
```

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

기대: `cols` 가 prod 4 · dev 5 그대로.

## 2. 시크릿 넣기 (최초 1회)

`ISSUANCE_SALT` 가 없으면 **발급이 503 으로 닫힌다**(무염 해시 방지 — 의도된 fail-closed).

```bash
cd marketplace
openssl rand -hex 32          # 값 생성 — 출력은 어디에도 남기지 말 것
npx wrangler secret put ISSUANCE_SALT --env production   # 프롬프트에 위 값을 붙여넣는다
```

## 3. 배포

```bash
cd marketplace
npx wrangler deploy --env production
```

`--env production` 이 prod D1(`ask-seoul-prod-d1`) 바인딩을 선택한다 — 플래그 없이 돌리면
기본 환경(dev D1)이 배포되므로 **반드시 플래그를 붙인다.**

출력에 나오는 `https://<name>.<subdomain>.workers.dev` 가 타겟 주소다.
**이 주소는 한 번 정해지면 사실상 못 바꾼다**(소비자가 붙으면 변경 = 파손) — #476 ② 결정과
어긋나지 않는지 배포 전에 다시 확인한다.

## 4. 스모크 (배포 직후 필수)

코드가 맞는지가 아니라 **배포본이 서비스 가능한지**를 본다.

```bash
cd marketplace
npm run smoke -- https://<배포주소>
```

10항목 중 무인증 9개가 자동으로 돈다. 인증 경로까지 보려면 키를 하나 발급해서:

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

## 5. 되돌리기

```bash
npx wrangler deployments list --env production   # 이전 배포 확인
npx wrangler rollback --env production --message "<사유>"   # 직전 배포로
```

데이터는 롤백되지 않는다 — 1번에서 만든 표는 그대로 남는다(비어 있어도 무해하다).

**완전히 내리려면** Cloudflare 대시보드에서 Worker 를 삭제한다. 그러면 그 URL 은
다시 쓰지 않는 게 좋다(캐시·북마크가 남는다).

## 6. 배포 후 알아둘 것

- **운영 콘솔은 이 배포에 포함되지 않는다.** ops-dashboard 는 로컬 전용이라
  (decision/0002) 배포된 게이트웨이의 요청 로그·키를 화면으로 볼 수 없다. 조회가 필요하면
  `wrangler d1 execute --remote` 로 직접 질의한다. 콘솔 공개는 #20 결정 B.
- **키·이메일이 prod D1 에 쌓인다.** 파이프라인 게시본과 같은 DB 다 — 운영 표(`_keys` 등)는
  게이트웨이 스키마 정본(0001 §스키마)이지만, 이 D1 을 리셋하면 발급된 키가 같이 사라진다.
- **요청 로그는 30일 후 자동 삭제**된다(로그 100건당 약 2회 sweep). 발급 IP 해시는 24시간.
