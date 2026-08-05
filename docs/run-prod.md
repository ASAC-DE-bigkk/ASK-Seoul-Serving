# 운영 D1 을 보기 — 원격 바인딩 (보기 전용)

> **환경 매뉴얼 셋 중 하나.** [로컬](run-local.md) · [원격 dev D1](run-remote-dev.md) ·
> 구조와 배분은 [environments.md](environments.md).

**운영 데이터를 눈으로 확인하기 위한 환경이다.** 워커는 내 노트북에서 돌고 D1 만 운영 것에
붙는다. **배포가 아니다** — 공개 URL 은 생기지 않고, 팀에 보이는 것은 아무것도 안 바뀐다.

| | |
|---|---|
| D1 | `ask-seoul-prod-d1` (원격) |
| 플래그 | `--remote --env production` |
| 쓰기 | 🔒 **잠김** — 코드가 막는다([decision/0013](../ops-dashboard/docs/decision/0013-remote-readonly-attach.md)) |
| 주소 | 콘솔 `:8799` (로컬 `:8788`·dev `:8798` 과 **동시 구동 가능**) |

## 🔴 먼저 읽을 것

**운영 D1 은 62개 제품이 사는 파이프라인의 DB 다.** 그리고 **D1 의 Time Travel 은 표 단위가
아니라 DB 전체를 덮어쓴다** — 되돌리는 순간 발급된 키·쿼터·요청 로그가 같이 과거로 간다
(ASAC-DAG#476). "일단 해 보고 안 되면 되돌린다"가 **성립하지 않는다.**

그래서 이 환경에서 할 수 있는 일은 **보는 것뿐이고, 그 제한은 문서가 아니라 코드가 건다.**

## 1. 자격증명

[원격 dev D1 §1](run-remote-dev.md) 과 같다. 권한은 **`D1:Read` 만** 주는 것을 권한다 —
보기 전용 빗장은 우리 코드에 있지만, 토큰 권한은 wrangler 바깥까지 덮는 두 번째 방어선이다.

## 2. 띄우기

```bash
cd ops-dashboard
npm run dev:prod-d1       # :8799
```

## 3. 운영이라는 것을 확인한다

```bash
curl -s "http://localhost:8799/api/summary?days=14" | jq '.meta.env, .meta.runs_env_scope'
# { "label": "운영", "d1": "ask-seoul-prod-d1", "readonly": true }
# "prod"
```

화면 상단 배지가 **붉은색** `운영 · ask-seoul-prod-d1 · 보기 전용` 으로 뜬다.
붉은색은 이 화면에서 유일하게 환경을 뜻하는 색이다.

### 운영 화면은 prod 기록만 센다

`ENV_SCOPE = "prod"` 라 실행 기록을 `environment='prod'` 로 좁힌다. 실측(2026-08-04)
운영 D1 에 `environment='dev'` 17행이 섞여 있다 — 도메인 쪽 환경 판정 결함은 고쳐졌지만
**과거 행은 남는다**(#78 Z-7). 거르지 않으면 개발 실행이 운영 지표에 들어간다.

**무엇이 빠졌는지는 화면이 직접 밝힌다** — `meta.runs_env_excluded` 에 제외된 건수가,
`meta.runs_env_scope_partial` 에 "집계표는 `environment` 컬럼이 없어 **못 걸렀다**"가 실린다
([decision/0012](../ops-dashboard/docs/decision/0012-runs-tab-observation-boundaries.md)).

## 4. SQL 로 직접 볼 때

```bash
cd ops-dashboard
npm run d1:prod -- "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npm run d1:prod -- "SELECT COUNT(*) AS n FROM _ops_run_event"
```

읽기 문장만 통과한다. `DELETE`·`DROP`·`ALTER`·세미콜론 체이닝은 **거절**된다 —
[decision/0013](../ops-dashboard/docs/decision/0013-remote-readonly-attach.md).

## 5. 여기서 하지 않는 것

| 하지 않는 것 | 왜 | 어디서 하나 |
|---|---|---|
| `npm run seed` 를 `--remote` 로 | 팀 D1 에 쓰게 된다 — 불변 경계 | 하지 않는다 |
| 마이그레이션 적용 | 되돌릴 수 없다 | 사람이 런북 보고 직접 (아래) |
| 키 조치(폐기·삭제) | 코드가 막는다 | [로컬](run-local.md) |
| `wrangler deploy` | **금지** — 배포 결정(agreement §8)이 선행 | 아직 없다 |

**운영 D1 에 운영 테이블을 만드는 것**(콘솔 `migrations/0001` 을 `--remote` 로)은 아직
열려 있는 과제이고, **사람이 직접 실행하는 팀 D1 쓰기**다. 게이트웨이 쪽 절차는
[marketplace/docs/deploy-runbook.md](../marketplace/docs/deploy-runbook.md) 1번.
`npm run dev:prod-d1` 은 그 일을 하지 않는다.

## 6. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 탭이 통째로 비었다 | 운영 D1 에 아직 그 표가 없다 | `npm run d1:prod -- "SELECT name FROM sqlite_master WHERE type='table'"` 로 확인 |
| 키 관리 탭이 비었다 | `_keys` 는 운영 D1 에 **아직 없다** | 정상 — 생성 절차는 위 §5 |
| 조치 버튼이 없다 | **정상이다** — 보기 전용 | 조치는 [로컬](run-local.md) |
| 숫자가 로컬과 다르다 | 당연하다 — 다른 DB 다 | 배지로 어느 쪽인지 먼저 확인 |
| 배지가 붉지 않다 | 운영이 아니다 | `--env production` 이 빠졌는지 확인 |

## marketplace 는?

게이트웨이는 이 구조를 아직 안 쓴다 — 이유와 남은 판단은
[원격 dev D1 매뉴얼 마지막 절](run-remote-dev.md#marketplace-는)에 있다.
