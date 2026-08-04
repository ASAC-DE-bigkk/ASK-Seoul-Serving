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
| **`_request_log` 이름 충돌** | 아래 검사 | ⚠️ **`STOP` 이면 배포 금지** |

### 🔴 `_request_log` 이름 충돌 검사 (배포 전 필수)

`migrations/0002_request_log.sql` 은 `CREATE TABLE IF NOT EXISTS` 라 **다른 주체가 같은 이름을
선점하고 있으면 조용히 넘어간다.** 그 상태로 배포하면 게이트웨이가 없는 컬럼에 INSERT 하다
실패하는데, `ctx.waitUntil` 안이라 **요청 로그가 전량 버려진다**(#23 에서 겪은 형태).

```bash
# 로컬은 --file 로 되지만, **원격은 --command 를 쓴다** — `--file` 은 원격에서 결과 대신
# DB 통계를 돌려줘 verdict 가 안 보인다(실측).
npx wrangler d1 execute <PROD_D1> --remote --env production --command \
"SELECT CASE
   WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='_request_log')
     THEN 'OK: 표가 없다'
   WHEN (SELECT COUNT(*) FROM pragma_table_info('_request_log')
         WHERE name IN ('route','table_name','status','key_hash','filters','row_count','ms')) = 7
     THEN 'OK: 게이트웨이 스키마'
   ELSE 'STOP: 다른 스키마가 이름을 선점' END AS verdict,
 (SELECT group_concat(name, ', ') FROM pragma_table_info('_request_log')) AS actual_columns"
```

실측(2026-08-04) 결과 — **운영에서 `STOP` 이 잡힌다:**

```
verdict        : STOP: 다른 스키마가 이름을 선점
actual_columns : ts, path, query, token
```

**✅ 이 건은 합의가 끝났다** ([../../docs/agreement.md §2](../../docs/agreement.md#2--_request_log--이름-충돌-해소-신규-합의)).
`(ts, path, query, token)` 4컬럼 표는 **transit·citydata 쪽에서 쓰던 것**이고,
**운영자 협의로 게이트웨이 스키마로 정리하는 데 합의**했다. 이름은 `_request_log` 그대로 간다 —
게이트웨이·콘솔·문서·MCP 가 전부 이 이름을 계약으로 쓰고 있어 개명은 그 전부를 흔든다.

**기존 389~401행은 보존 대상이 아니다.** `query`·`token` 은 수집 원칙("값이 아니라 축만",
decision/0001)상 애초에 남기면 안 되는 값이라, 옮겨 담을 곳이 없다. `token` 컬럼 값은
확인하지 않았고 앞으로도 열지 않는다.

### 정리 절차 — `STOP` 일 때만

> ⚠️ **원격 D1 쓰기다.** 실행 전 팀에 알리고, 담당자가 **직접** 실행한다.

```bash
# ① 기존 표를 치운다 — 보존 대상이 아니다
npx wrangler d1 execute <PROD_D1> --remote --env production   --command "DROP TABLE IF EXISTS _request_log"

# ② 정본 스키마로 다시 만든다 (아래 1번과 같은 명령 — 장부가 안 된 파일만 실행한다)
npx wrangler d1 migrations apply <PROD_D1> --remote --env production

# ③ 위 검사를 다시 돌려 'OK: 게이트웨이 스키마' 를 확인한다
```

**개발 D1 에도 같은 표가 있다** — 로컬 개발이 원격 dev 를 볼 때 같은 문제가 나므로
`ask-seoul-dev-d1` 에도 같은 절차를 적용한다(`--env` 없이).

이 정리가 **`migrations/0005`(행동 로그 축 확장, #9·#3)의 선행 조건**이다. 정본이 안 선
상태에서 ALTER 를 얹으면 어느 표에 붙는지가 배포 순서에 좌우된다.

**로컬에서 먼저 통과시킨다** — 배포본이 아니라 코드가 맞는지는 여기서 본다.

```bash
cd marketplace
npm test          # classifyClient 계약
npm run verify:log  # 요청 로그 유실 검증(C-10)
```

## 1. 팀 D1 에 운영 테이블 만들기 (최초 1회)

게이트웨이가 쓰는 `_keys`·`_usage`·`_burst`·`_issuance_log`·`_request_log` 는 지금까지
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

`_keys`·`_usage`·`_burst`·`_issuance_log`·`_request_log`·`_catalog` 가 보이면 된다.

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
