# 페르소나 기반 데이터 품질 테스트 기획안

> ✅ **실행 완료 (2026-08-11)** — 201문항 실측·채점·집계 완료. 결과는 §0 요약,
> 상세는 `out/report.md`·`out/summary.json`·대시보드(Artifact) 참조.
> 2026-08-10 · persona-qa (레포 미추적 작업 디렉토리 — 커밋 여부는 팀 판단)
> NVIDIA [Nemotron-Personas-Korea](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea)
> (CC BY 4.0)를 가상 사용자 집단으로 삼아, 공개 57종 데이터 제품이
> **다양한 실존형 시민의 질문**을 얼마나 받아내는지 측정한다.

## 0. 결과 요약 (2026-08-11)

- 표본: 페르소나 67명(50 + 검증 17) · 질문 201건 · 실측 실패 0.
- **커버리지 52.2%** (정상 105) · **근거성 91.5%** · 유용성 3.13/5.
- **최대 발견: 소비 모델 효과가 지배적** — 같은 MCP 인데 기본 모델 88% vs Haiku 44%.
  환각의심 7건 전부 Haiku. → 하위 모델 소비자 대비 가드레일(해상도 명시 등)이 다음 과제.
- 1차에서 보인 연령 기울기는 Haiku 통일 검증 표본에서 **재현 안 됨** — 연령·지역
  체계적 소외의 증거 없음(현 표본 기준).
- 간극(백로그 후보): 예보류 25 · 경로·환승·시간표 21 · 행사·문화 20 · 상권 상세 14 ·
  동 단위 해상도 13 · 실시간 4.
- 과금 쿼터 사용: 2일 합계 452회(각 일일 한도 1,000 내).

## 1. 왜 하나 — 기존 품질 체계의 빈칸

이 레포의 품질 측정은 이미 4개 층이 있다:

| 층 | 무엇 | 어디 |
|---|---|---|
| 게시 게이트 | 행수·PK·신선도 SLO·커버리지·권리 증거로 제품 차단 | `marketplace/src/skill.js` (`d1_product_quality`) |
| 파이프라인 SLO | 도메인×일 단위 적재 품질 | `ops-dashboard` `_ops_slo` |
| MCP 가드레일 | data_context 동봉 + 환각 함정 평가(trap 3건) | `marketplace/scripts/mcp-eval.json` |
| 대표질문 실측 | 제품당 `product_question` 1건을 headless Claude + 원격 MCP 로 실측 | `marketplace/docs/mcp-eval-57.md` |

전부 **공급자 관점**이다 — 제품이 스스로 정의한 질문(product_question)에는 답한다.
없는 것은 **"누가 묻느냐"의 다양성**이다: 70대 서초구 회계 사무원과 20대 관악구
대학생은 같은 데이터에 다른 질문을 던진다. 이 테스트는 그 수요 관점 간극을 잰다.

`a75be9b` 커밋이 숙제로 남긴 "실측 A/B(같은 질문 세트로 왕복 수·신선도 인용률·
지어내기 0 비교)"의 질문 세트로도 재사용할 수 있다.

## 2. 데이터 소스 (실측 확인 완료)

- **페르소나**: `nvidia/Nemotron-Personas-Korea` train 100만 건 중
  `province='서울'` **185,228건** (HF datasets-server `/filter` API, 다운로드 불필요).
  필드: persona(서사)·sex·age·occupation·district(자치구)·education_level·
  marital_status·hobbies 등 26종.
- **대상**: `https://ask-seoul.kr` 공개 카탈로그 57제품
  (commerce 22 · citydata 14 · culture 7 · traffic 6 · transit 4 · weather 4).
- **경로**: 원격 MCP `https://ask-seoul.kr/mcp` — mcp-eval-57 과 동일 방법론.

## 3. 파이프라인 (5단계)

```
01 샘플링 → 02 질문 생성 → 03 MCP 실측 → 04 채점 → 05 리포트
```

### 01. 층화 샘플링 — 페르소나 50명
`scripts/01_sample_personas.py` · 출력 `out/personas.json`

- 연령대 5구간(20대/30대/40대/50-64/65+) × 각 10명, 성별 5:5.
- 자치구 최소 15개, 직업 중복 최소화(그리디).
- 시드 고정(42) — 재현 가능.

### 02. 질문 생성 — 페르소나당 3문항 = 150문항
`scripts/02_generate_questions.py` · 출력 `out/questions.json`

- 페르소나 서사·속성을 주고 **"이 인물이 서울 생활에서 실제로 궁금해할 질문"**을
  생성. 6개 도메인(상권·도시데이터·문화·교통·대중교통·날씨)은 힌트로 주되
  **57개 제품 목록은 주지 않는다** — 카탈로그를 모르는 진짜 수요를 흉내내기 위함.
  (제품을 알려주면 커버리지 측정이 무의미해진다.)
- 생성 모델: claude-sonnet-5 (비용 절약 — 생성은 쉬운 작업).

### 03. MCP 실측 — 150문항 실행
`scripts/03_run_queries.py` · 출력 `out/answers/*.json`

