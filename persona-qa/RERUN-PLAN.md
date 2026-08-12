# 페르소나 재실측 준비 (2026-08-11) — 준비 완료, 실행 대기

> 목적: ASK-Seoul#116 보완 8건(시간표 신설·지명 축·caveat 등) 반영 후
> **정확률이 얼마나 올랐는지** 1차(2026-08-11 오전, 231문항)와 비교 측정.
> 이 문서는 준비 상태 기록 — 실행은 아직 하지 않았다.

## 준비 완료된 것

- [x] **1차 결과 백업**: `out-v1-20260811/` (answers 231건 포함 전체 사본).
  러너(03)는 `out/answers/`에 파일이 있으면 그 문항을 건너뛰므로(이어가기 로직),
  재실측 직전에 `out/answers/`를 비워야 한다 — 백업이 있으니 안전.
- [x] **질문 세트 고정**: `out/questions.json` 231문항을 **그대로 재사용**한다.
  같은 질문 → 전후 비교가 깨끗하다. 02(질문 생성)는 다시 돌리지 않는다.
- [x] **카탈로그 확인**: 공개 카탈로그 60제품 — 신규 시간표 2종
  (`transit_bus_route_timetable`, `transit_subway_timetable`) 노출 확인.
- [x] **transit 반영 확인**: 시간표 2제품 + caveat + 리뷰 수정(급행·첫차 교정)까지
  D1 발행 완료(published 4/4, 8/11).

## ⚠️ 실행 시점 판단 — 지금 돌리면 transit 개선만 측정된다

발행(D1 반영)은 도메인 담당자 환경에서 하므로, 이 시점의 반영 현황:

| 도메인 | 보완 내용 | D1 반영 |
|---|---|---|
| transit | 버스·지하철 시간표 2제품, 새벽 caveat | ✅ 완료 |
| citydata | 금천구 관측 공백 caveat | ⏳ 담당 환경 발행 대기 |
| culture | 공연 위치(자치구·동·좌표)·tour_city·caveat | ⏳ 담당 환경 발행 대기 |
| traffic | 도로명·자치구 축 3제품 | ⏳ 담당 환경 배포+발행 대기 (선행: 23cf952 silver, DBT#507 코멘트) |

**권장**: citydata·culture·traffic 담당자 발행 후 전체 재실측 1회가 가장 경제적.
transit 효과만 먼저 보려면 transit 문항 45건만 부분 재실측(아래 옵션 B).

## 실행 설계 (1차와 달라지는 것)

- **모델 통일**: 1차는 혼합(cli-default 41 + sonnet + haiku)이라 모델 효과가 지배적이었다.
  이번엔 `MODEL=claude-sonnet-5` 고정 → 비교 기준은 1차 verdicts 전체가 아니라
  **1차 sonnet 실측분 + 판정 라벨 분포**로 삼고, 모델 요인은 리포트에 명시.
- **판정(04)·리포트(05·06)는 동일 스크립트** — 루브릭 불변이라 라벨 비교 가능.
- 쿼터: 231문항 × 1~5회 ≈ 최대 1,155회. 일일 한도 1,000 → 하루로 부족하면
  이틀 분할(러너가 이어가기 지원). 부분 재실측(45건)이면 ~225회로 여유.

## 실행 절차 (준비된 명령 — 아직 실행 금지)

```bash
cd persona-qa && export PYTHONUTF8=1

# 0) 재실측 공간 확보 (백업은 이미 out-v1-20260811/ 에 있음)
# 옵션 A — 전체 231건 재실측:
rm out/answers/*.json
# 옵션 B — transit 관련 45건만 재실측 (id 목록은 준비 단계에서 생성해 둠 —
#   1차 tool_path의 transit 제품 사용 ∪ 질문 키워드. 1차 리포트의 transit n=45와 일치):
#   python -c "import json,io,os; [os.remove(f'out/answers/{i}.json') for i in json.load(io.open('rerun-transit-ids.json',encoding='utf-8')) if os.path.exists(f'out/answers/{i}.json')]"

# 1) 테스트 키 발급 (전용 이메일 — 본인 이메일 금지, PLAN §4)
curl -X POST https://ask-seoul.kr/api/v1/keys -H "Content-Type: application/json" \
  -d '{"email":"persona-qa-test@example.com"}'
export ASK_SEOUL_KEY=ask_...

# 2) 실측 → 채점 → 리포트
MODEL=claude-sonnet-5 python scripts/03_run_queries.py
python scripts/04_judge.py
python scripts/05_report.py
python scripts/06_detail_table.py

# 3) 키 완전 삭제 — 생략 금지
curl -X DELETE 'https://ask-seoul.kr/api/v1/keys?purge=true' -H "Authorization: Bearer $ASK_SEOUL_KEY"

# 4) 전후 비교 — 1차는 out-v1-20260811/verdicts.json, 2차는 out/verdicts.json
#    특히 transit 45문항의 판정 라벨 이동(되물음·데이터없음 → 정상)을 본다.
```

## 실행 전 체크리스트 (그날 확인)

- [ ] citydata·culture·traffic 발행 여부 (담당자에게 확인 — 미발행이면 옵션 B로)
- [ ] 콘솔 담당자에게 실행 시간대 공유 (운영 지표 오염 사후 분리용, PLAN §4)
- [ ] 일일 쿼터 잔량 확인
- [ ] `out/answers/` 비우기 (위 0단계)

## 기대 관측 포인트

- transit 되물음 13건·데이터없음 19건 중 시간표 질문들 → 정상 전환 여부
- "막차/첫차" 질문에 새 caveat(2호선 미포함·공표 기준)이 인용되는지
- (발행 후) traffic 지명 질문 6건, culture 위치 질문, 금천구 대기질 질문의 라벨 이동
