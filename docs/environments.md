# 환경 규약 — 설정을 어디에 두고, 무엇이 환경마다 달라지나

> **이 문서는 API 담당자와 대시보드 담당자가 함께 관리한다.**
> 두 프로젝트가 **같은 구조**를 쓴다 — 한쪽만 바꾸면 규약이 아니라 예외가 된다.
> 실제 실행 절차(OS별 설치·명령)는 [setup.md](setup.md), 여기는 **구조와 배분**이다.

## 1. 한 줄 요약

**환경마다 달라지는 값은 명령줄이 아니라 `config/<환경>/wrangler.toml` 안에 있다.**
명령은 어느 환경이냐만 고르고(`-c`), 나머지는 그 파일이 답한다.

```text
marketplace/                       ops-dashboard/
  config/                            config/
    local/                             local/
      wrangler.toml   ← 로컬              wrangler.toml
      .dev.vars       ← 로컬 시크릿        .dev.vars
      .dev.vars.example                  .dev.vars.example
    prod/                              prod/
      wrangler.toml   ← 운영              wrangler.toml
```

**파일 이름은 같고 디렉토리가 다르다.** 그래서 "어느 파일을 고칠까"가 아니라
"어느 환경을 고칠까"만 정하면 된다. 배포도 같은 파일을 참조한다
(`wrangler deploy -c config/prod/wrangler.toml`).

**프로젝트 루트에 `wrangler.toml` 은 없다.** 일부러 지웠다 — 남겨 두면 `-c` 를 빠뜨렸을 때
wrangler 가 그걸 조용히 집어서 **틀린 환경으로 돈다.** 지금은 빠뜨리면 즉시 "config 없음"으로
멈춘다. 시끄러운 실패가 조용한 오작동보다 낫다.

## 2. 환경별 실체

| | local | prod |
|---|---|---|
| API (`marketplace`) | `http://localhost:8787` | `https://ask-seoul.kr` |
| 대시보드 (`ops-dashboard`) | `http://localhost:8788` | `https://ops.ask-seoul.kr` |
| D1 이름 | `ask-seoul-dev-d1` | `ask-seoul-prod-d1` |
| D1 id | `9db0e851-558e-489f-9e76-f131d25aa267` | `59a8409e-3be6-467b-8214-7938c59c8729` |
| D1 실제 접속 | 안 한다 — Miniflare 로컬 sqlite | 바인딩으로 붙는다 |
| 시크릿 | `config/local/.dev.vars` (파일) | `wrangler secret put` (Cloudflare 보관) |

**두 D1 은 별개다.** 운영 D1 은 2026-08-03 에 신설됐고 **운영 테이블이 아직 없다** —
`_keys`·`_request_log` 도, `_ops_slo` 도, 도메인 export 가 발행하는 `_catalog`·제품 테이블도
그쪽에 있다고 전제하지 않는다. 배포 전에 마이그레이션을 `--remote` 로 적용하는 것이
[deploy-runbook 1번](../marketplace/docs/deploy-runbook.md)이고, 콘솔도 같은 절차가 필요하다.

기준 도메인은 `ask-seoul.kr` 하나다. **API 가 도메인 자체(apex), 대시보드가 `ops.` 서브도메인**이다.
zone 은 하나지만 Worker·배포·롤백은 따로다 — 사고 반경이 갈리는 게 분리의 목적이다
([ops-dashboard decision/0001](../ops-dashboard/docs/decision/0001-separate-worker-from-marketplace.md)).

> **dev 환경은 아직 없다.** `config/dev/` 를 미리 만들지 않았다 — 값이 정해지지 않은 환경을
> 디렉토리로 먼저 세우면 그게 실체인 줄 안다. local 이 dev D1(`9db0e851-…`)을 가리키고 있어서,
> dev 가 서면 그 값을 그대로 옮기면 된다.

## 3. 실행 파라미터 — 무엇이 어디로 갔나

**결론: 사람이 치는 명령은 환경별로 달라지지 않는다.** 차이는 전부 config 파일이 흡수한다.

| 값 | 어디에 있나 | 왜 거기인가 |
|---|---|---|
| D1 `database_id` | `config/<env>/wrangler.toml` | 환경의 정의 그 자체 |
| 호스트 | prod 는 `routes`, local 은 `[dev] port` | 같은 것의 환경별 표현 — 명령줄에 두면 문서와 어긋난다 |
| 시크릿 | local 은 `config/local/.dev.vars`, prod 는 `wrangler secret put` | 파일을 배포에 싣지 않는다 |
| 정적 자산·엔트리 | 두 환경 **동일** | 달라지면 "로컬에선 됐는데"가 생긴다 |
| `--persist-to` | **명령줄** (`package.json`) | 로컬에만 있는 개념이라 prod 파일에 쓸 자리가 없다 |

### 사람이 치는 명령

