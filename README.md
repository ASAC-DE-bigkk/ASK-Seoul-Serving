# ask-seoul-serving

ASK: SEOUL **서빙 계층** — 레이크하우스의 gold 산출물을 바깥으로 내보내는 쪽. Cloudflare Workers 두 개가 산다.

```
marketplace/      외부 데이터 API + 키 발급 + 법적 고지   (청중: 외부 소비자·AI 에이전트)
ops-dashboard/    파이프라인·서빙 품질 대시보드            (청중: 내부 운영자)
```

두 Worker는 코드를 공유하지 않는다. **같은 D1을 읽는다는 것**이 유일한 접점이고, 그래서
호스트도 배포도 따로 간다 — 청중이 다르면 가용성 요구도 인증 모델도 다르기 때문이다.

## 어디서 왔나

`ask-seoul`(인프라) 레포의 `serving-gateway/`·`ops-console/`을 히스토리째 이관했다
(각각 `marketplace/`·`ops-dashboard/`로 개명)
(ASK-Seoul#58 / PR#59). 인프라 레포는 docker-compose가 마운트하는 것(`dags`·`dbt`)만
품고, 서빙 계층은 자기 집에서 자기 CI로 배포한다.

## 데이터는 어떻게 들어오나

이 레포는 **데이터를 만들지 않는다.** 파이프라인이 D1에 발행한 것을 읽어서 내보낼 뿐이다.

```
ASAC-DBT (gold)  →  ASAC-DAG 공통 Publisher  →  Cloudflare D1  →  이 레포의 Worker
                     (계약: serving-contract-v1)      _catalog
                                                      _ops_slo
                                                      _gateway_request_log
```

결합은 레포가 아니라 **D1 스키마 계약**에 있다. Worker에는 파일시스템이 없으므로
dbt manifest·Airflow 메타DB를 직접 읽는 경로는 존재하지 않는다 — 새 정보를 화면에
띄우려면 먼저 파이프라인이 D1에 발행해야 한다.

| 레포 | 역할 |
|---|---|
| [ASAC-DAG](https://github.com/ASAC-DE-bigkk/ASAC-DAG) | 수집·적재 + 공통 D1 Publisher + 서빙 계약 정본 |
| [ASAC-DBT](https://github.com/ASAC-DE-bigkk/ASAC-DBT) | 도메인별 dbt 변환 · `meta.serving` 계약 선언 |
| [ask-seoul](https://github.com/ASAC-DE-bigkk/ask-seoul) | 인프라(Airflow·Trino·R2·docker-compose) |
| **ask-seoul-serving** | ← 여기. 서빙 계층 |

## 무엇이 정해져 있나

**[docs/agreement.md](docs/agreement.md) 가 정본이다.** 이슈에 흩어져 있던 결정
(수집 축·소유 경계·환경 규약·공개 배포·MCP)을 하나로 합쳤고, **폐기된 안과 그 이유**까지
남겨 뒀다. 같은 주제를 두 번 논의하지 않기 위한 문서다 — 여기 적힌 결정을 바꾸려면
이 문서를 먼저 고친다.

프로젝트별 상세 근거는 각 `docs/decision/` 에 있다.

## 로컬에서 띄우기

원격 배포 없이 `wrangler dev`(Miniflare 로컬 sqlite D1)로만 돈다. **팀 D1에 쓰지 않는다.**

두 프로젝트가 같은 D1을 공유하므로 실행 규약은 **API·대시보드 담당자가 함께 관리하는 문서**에 있다.

| 문서 | 무엇 |
|---|---|
| [docs/agreement.md](docs/agreement.md) | **합의 정본** — 결정·경계·폐기된 안·남은 과제 |
| [docs/change-log.md](docs/change-log.md) | **변경 이력** — 언제 무슨 의도로 코드에 닿았나(날짜·작업자·의도·조치·결과) |
| [docs/setup.md](docs/setup.md) | 사전 준비(Node 20+)·OS별 실행 절차·증상별 해결 |
| [docs/environments.md](docs/environments.md) | 환경 규약 — 설정 배치, local/prod 도메인·D1, 실행 파라미터 배분 |

```bash
# macOS / Linux
cd marketplace   && npm install && npm run seed && npm run dev   # :8787
cd ops-dashboard && npm install && npm run seed && npm run dev   # :8788
```

```powershell
# Windows (PowerShell) — && 는 파서 오류다. 한 줄씩 실행한다.
cd marketplace   ; npm install ; npm run seed ; npm run dev      # :8787
cd ops-dashboard ; npm install ; npm run seed ; npm run dev      # :8788
```

`ops-dashboard`는 `marketplace`의 로컬 D1 상태를 공유하므로 **marketplace를 먼저 시드**할 것.
각 디렉토리 README에 설계 근거(공개 게이트·키셋 커서·2층 제한·폐기와 삭제의 구분 등)가 있다.

## 상태

프로토타입이다. 원격 배포·팀 D1 `_keys` 생성·GitHub OAuth 승격은 배포 결정(docs/agreement.md §8)으로 남아 있다
(ASAC-DAG#476).