> ⚠️ 실측 조건 변경(2026-08-10): 기본 모델로 41건 실측 후 Claude 세션 한도로 중단 →
> 나머지 109건은 `MODEL=claude-sonnet-5` 로 재실행. 각 결과 파일의 `model` 필드로
> 구분 가능(기록 없음 = cli-default). 집계 시 모델별 분리 확인.

- 문항마다 headless Claude(`claude -p`, stream-json)에 원격 MCP 만 붙여 실행.
  mcp-eval-57 과 동일하게 질문을 그대로 던진다. 툴 호출 경로를 스트림에서 추출.
- 지침은 한 줄만: "데이터에 없으면 없다고 말하라" (trap 평가와 같은 기준).

### 04. 채점 — 3축 루브릭
`scripts/04_judge.py` · 출력 `out/verdicts.json`

| 축 | 정의 | 근거 |
|---|---|---|
| **coverage** | 답할 제품에 실제로 도달했나 (`query_product`/`run_pattern` 성공 여부 + 판정) | 툴 경로 |
| **groundedness** | 데이터·data_context 에 근거했나, 한계를 밝혔나 (지어내면 FAIL — trap 기준 재사용) | 답변 본문 |
| **usefulness** | 페르소나 관점에서 실질적 도움 1–5점 | LLM 판정자 |

- 판정 라벨은 mcp-eval-57 의 정상/되물음을 확장:
  `정상 / 되물음 / 데이터없음(정직) / 환각의심 / 오류`.
- 데이터 정합성(빈 행·null·신선도)은 게시 게이트가 이미 제품 단위로 재므로
  중복 측정하지 않는다 — 여기서는 **"게이트는 통과했는데 질문엔 못 답하는" 간극**
  (자치구 누락·필터 축 부족·제품 부재)만 본다.

### 05. 리포트
- 페르소나 축(연령×자치구×직업)별 커버리지 히트맵, 제품별 도달·유용성 점수,
  미커버 질문 목록(= 수요는 있는데 제품이 없는 곳 = 백로그 후보).
- 산출물: `out/report.md` + Artifact 대시보드(시각화).

## 4. 운영 주의 (이 레포 특유)

- 🔴 **원격 호출은 전부 운영이다.** MCP `tools/call` 부터 Bearer 키 필요 →
  **전용 이메일로 키 1개 발급, 끝나면 `DELETE /api/v1/keys?purge=true` 로 완전 삭제.**
  사용자 본인 이메일로 발급하지 않는다(이메일당 1키 — 기존 키가 rotate 로 즉시
  무효화되는 사고 방지).
- 쿼터: 150문항 × 문항당 조회 1~5회 ≈ 최대 750회. 일일 쿼터 확인 후 필요하면
  이틀에 나눠 실행. 429 시 스크립트가 Retry-After 를 존중하고 이어서 실행.
- 요청 로그 오염: 원격 호출은 `ASK_ENV` 태그가 없으므로 운영 지표에 섞인다.
  실행 전 콘솔 담당자에게 실행 시간대를 공유한다(사후 스코프 분리 가능하게).
- 스키마·DDL 은 일절 건드리지 않는다(읽기 전용 테스트).

## 5. 비용·시간 추정

| 단계 | 호출 | 추정 |
|---|---|---|
| 02 생성 | sonnet 50회 | 수 분·저비용 |
| 03 실측 | headless Claude 150회(각 2~6 툴 호출) | 1~2시간(직렬)·중간 비용 |
| 04 채점 | sonnet 150회 | 수십 분·저비용 |

## 6. 실행 순서 (준비 완료 상태에서)

```bash
cd persona-qa && export PYTHONUTF8=1

# 0) 테스트 키 발급 (전용 이메일 — 본인 이메일 금지, PLAN §4)
curl -X POST https://ask-seoul.kr/api/v1/keys -H "Content-Type: application/json" \
  -d '{"email":"persona-qa-test@example.com"}'        # 응답의 key 를 복사
export ASK_SEOUL_KEY=ask_...

python scripts/01_sample_personas.py      # ✅ 실행 완료 — out/personas.json (50명)
python scripts/02_generate_questions.py   # 페르소나당 3문항 → out/questions.json
python scripts/03_run_queries.py          # 150건 실측 → out/answers/ (중단 시 재실행하면 이어감)
python scripts/04_judge.py                # 채점 → out/verdicts.json

# 마지막) 키 완전 삭제 — 생략 금지
curl -X DELETE 'https://ask-seoul.kr/api/v1/keys?purge=true' \
  -H "Authorization: Bearer $ASK_SEOUL_KEY"
```

인자로 개수 제한 가능: `python scripts/02_generate_questions.py 5` (5명만).
02·03·04 전부 이어하기 지원 — 중간에 끊겨도 다시 실행하면 안 한 것만 한다.

## 7. 완료 기준

- [ ] 150문항 전부 실측 + 판정 기록 (실패는 실패로 기록, 누락 없음)
- [ ] 커버리지·groundedness·usefulness 집계가 페르소나 축별로 나옴
- [ ] 미커버 질문 목록(백로그 후보)이 정리됨
- [ ] 테스트 키 purge 완료 확인
- [ ] 리포트 + 대시보드 산출
