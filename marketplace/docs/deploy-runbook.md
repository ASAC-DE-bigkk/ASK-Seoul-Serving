# marketplace 배포 런북 (통합 검증용 타겟)

> **이 문서는 승인 후 실행 절차다.** `wrangler deploy` 는 공개 URL 신설이라 멘토 게이트
> (ASAC-DAG#476 ①)이고, 승인 없이 실행하지 않는다. 결정 상태는 ASK-Seoul-Serving#20.
>
> 대상 범위는 **팀 통합 검증용 비공개 타겟 1개**다 — 외부 공지·문서 링크 없이 올리고,
> 정식 공개는 별도 판단(#20)이다. 이유는 ASK-Seoul-Serving#4 가 V1 6개 제품 계약 검증에
> 실제 게시본을 읽는 타겟을 요구하기 때문이다.

## 0. 전제 확인

| 항목 | 확인 방법 | 기대 |
|---|---|---|
| 멘토 승인 | #476 ① 코멘트 | 있음 |
| 대상 D1 | `wrangler.toml` `[env.production]` | `ask-seoul-prod-d1` — 파이프라인이 게시하는 prod D1(ASAC-DAG#668, 8/3 신설). 기본 환경의 dev D1 은 로컬 전용이다 |
| Cloudflare 계정 | 팀 계정 로그인 | `npx wrangler whoami` — **publisher 와 같은 계정**이어야 바인딩이 같은 DB 로 풀린다(개인 계정 배포 금지) |
| 코드 | 머지된 `dev` | 로컬 `npm test` · `npm run verify:log` 통과 |
| **요청 로그 표** | 아래 검사 | ⚠️ **`STOP` 이면 배포 금지** |

### 요청 로그 표는 `_gw_request_log` 다 — 이름 충돌을 비켜섰다

같은 D1 에 `_request_log` 라는 이름의 **다른 표**가 있다. **우리가 팀 계정에 배포한 워커 두 개**
(`ask-seoul-citydata-api`·`ask-seoul-transit-api`)가 `INSERT INTO _request_log (ts, path, query)`
로 쓴다. 실제 표는 `(ts, path, query, token)` 4컬럼이고 **2026-07-21** 부터 쌓였다 —
게이트웨이(7/28)보다 먼저다.

**나중에 고른 우리가 비켰다.** 게이트웨이는 `_gw_request_log` 를 쓴다
(`migrations/0005_rename_request_log.sql`). 옛 표는 **건드리지 않는다** — 그 워커들은 지금도
배포돼 있고 소스가 레포에 없어서, 지우면 살아 있는 배포본이 깨진다.

```bash
# 로컬은 --file 로 되지만, **원격은 --command 를 쓴다** — `--file` 은 원격에서 결과 대신
# DB 통계를 돌려줘 verdict 가 안 보인다(실측).
npx wrangler d1 execute <PROD_D1> --remote --env production --command \
"SELECT CASE
   WHEN (SELECT COUNT(*) FROM pragma_table_info('_gw_request_log')
         WHERE name IN ('route','table_name','status','key_hash','filters','row_count','ms')) = 7
     THEN 'OK'
   WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_gw_request_log')
     THEN 'STOP: _gw_request_log 없음 — 0005 적용 필요'
   ELSE 'STOP: 스키마 불일치' END AS verdict,
 CASE
   WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
     THEN '없음'
   WHEN (SELECT COUNT(*) FROM pragma_table_info('_request_log') WHERE name='route')=0
     THEN '남의 표 — 건드리지 않는다'
   ELSE '우리 옛 표' END AS legacy"
```

실측(2026-08-04) 운영 D1 — 마이그레이션 적용 **전** 상태:

```
verdict : STOP: _gw_request_log 없음 — 0005 적용 필요
legacy  : 남의 표 — 건드리지 않는다     ← 워커 것. 그대로 둔다
```

1번(마이그레이션)을 돌리면 `_gw_request_log` 가 새로 생기고 `verdict` 가 `OK` 가 된다.
`legacy` 는 계속 '남의 표'로 남아야 정상이다 — 우리가 손대는 대상이 아니다.

> **옛 표(`_request_log`)에 대해 알아 둘 것** — 우리 워커 두 개가 쓰던 접근 로그다.
> 마지막 쓰기는 2026-08-03 이고 지금은 멈춰 있다. `token` 컬럼은 401건 중 1건만 채워져
> 있는데 **워커 소스에는 `token` 을 넣는 코드가 없다**(3컬럼만 INSERT) — 표를 처음 만든
> 더 앞선 세대의 잔재로 보인다. 그 1건의 값은 열지 않았다. 워커 정리(은퇴/재배포)는
> 이 런북 범위 밖이고, **배포에는 영향이 없다** — 우리는 이름을 비켰다.

**로컬에서 먼저 통과시킨다** — 배포본이 아니라 코드가 맞는지는 여기서 본다.

```bash
cd marketplace
npm test          # classifyClient 계약
npm run verify:log  # 요청 로그 유실 검증(C-10)
```

## 1. 팀 D1 에 운영 테이블 만들기 (최초 1회)

게이트웨이가 쓰는 `_keys`·`_usage`·`_burst`·`_issuance_log`·`_gw_request_log` 는 지금까지
`--local` 로만 적용해서 **prod D1 에는 없다.** 이걸 안 하면 배포해도 키 발급·인증이 전부 죽는다.

> ⚠️ **팀(원격) D1 쓰기다.** 스키마 생성만 하고 기존 표(`_catalog`·제품 테이블)는 건드리지
> 않지만, 실행 전에 팀에 알린다. 이 명령은 **직접 실행한다** — 에이전트가 대신 돌리지 않는다.

```bash
cd marketplace
npx wrangler d1 migrations apply ask-seoul-prod-d1 --remote --env production
```

파일을 나열하지 않는다 — 적용 여부는 D1 안의 장부(`d1_migrations`)가 추적하고, 안 된
파일만 실행된다. 그래서 여러 번 돌려도 안전하고("이미 적용된 ALTER 실패는 정상" 같은
예외 규칙이 필요 없다), **나중에 0005 가 생기면 같은 명령 한 번이 그것만 마저 적용한다.**
prod D1 은 8/3 신설이라 장부가 처음부터 추적기와 함께 시작한다 — 로컬처럼 백필이 필요 없다.

확인:

```bash
npx wrangler d1 execute ask-seoul-prod-d1 --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\_%' ESCAPE '\'"
```

`_keys`·`_usage`·`_burst`·`_issuance_log`·`_gw_request_log`·`_catalog` 가 보이면 된다.

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
curl -s -X POST https://<배포주소>/api/keys -H 'content-type: application/json' \
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
