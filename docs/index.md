# docs — 공동 문서 지도

**두 프로젝트가 함께 관리하는 문서**들이다. 한쪽만 바꾸면 규약이 아니라 예외가 되므로,
여기 있는 문서를 고치면 상대 담당자에게 알린다.

프로젝트별 문서는 각자의 지도를 본다 —
[ops-dashboard/docs/index.md](../ops-dashboard/docs/index.md) ·
[marketplace/docs/](../marketplace/docs/).

## 실행 — 환경별 매뉴얼

**"지금 어느 환경에서 무엇을 할 수 있나"** 를 환경마다 한 장씩 적었다. 셋의 차이는
플래그가 아니라 **쓰기가 되느냐**다.

| 매뉴얼 | D1 | 플래그 | 쓰기 | 언제 |
|---|---|---|---|---|
| [run-local.md](run-local.md) | 로컬 sqlite (공유) | 없음 — **기본** | ✅ 가능 | 평소 개발·조치 |
| [run-remote-dev.md](run-remote-dev.md) | 팀 `ask-seoul-dev-d1` | `--remote --env dev` | 🔒 잠김 | 운영 기록 4종 **실측**을 볼 때 |
| [run-prod.md](run-prod.md) | `ask-seoul-prod-d1` | `--remote --env production` | 🔒 잠김 | 운영 데이터를 눈으로 확인할 때 |

**플래그가 없으면 언제나 로컬이다.** 이 방향이 핵심이다 — 빠뜨린 실수는 로컬로 떨어지고
(안전), 원격을 건드리려면 명시적 의도가 필요하다.

원격 둘의 잠금은 **경고문이 아니라 코드**다
([ops-dashboard decision/0013](../ops-dashboard/docs/decision/0013-remote-readonly-attach.md)).
어느 쪽도 **배포가 아니다** — 워커는 내 노트북에서 돌고 D1 만 팀 것에 붙는다.

> ⚠️ **게이트웨이(marketplace)는 원격 확인 경로가 아직 없다.** `_burst`·`_usage`·
> `_gateway_request_log` 때문에 모든 요청이 D1 에 써서 "보기 전용"이 성립하지 않는다.
> 계량 경로를 어떻게 할지는 **게이트웨이 담당자의 판단**이다.

## 규약 — 무엇이 어디에 있나

| 문서 | 내용 |
|---|---|
| [agreement.md](agreement.md) | **합의 정본** — 수집 축·소유 경계·환경·배포·MCP + **폐기된 안**. 이슈를 다시 뒤지기 전에 먼저 본다 |
| [environments.md](environments.md) | 환경 **구조** — 설정을 어디에 두나, 무엇이 환경마다 달라지나, 함정 셋 |
| [setup.md](setup.md) | OS별 사전 준비 — Node 설치, Windows 인코딩·PATH 함정, 증상표 |
| [change-log.md](change-log.md) | **변경 이력** — 언제 무슨 의도로 코드에 닿았나 (날짜·작업자·의도·조치·결과) |

**environments.md 와 실행 매뉴얼의 관계**: 저쪽은 *구조와 배분*("왜 한 파일 안에서 갈리나"),
여기 셋은 *절차*("무엇을 어떤 순서로 치나"). 규약을 바꾸면 저쪽이 먼저다.

## 갱신 규칙

- 새 문서를 만들면 **이 인덱스에 한 줄 추가**한다.
- 실행·시드·포트·비밀값 규약을 바꾸면 **같은 커밋에서** 해당 매뉴얼을 고치고 상대 담당자에게 알린다.
- 코드를 고쳤을 때 어느 문서를 같이 여는지는
  [ops-dashboard CLAUDE.md 7-1 대응표](../ops-dashboard/CLAUDE.md)가 정본이다.
