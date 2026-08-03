# 환경 규약 — 설정을 어디에 두고, 무엇이 환경마다 달라지나

> **이 문서는 API 담당자와 대시보드 담당자가 함께 관리한다.**
> 두 프로젝트가 **같은 구조**를 쓴다 — 한쪽만 바꾸면 규약이 아니라 예외가 된다.
> 실제 실행 절차(OS별 설치·명령)는 [setup.md](setup.md), 여기는 **구조와 배분**이다.

## 1. 한 줄 요약

**환경마다 달라지는 값은 각 프로젝트 `wrangler.toml` 한 파일 안에 있다 — 기본이 로컬,
`[env.production]` 이 배포다.** 명령은 배포할 때만 `--env production` 을 명시한다.

```toml
# <프로젝트>/wrangler.toml — 두 프로젝트가 같은 모양
name = "..."                  # ← 여기부터 기본 환경 = 로컬 개발
[dev]                         #    포트 고정(콘솔 :8788, 게이트웨이는 추후)
[assets]
[[d1_databases]]              #    dev D1 — 로컬 모드에선 상태 파일의 키로만 쓰인다

[env.production]              # ← 배포 전용. --env production 을 명시해야만 선택된다
[env.production.assets]
[[env.production.d1_databases]]  # prod D1
```

**플래그가 없으면 언제나 로컬이다.** 이 방향이 이 구조의 핵심이다 — `--env production` 을
빠뜨린 실수는 로컬로 떨어지고(안전), prod 를 건드리려면 명시적 의도가 필요하다.
환경별 파일 분리(`config/local`·`config/prod` + `-c`)안도 검토했지만, 그쪽은 모든 wrangler
호출에 `-c` 를 **사람이 매번** 붙여야 해서 누락이 곧 버그가 된다 — 검증 스크립트 3곳이
실제로 깨졌다. 전말은 [ops-dashboard decision/0009](../ops-dashboard/docs/decision/0009-per-env-config.md).

## 2. 환경별 실체

| | local (기본 환경) | production (`[env.production]`) |
|---|---|---|
| API (`marketplace`) | `http://localhost:8787` | 기준 도메인 `ask-seoul.kr` (예정 — 아래 ⚠️) |
| 대시보드 (`ops-dashboard`) | `http://localhost:8788` | `ops.ask-seoul.kr` (예정 — 아래 ⚠️) |
| D1 이름 | `ask-seoul-dev-d1` | `ask-seoul-prod-d1` |
| D1 id | `9db0e851-558e-489f-9e76-f131d25aa267` | `59a8409e-3be6-467b-8214-7938c59c8729` |
| D1 실제 접속 | 안 한다 — Miniflare 로컬 sqlite | 바인딩으로 붙는다 |
| 시크릿 | `.dev.vars` (프로젝트 루트 파일) | `wrangler secret put <이름> --env production` |

