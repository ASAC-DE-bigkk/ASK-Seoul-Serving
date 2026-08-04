# ops-dashboard 개발 지향 방향

이 문서는 **어디로 가는가**를 적는다. 현재 구조가 왜 이 모양인지는 [decision/](index.md#결정--docsdecision),
방법 일반론은 [reference/](index.md#참조--docsreference)에 있다. 방향이 바뀌면 이 문서를 먼저 고친다.

## 현재 위치

로컬 전용 품질 콘솔. 한 화면에서 파이프라인 품질(`_ops_slo`)·서빙 품질(`_request_log`)·
키 관리(`_keys`)를 본다. 실측이 말해주는 현주소:

- **SLO 마트를 가진 도메인은 1 / 6** (culture뿐, 2026-07-28 실측) — 나머지 5개는 품질을
  잴 수단 자체가 없다.
- 파이프라인 실행 기록은 팀 규약(ASK-Seoul#78)으로 표준화되어 조회 DB(D1) 적재가
  시작됐다(ASAC-DAG#647·#655, 2026-08-02 이후분부터).

## 지향 — 관측의 소비자이자, 관측 공백을 드러내는 장치

이 콘솔의 존재 이유는 두 가지다.

1. **팀이 이미 쌓는 관측을 사람이 볼 수 있게 한다.** 기록이 저장소·DB에 쌓여도 읽는
   화면이 없으면 "어제 잘 돌았나"에 답할 곳이 없다.
2. **관측이 없는 곳을 없는 그대로 드러낸다.** `1 / 6` 같은 숫자, 단계(`layer`) 미기록
   건수, "미확인 ≠ 정상"(#78 C-9) — 콘솔은 공백을 채워서가 아니라 **보여줘서** 팀을 움직인다.

## 발전 축

### 축 1 — 운영 기록 소비 (ASK-Seoul#78 적용 순서의 "3단계: 대시보드 데이터 연결")

조회 DB 4종(`_ops_run_event`·`_ops_daily_metric`·`_ops_pipeline_state`·`_ops_pipeline_expectation`)을
콘솔이 읽어, 규약 D-7이 열거한 지표(성공률·재시도로 살림·빈 실행·지연·NULL 비율·멈춘
파이프라인)를 화면으로 만든다. 스키마 정본은 ASAC-DAG(`common/ops/d1_ops.py`)이고
콘솔은 **읽기 전용 소비자**다.

### 축 2 — SLO 실적재 정규화

`_ops_slo` 실적재를 culture DAG 의 export task 로 올린다(팀 D1 쓰기 = 승인 주체 미정(agreement §8-3)).
나머지 도메인의 SLO 마트는 각 도메인 담당의 몫이며, 콘솔은 그때까지 `1 / 6`을 계속 보여준다.

### 축 3 — 인증 승격

공유 토큰(`OPS_TOKEN`)은 "누가 했나"가 안 남는다. 공개 배포 시 Cloudflare Access /
org OAuth로 **교체 필수**, 그때 운영자 감사 로그를 함께 도입한다
(→ [0004](decision/0004-read-open-write-token.md)).

## 승격 단계

```text
지금: 로컬 전용 (wrangler dev, 공유 로컬 D1)
  → 팀 검증: 팀원이 로컬에서 띄워 보고 화면·지표 합의
  → 배포 결정: 공개 URL + 팀 D1 읽기 (agreement §8)
  → 공개: Access 인증 + 감사 로그 + 증분 마이그레이션 체제
```

각 단계 전환은 [decision/0002](decision/0002-local-only-mentor-gate.md) 개정으로 기록한다.

## 하지 않을 것

- **게이트웨이 기능 흡수** — 발급·쿼터·데이터 서빙은 마켓플레이스 소관
  ([0001](decision/0001-separate-worker-from-marketplace.md)).
- **알림 채널 신설** — 콘솔은 조회 전용. 푸시는 Airflow 콜백(DB 기반, #78 C-8) 소관.
- **[0008](decision/0008-deferred-scope.md)의 목록 전부** — 도입 신호가 실측되기 전에는.