```bash
npm install
npm run seed     # 로컬만 — 안에 -c config/local/... 이 이미 들어 있다
npm run dev      # 로컬만
```

**`npm run dev` 는 그대로다.** `--port` 도 넘기지 않는다 — 포트는 `[dev] port` 로 config 에 박혀 있다.

배포는 npm script 가 **없다.** 사람이 런북을 보고 직접 친다(멘토 게이트 — 4절).

```bash
npx wrangler deploy -c config/prod/wrangler.toml
```

### 직접 wrangler 를 칠 때만 파라미터가 는다

루트 `wrangler.toml` 이 없으므로 **`-c` 는 필수**다. 로컬 D1 을 만지는 명령이면
`--persist-to` 도 같이 준다.

```bash
npx wrangler d1 execute ask-seoul-dev-d1 --local \
  -c config/local/wrangler.toml --persist-to .wrangler/state --command "SELECT 1"
```

## 4. 함정 셋 — 전부 실측으로 확인했다

`-c` 로 config 를 옮기면 **wrangler 가 그 파일 위치를 기준으로 다른 것들도 찾는다.**
세 가지가 같이 움직이는데, 셋 다 조용히 틀린다.

### ① 상대 경로는 config 파일 기준이다

`main`·`[assets] directory` 가 `../../src/index.js` 로 시작하는 이유다.
프로젝트 루트 기준으로 쓰면 빌드가 파일을 못 찾는다.

### ② `.dev.vars` 도 config 파일 옆에서 찾는다 — 그래서 옮겼다

프로젝트 루트에 두면 **읽히지 않는다.** 기동 로그에서 확인할 수 있다.

```text
Using secrets defined in config\local\.dev.vars   ← 이 줄이 있어야 읽힌 것
```

콘솔에서 이 줄이 없으면 `OPS_TOKEN` 이 비어 폐기·복구·쿼터·삭제가 전부 **503** 이 된다.
화면과 읽기는 멀쩡해서 눈치채기 어렵다. 결과적으로 **시크릿도 환경별로 갈렸다** —
`config/prod/.dev.vars` 를 만들 일은 없지만(운영 시크릿은 `wrangler secret put`),
구조는 같은 모양을 유지한다.

### ③ 로컬 상태(`.wrangler/state`)도 config 옆으로 간다

`--persist-to` 를 빼면 상태가 `config/local/.wrangler/state` 에 생긴다.
그러면 **두 프로젝트가 공유하던 D1 이 갈라져서** 콘솔의 서빙 품질·키 관리 탭이 통째로 빈다
(`meta.missing`). 그래서 `package.json` 이 항상 명시한다.

| 프로젝트 | `--persist-to` | 의미 |
|---|---|---|
| marketplace | `.wrangler/state` | 상태의 주인 |
| ops-dashboard | `../marketplace/.wrangler/state` | 저쪽에 붙어 읽는다 |

## 5. 두 config 를 같이 고쳐야 하는 것

`config/local` 과 `config/prod` 에서 **달라도 되는 건 셋뿐**이다 — `routes`/`[dev] port`,
D1, 주석. 나머지가 갈리면 "로컬에선 됐는데 배포본만 죽는" 유형이 된다.

특히 **`run_worker_first` 는 한쪽만 고치기 쉽다.** 새 API 네임스페이스를 추가할 때
prod 에 빠뜨리면 배포본에서만 그 경로가 Worker 에 닿지 못하고 정적 404 로 떨어진다.

## 6. 아직 열려 있는 것

- **운영 D1 에 테이블을 만드는 일이 남았다.** 값은 확정됐지만(`ask-seoul-prod-d1`), 그 D1 은
  비어 있다. 게이트웨이 마이그레이션(런북 1번)과 콘솔 `migrations/0001` 을 `--remote` 로
  적용해야 하고, 둘 다 **사람이 직접 실행하는 팀 D1 쓰기**다.
- **`_catalog`·제품 테이블이 운영 D1 에 있는지 확인되지 않았다.** 도메인 export 는 지금까지
  dev D1 로 발행해 왔다(#20 결정 A). 없으면 배포해도 카탈로그가 0종이다 — 배포 실패가 아니라
  **export 타겟 이관이 선행 과제**라는 뜻이고, 팀 조율이 필요하다.
- **배포는 아직 허용되지 않았다.** `config/prod` 가 있다는 것과 배포해도 된다는 것은 다르다 —
  공개 URL 신설은 멘토 게이트(#476 ①)이고, 콘솔은 그에 더해 Cloudflare Access 승격
  (#20 결정 B-1)이 선행이다. 그래서 **`package.json` 에 deploy 스크립트를 두지 않는다.**
- **Access 적용 범위는 `ops.ask-seoul.kr` 호스트로 한정**해야 한다. zone 전체나
  `*.ask-seoul.kr` 로 걸면 공개 API 까지 로그인 뒤로 잠긴다.