**두 D1 은 별개다.** prod D1 은 2026-08-03 신설이고 파이프라인이 62개 제품 게시를 시작했다
(ASAC-DAG#668). 단 게이트웨이 운영 테이블(`_keys` 등)과 콘솔 `_ops_*` 는 아직 없다 —
만드는 절차가 [deploy-runbook 1번](../marketplace/docs/deploy-runbook.md)이다.

⚠️ **도메인은 결정이지 실체가 아직 아니다.** API 는 기준 도메인(apex), 콘솔은 `ops.`
서브도메인으로 갈리기로 했지만, zone 등록·보유 확인이 남아 `routes` 는 두 파일 다
아직 활성화하지 않았다(콘솔 쪽은 주석으로 자리만 잡아 뒀다). zone 이 하나여도 Worker·
배포·롤백은 따로다 — 그게 분리의 목적이다
([decision/0001](../ops-dashboard/docs/decision/0001-separate-worker-from-marketplace.md)).

> **dev 환경은 아직 없다.** 값이 정해지면 `[env.dev]` 섹션으로 같은 자리에 추가한다.
> 기본 환경이 dev D1 을 이미 가리키고 있으므로, 그때 옮길 값은 명확하다.

## 3. 실행 파라미터 — 무엇이 어디로 갔나

**사람이 치는 명령은 환경별로 달라지지 않는다.** 차이는 전부 `wrangler.toml` 이 흡수한다.

| 값 | 어디에 있나 | 왜 거기인가 |
|---|---|---|
| D1 바인딩 | 기본 환경 / `[env.production]` 섹션 | 환경의 정의 그 자체 |
| 호스트 | prod 는 `routes`(활성화 대기), local 은 `[dev] port` | 같은 것의 환경별 표현 |
| 시크릿 | local 은 `.dev.vars` 파일, prod 는 `wrangler secret put --env production` | 파일을 배포에 싣지 않는다 |
| 정적 자산·엔트리 | 두 환경에 **각각 명시** (아래 4-① 참고) | env 섹션은 상속되지 않는다 |
| `--persist-to` | **명령줄** (`package.json`, 콘솔만) | 로컬에만 있는 개념 |

### 사람이 치는 명령

```bash
npm install
npm run seed     # 로컬만
npm run dev      # 로컬만 — 포트는 [dev] port 가 정한다 (--port 불필요)
```

배포는 npm script 가 **없다.** 사람이 런북을 보고 직접 친다(멘토 게이트 — 5절).

```bash
npx wrangler deploy --env production
```

## 4. 함정 셋

### ① `[env.production]` 은 상속되지 않는다 — assets 를 양쪽에 적는다

env 섹션은 기본 환경을 **물려받지 않는 항목이 많다.** `[assets]`·`run_worker_first` 를
기본에만 적으면 배포본에서 정적 서빙·라우팅이 조용히 달라진다. 그래서 두 파일 다
`[env.production.assets]` 를 **중복 명시**한다. 새 API 네임스페이스를 `run_worker_first` 에
추가할 때 **두 곳을 같이** 고친다 — 한쪽만 고치면 배포본에서만 그 경로가 정적 404 로 떨어진다.

### ② 시크릿 파일(`.dev.vars`)은 wrangler 설정 파일 옆에서 찾는다

지금 구조에선 설정이 프로젝트 루트라 `.dev.vars` 도 **프로젝트 루트**가 맞다.
Windows 에서 이 파일을 셸로 만들 때 인코딩을 지정하지 않으면 UTF-16LE 로 저장돼
**조용히 안 읽힌다** — 기동 로그·증상·해법은 [setup.md §3](setup.md) 실측 표 참고.

### ③ 콘솔의 `--persist-to` 는 여전히 필수다

콘솔은 게이트웨이의 로컬 상태(`../marketplace/.wrangler/state`)에 붙어 읽는다
([decision/0003](../ops-dashboard/docs/decision/0003-single-shared-local-d1.md)).
`package.json` 의 `seed`·`dev` 에 이미 들어 있다 — 콘솔에서 wrangler 를 **직접** 칠 때도
같이 넘겨야 같은 DB 를 본다. 게이트웨이 쪽은 기본값(`.wrangler/state`)이라 필요 없다.

## 5. 마이그레이션 — 적용 여부는 장부가 추적한다

게이트웨이 시드의 마이그레이션 단계는 `wrangler d1 migrations apply` 다. 적용된 파일이
D1 안의 장부(`d1_migrations`)에 기록되고 **안 된 파일만 실행**되므로:

- 새 마이그레이션은 `migrations/` 에 파일을 추가하면 끝 — 시드 체인을 손대지 않는다
  (체인 갱신을 사람이 기억하다 0004 누락으로 요청 로그가 전량 유실됐던 실사고의 재발 방지).
- 같은 명령이 로컬(`--local`)과 운영(`--remote --env production`, 런북 1번)에서 같게 동작한다.
- 추적 전환 이전에 만든 로컬 상태는 시드가 장부를 자동 백필한다
  (`marketplace/scripts/backfill-migrations-ledger.sql` — 파일이 만든 객체가 실존할 때만 기록).

**콘솔은 예외다** — `_ops_*` 는 잃을 상태가 없는 동안 단일 파일 DROP+CREATE 리셋 규약이라
([decision/0007](../ops-dashboard/docs/decision/0007-schema-single-file-reset.md)) 추적기를 쓰지
않는다. 콘솔이 팀 D1 로 승격되면 그때 증분+추적으로 전환한다.

## 6. 아직 열려 있는 것

- **운영 D1 에 운영 테이블 만들기** — 게이트웨이(런북 1번)와 콘솔(`migrations/0001` 을
  `--remote` 로) 둘 다, **사람이 직접 실행하는 팀 D1 쓰기**다.
- **도메인 zone 등록 확인** — 확인되면 두 `wrangler.toml` 의 `routes` 를 활성화한다.
  콘솔 쪽은 그 전에 Cloudflare Access 를 `ops.` 호스트로 **한정해서** 거는 게 선행이다
  (#20 결정 B-1 — zone 전체나 `*.ask-seoul.kr` 로 걸면 공개 API 까지 잠긴다).
- **배포는 아직 허용되지 않았다.** `[env.production]` 이 있다는 것과 배포해도 된다는 것은
  다르다 — 멘토 게이트(#476 ①). 그래서 **두 `package.json` 다 deploy 스크립트를 두지 않는다.**
