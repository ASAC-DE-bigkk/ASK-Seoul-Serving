# marketplace 배포 런북 (통합 검증용 타겟)

> **이 문서는 승인 후 실행 절차다.** `wrangler deploy` 는 공개 URL 신설이라 멘토 게이트
> (ASAC-DAG#476 ①)이고, 승인 없이 실행하지 않는다. 결정 상태는 ASK-Seoul-Serving#20.
>
> 대상 범위는 **팀 통합 검증용 비공개 타겟 1개**다 — 외부 공지·문서 링크 없이 올리고,
> 정식 공개는 별도 판단(#20)이다. 이유는 ASK-Seoul-Serving#4 가 V1 6개 제품 계약 검증에
> 실제 게시본을 읽는 타겟을 요구하기 때문이다.

## 0. 전제 확인

> **설정은 환경별로 갈려 있다.** 아래 명령이 전부 `-c config/prod/wrangler.toml` 을 다는 이유다.
> 프로젝트 루트에 `wrangler.toml` 은 **없다** — `-c` 를 빠뜨리면 조용히 로컬 설정으로 도는 대신
> 즉시 멈춘다. 배치와 근거는 [../../docs/environments.md](../../docs/environments.md).

| 항목 | 확인 방법 | 기대 |
|---|---|---|
| 멘토 승인 | #476 ① 코멘트 | 있음 |
| 대상 D1 | `config/prod/wrangler.toml` `[[d1_databases]]` | `ask-seoul-prod-d1` / `59a8409e-3be6-467b-8214-7938c59c8729` |
| 운영 테이블 | 아래 1번 | ⚠️ **아직 없다** — 이 D1 은 2026-08-03 신설이다. 1번을 건너뛰면 배포해도 발급·인증이 죽는다 |
| 호스트 | 같은 파일 `routes` | `ask-seoul.kr` (콘솔은 `ops.` 서브도메인 — 다른 Worker) |
| Cloudflare 계정 | 팀 계정 로그인 | `npx wrangler whoami` |
| 코드 | 머지된 `dev` | 로컬 `npm test` · `npm run verify:log` 통과 |

**로컬에서 먼저 통과시킨다** — 배포본이 아니라 코드가 맞는지는 여기서 본다.

```bash
cd marketplace
npm test          # classifyClient 계약
npm run verify:log  # 요청 로그 유실 검증(C-10)
```

## 1. 팀 D1 에 운영 테이블 만들기 (최초 1회)

게이트웨이가 쓰는 `_keys`·`_usage`·`_burst`·`_issuance_log`·`_request_log` 는 지금까지
`--local` 로만 적용해서 **운영 D1 에는 없다.** 이걸 안 하면 배포해도 키 발급·인증이 전부 죽는다.

`ask-seoul-prod-d1` 은 2026-08-03 에 신설된 별도 D1 이다(dev `9db0e851-…` 와 다르다).
**제품 테이블·`_catalog` 도 여기엔 아직 없을 수 있다** — 아래 확인 쿼리로 실제 상태를 먼저 본다.
`_catalog` 가 비어 있으면 스모크의 `catalog` 항목이 0종으로 떨어지고, 그건 배포 실패가 아니라
**도메인 export 가 이 D1 을 향하지 않는다**는 뜻이다(#20 결정 A 의 "정식 공개 전 prod 이관").

> ⚠️ **팀(원격) D1 쓰기다.** 스키마 생성만 하고 기존 표(`_catalog`·제품 테이블)는 건드리지
> 않지만, 실행 전에 팀에 알린다. 이 명령은 **직접 실행한다** — 에이전트가 대신 돌리지 않는다.

```bash
cd marketplace
npx wrangler d1 execute ask-seoul-prod-d1 --remote -c config/prod/wrangler.toml --file=migrations/0001_keys_usage.sql
npx wrangler d1 execute ask-seoul-prod-d1 --remote -c config/prod/wrangler.toml --file=migrations/0002_request_log.sql
npx wrangler d1 execute ask-seoul-prod-d1 --remote -c config/prod/wrangler.toml --file=migrations/0003_burst.sql
npx wrangler d1 execute ask-seoul-prod-d1 --remote -c config/prod/wrangler.toml --file=migrations/0004_request_id.sql
```

전부 `CREATE TABLE IF NOT EXISTS` 라 여러 번 돌려도 안전하다. 단 `0004` 는 `ALTER` 라
이미 적용된 상태면 실패하는데, 그건 정상이고 넘어가면 된다.

확인:

```bash
npx wrangler d1 execute ask-seoul-prod-d1 --remote -c config/prod/wrangler.toml \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\_%' ESCAPE '\'"
```

`_keys`·`_usage`·`_burst`·`_issuance_log`·`_request_log`·`_catalog` 가 보이면 된다.

## 2. 시크릿 넣기 (최초 1회)

`ISSUANCE_SALT` 가 없으면 **발급이 503 으로 닫힌다**(무염 해시 방지 — 의도된 fail-closed).

운영 시크릿은 **파일이 아니라 Cloudflare 에 넣는다** — `config/local/.dev.vars` 는 로컬 전용이고
배포에 실리지 않는다.

```bash
cd marketplace
# 값 생성 — 출력은 어디에도 남기지 말 것. openssl 이 없는 환경(Windows)은 node 로:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put ISSUANCE_SALT -c config/prod/wrangler.toml   # 프롬프트에 위 값을 붙여넣는다
```

## 3. 배포

```bash
cd marketplace
npx wrangler deploy -c config/prod/wrangler.toml
```

`config/prod/wrangler.toml` 의 `routes` 가 `ask-seoul.kr` 을 Custom Domain 으로 잡는다.
**이 주소는 한 번 정해지면 사실상 못 바꾼다**(소비자가 붙으면 변경 = 파손) — #476 ② 결정과
어긋나지 않는지 배포 전에 다시 확인한다. 콘솔은 `ops.ask-seoul.kr` 로 **별도 Worker · 별도
배포**다 — 여기서 같이 나가지 않는다.

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
| `catalog` 가 0종 | D1 바인딩이 다른 DB / `external=1` 제품 없음 | `config/prod/wrangler.toml` 의 `database_id` 확인 |
| `data 401` 이 500 | `_keys` 테이블 없음 | 1번 다시 |
| `X-Request-Id` 누락 | 구 버전 배포본 | 코드 SHA 확인 후 재배포 |

## 5. 되돌리기

```bash
npx wrangler deployments list -c config/prod/wrangler.toml           # 이전 배포 확인
npx wrangler rollback -c config/prod/wrangler.toml --message "<사유>" # 직전 배포로
```

데이터는 롤백되지 않는다 — 1번에서 만든 표는 그대로 남는다(비어 있어도 무해하다).

**완전히 내리려면** Cloudflare 대시보드에서 Worker 를 삭제한다. 그러면 그 URL 은
다시 쓰지 않는 게 좋다(캐시·북마크가 남는다).

## 6. 배포 후 알아둘 것

- **운영 콘솔은 이 배포에 포함되지 않는다.** ops-dashboard 는 로컬 전용이라
  (decision/0002) 배포된 게이트웨이의 요청 로그·키를 화면으로 볼 수 없다. 조회가 필요하면
  `wrangler d1 execute --remote` 로 직접 질의한다. 콘솔 공개는 #20 결정 B.
- **키·이메일이 팀 D1 에 쌓인다.** 통합 검증 단계라 팀원 테스트 키뿐이지만, 누군가 그 D1 을
  리셋하면 발급된 키가 같이 사라진다. 정식 공개 전에 prod D1 로 옮기면서 해소한다(#20 결정 A).
- **요청 로그는 30일 후 자동 삭제**된다(로그 100건당 약 2회 sweep). 발급 IP 해시는 24시간.
