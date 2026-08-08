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

🔴 **두 프로젝트 다 `wrangler dev` 가 운영 D1 에 붙는다**(#85 · decision/0015). 예전의
*"팀 D1에 쓰지 않는다"* 는 더는 성립하지 않는다 — 대신 남은 경계는 **"남의 표 모양은
바꾸지 않는다"** 다.

두 프로젝트가 같은 D1을 공유하므로 실행 규약은 **API·대시보드 담당자가 함께 관리하는 문서**에 있다.

| 문서 | 무엇 |
|---|---|
| [**docs/index.md**](docs/index.md) | **공동 문서 지도** — 아래 전부의 입구 |
| [docs/agreement.md](docs/agreement.md) | **합의 정본** — 결정·경계·폐기된 안·남은 과제 |
| [docs/change-log.md](docs/change-log.md) | **변경 이력** — 언제 무슨 의도로 코드에 닿았나(날짜·작업자·의도·조치·결과) |
| [docs/setup.md](docs/setup.md) | 사전 준비(Node 20+)·OS별 설치·증상별 해결 |
| [docs/environments.md](docs/environments.md) | 환경 **구조** — 설정 배치, local/prod 도메인·D1, 실행 파라미터 배분 |
| [docs/k-skill-local-evaluation.md](docs/k-skill-local-evaluation.md) | K-Skill 등록 전 팀 내부 평가 — 사용자 key 직접 검증과 proxy 기반 스킬 체험의 경계 |

**환경별 실행 매뉴얼** — 🔴 **두 프로젝트 다 띄우면 운영 D1 이다**
(dev D1 폐기 — [decision/0015](ops-dashboard/docs/decision/0015-single-production-d1.md) · #85,
게이트웨이도 2026-08-06 에 전환 완료).

| 매뉴얼 | 누구 | D1 | 쓰기 |
|---|---|---|---|
| [docs/run-prod.md](docs/run-prod.md) | **콘솔** | **운영** `ask-seoul-prod-d1` | ✅ **열려 있다** |
| [docs/run-local.md](docs/run-local.md) | **게이트웨이** | **운영** `ask-seoul-prod-d1` | ✅ **열려 있다** |

🔴 **띄우면 운영이다 — 양쪽 다.** 바인딩에 `remote = true` 가 박혀 있어 **기본값이 운영**이고,
플래그는 안전장치가 아니다. 콘솔은 화면의 조치 한 번이 실제 고객 키에 가고, 게이트웨이는
로컬 구동이 운영 `_keys`·`_usage`·`_burst` 를 실제로 건드린다. 남아 있는 잠금은 **스키마
하나**뿐이다 — 남의 표 DDL 은 코드가 막는다.

```bash
# macOS / Linux
cd marketplace   && npm install && npm run dev   # :8787  🔴 운영 D1
cd ops-dashboard && npm install && npm run dev   # :8788  🔴 운영 D1
```

```powershell
# Windows (PowerShell) — && 는 파서 오류다. 한 줄씩 실행한다.
cd marketplace   ; npm install ; npm run dev     # :8787  🔴 운영 D1
cd ops-dashboard ; npm install ; npm run dev     # :8788  🔴 운영 D1
```

**두 프로젝트 다 `npm run seed` 가 없다** — 로컬이 실물을 보므로 픽스처를 넣을 자리가 없다.
스키마 적용은 양쪽 다 `npm run migrate*` 이고 대상은 운영 D1 이다
(게이트웨이는 `migrate:backfill` → `migrate:apply` 로 **나눠 친다** — 아래 각 README).
`.env` 의 `CLOUDFLARE_API_TOKEN` 이 없으면 콘솔은 **아예 뜨지 않는다** — 로컬 사본이 없다.
각 디렉토리 README에 설계 근거(공개 게이트·키셋 커서·2층 제한·폐기와 삭제의 구분 등)가 있다.

## 상태

콘솔은 `ops.ask-seoul.kr` 로 배포된다 — **`dev` 브랜치 머지가 곧 운영 배포다**
(브랜치 이름과 배포 환경이 다르다). 읽기 경로는 아직 무인증이고 Cloudflare Access 승격
(#20 B-1)이 남아 있다. 게이트웨이도 2026-08-06 에 운영 D1 로 전환됐고(#85), 같은 날 팀 합의로 `dev.ask-seoul.kr` 배포면을 접었다 — 남는 배포면은 `ask-seoul.kr`·`ops.ask-seoul.kr` 둘이다.
