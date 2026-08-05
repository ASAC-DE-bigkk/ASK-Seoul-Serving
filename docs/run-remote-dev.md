# 팀 dev D1 을 보기 — 원격 바인딩 (보기 전용)

> **환경 매뉴얼 셋 중 하나.** [로컬](run-local.md) · [운영 D1](run-prod.md) ·
> 구조와 배분은 [environments.md](environments.md).

**로컬에는 없는 데이터를 보기 위한 환경이다.** 워커는 여전히 내 노트북에서 돌고,
D1 만 팀 것에 붙는다. 배포가 아니다 — 팀에 보이는 것은 아무것도 바뀌지 않는다.

| | |
|---|---|
| D1 | 팀 `ask-seoul-dev-d1` (원격) |
| 플래그 | `--remote --env dev` |
| 쓰기 | 🔒 **잠김** — 코드가 막는다([decision/0013](../ops-dashboard/docs/decision/0013-remote-readonly-attach.md)) |
| 주소 | 콘솔 `:8798` (로컬 `:8788` 과 **동시 구동 가능**) |

## 왜 이게 필요한가

파이프라인이 싣는 **운영 기록 4종**(`_ops_run_event`·`_ops_daily_metric`·
`_ops_pipeline_state`·`_ops_pipeline_expectation`)의 실측은 **팀 dev D1 에만 있다.**
로컬 Miniflare 에는 표만 있고 비어 있다 — `migrations/0002` 는 화면을 돌려보기 위한
빈 껍데기이지 정본이 아니다([decision/0009](../ops-dashboard/docs/decision/0009-ops-records-consumption.md)).

즉 **'실행 기록' 탭이 로컬에서 비어 있는 것은 고장이 아니다.** 그 탭을 보려면 여기로 온다.

## 1. 자격증명 (한 번만)

원격 D1 에 붙으려면 wrangler 가 쓸 Cloudflare 토큰이 필요하다.

```bash
cd ops-dashboard
cp .env.example .env      # CLOUDFLARE_API_TOKEN · CLOUDFLARE_ACCOUNT_ID 채우기
```

wrangler 는 같은 디렉터리의 `.env` 를 **자동으로** 읽는다(플래그 불필요).
`.gitignore` 대상이고, 권한은 필요한 만큼만 준다 — **보기만 할 것이면 `D1:Read`** 로 충분하다.
토큰이 새면 그 권한만큼이 사고 반경이다.

> `.env`(wrangler 라는 도구가 읽는다)와 `.dev.vars`(Worker 안에서 읽는다)는 **다른 파일**이다.
> 역할 구분은 [environments.md §2](environments.md).

## 2. 띄우기

```bash
cd ops-dashboard
npm run dev:dev-d1        # :8798
```

로컬(`:8788`)을 띄워 둔 채로 같이 돌려도 된다 — 포트도 인스펙터도 갈라 뒀다.

## 3. 보기 전용이라는 것을 확인한다

붙자마자 화면이 세 군데에서 말한다:

- 상단 배지 — `팀 dev · ask-seoul-dev-d1 · 보기 전용`
- 잠금 해제 버튼 — `보기 전용 · 원격 D1` 로 바뀌고 **눌리지 않는다**
- 조치를 강제로 보내면 — `503 read-only mode`

```bash
curl -s "http://localhost:8798/api/summary?days=14" | jq '.meta.env'
# { "label": "팀 dev", "d1": "ask-seoul-dev-d1", "readonly": true }
```

## 4. ⚠️ `--remote` 는 원래 읽기 전용이 아니다

wrangler 의 `--remote` 는 **그 자체로는 아무것도 막지 않는다.** 붙은 상태에서 누른
폐기·삭제는 그대로 팀 DB 에 적용된다. 그래서 이 스크립트가 `--var ENV_READONLY:1` 을
같이 넘겨 **코드로** 잠근다.

즉 **안전한 것은 `--remote` 가 아니라 `npm run dev:dev-d1` 이라는 경로다.**
wrangler 를 직접 쳐서 붙으면 빗장이 없다.

```bash
npx wrangler dev --remote        # ⚠️ 빗장 없음 — 조치가 팀 DB 에 그대로 간다
```

`npm run seed` 를 `--remote` 로 돌리는 것도 같은 이유로 하지 않는다 — 불변 경계
"팀(원격) D1 에 쓰지 않는다"([decision/0002](../ops-dashboard/docs/decision/0002-local-only-mentor-gate.md)).

## 5. SQL 로 직접 볼 때

```bash
cd ops-dashboard
npm run d1:dev -- "SELECT COUNT(*) AS n FROM _ops_run_event"
npm run d1:dev -- "SELECT dag_id, last_observed_at FROM _ops_pipeline_state ORDER BY 2 DESC LIMIT 10"
```

읽기 문장만 통과한다 — `DELETE`·`DROP`·세미콜론으로 이어 붙인 문장은 **거절**된다.

## 6. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 인증 오류 / `not logged in` | `.env` 없음 또는 토큰 만료 | `.env` 의 `CLOUDFLARE_API_TOKEN` 확인 |
| `D1_ERROR: no such table` | 그 표가 팀 dev D1 에 아직 없다 | 정본(ASAC-DAG)이 적재했는지 먼저 확인 |
| 조치 버튼이 없다 | **정상이다** — 보기 전용 | 조치는 [로컬](run-local.md)에서 한다 |
| 화면이 로컬과 같아 보인다 | 배지를 안 봤다 | 상단 배지에 `보기 전용` 이 붙어 있다 |
| `:8798` 충돌 | 다른 프로세스 | 포트 정리 후 재시도 |

## marketplace 는?

**게이트웨이는 이 구조를 아직 안 쓴다.** 저쪽은 `_burst`·`_usage`·`_gateway_request_log`
때문에 **모든 요청이 D1 에 쓴다** — GET 하나에도 버스트·로그가 쌓이므로 같은 빗장으로는
"보기 전용"이 성립하지 않는다. 계량 경로를 어떻게 할지가 먼저이고, **그 판단은 게이트웨이
담당자 몫이다.** 그때까지 게이트웨이의 원격 확인은 하지 않는다.
