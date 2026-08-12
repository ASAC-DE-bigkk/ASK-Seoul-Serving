# v4 실측 설계 (2026-08-12) — "숫자에 근거를 붙인다"

> 1~3차는 결과를 보여줄 수는 있어도 **"어떻게 계산했나"·"그 판정을 믿을 수 있나"** 에
> 답하지 못했다. v4 는 그 두 질문에 답하도록 설계를 바꾼 회차다.
> 기존 회차의 계산 근거는 [`out/METHOD.md`](out/METHOD.md).

## 표본

| | v3 | **v4** |
|---|---|---|
| 페르소나 | 20명 | **40명** (전원 신규, 기존 97명 제외) |
| 문항 | 60건 | **120건** (페르소나당 3문항) |
| 실측 모델 | claude-sonnet-5 | claude-sonnet-5 (동일) |
| 판정자 | claude-haiku-4-5 | claude-haiku-4-5 (동일) |
| 시드 | 20260812 | 202608124 |

표본을 2배로 키운 이유는 **신뢰구간**이다. n=60에서 커버리지 65%의 95% 구간은 52.4~75.8%로
±12%p였고, 그래서 2차(48.3%)와 3차(65.0%)의 구간이 겹쳐 "3차가 더 낫다"를 통계적으로
말할 수 없었다. n=120이면 같은 비율에서 구간이 약 ±8.5%p로 좁아진다.

## 바뀐 것 ① 측정 격리 — 1~3차의 실제 결함을 고쳤다

`03_run_queries.py` 는 `--allowedTools mcp__askseoul__*` 로 MCP 만 쓰게 했다고 믿었지만,
**`--allowedTools` 는 '자동 승인' 목록이지 '사용 가능' 목록이 아니다.** 실행 로그를 다시 세어보니:

| | 로컬 툴이 개입한 문항 | 어떤 툴 |
|---|---|---|
| 1차 | **35.5% (82/231)** | Bash 73 · PowerShell 20 · Agent 14 · Write 11 · Grep 11 · Read 9 |
| 2차 | 3.3% (2/60) | Bash 2 · Grep 1 |
| 3차 | 6.7% (4/60) | Bash 4 외 |

실측 세션이 로컬 파일시스템을 뒤졌다는 뜻이고, 최악의 경우 **저장소에 있는 카탈로그 JSON을
직접 읽고 답했을 수도 있다.** 그러면 "MCP 데이터로 답했다"는 전제 자체가 깨진다.

**v4 는 로컬 툴을 명시적으로 차단한다:**

```python
BLOCKED_TOOLS = ["Bash", "PowerShell", "Read", "Write", "Edit", "Grep", "Glob",
                 "Agent", "Task", "Skill", "WebFetch", "WebSearch", "NotebookEdit"]
```

**`ToolSearch` 는 일부러 남겼다.** 지연 로딩된 MCP 툴 스키마를 불러오는 경로라, 이것까지
막으면(`--tools ""`) MCP 호출이 0건이 되고 모델이 조회 없이 "조회하겠습니다"라고만 답한다
(실측 확인). `AskUserQuestion` 도 남겼다 — '되물음'은 유효한 판정 라벨이다.

격리 설정은 문항마다 `answers/*.json` 의 `isolation` 필드에 기록된다. 로그가 아니라
**산출물만 보고** 이 회차가 정말 MCP 만 썼는지 확인할 수 있다.

> ⚠️ **이 수정 때문에 v4 는 1~3차와 조건이 또 달라진다.** 다만 이번 변경은 "측정을 원래
> 의도대로 되돌린 것"이므로, 커버리지가 내려가더라도 그게 더 정확한 값이다.

## 바뀐 것 ② 판정 이유를 저장한다

1~3차 판정자는 라벨만 뱉었다. "이 문항은 왜 데이터없음인가요"에 답하려면 답변 본문을
직접 읽어야 했다. v4 부터 `rationale` 을 함께 받는다.

**단, JSON 키 순서를 `verdict → grounded → usefulness → gap → rationale` 로 고정한다.**
모델은 앞에서부터 토큰을 생성하므로, 이유를 먼저 쓰게 하면 그 추론이 라벨을 바꿔 1~3차와
라벨 분포를 비교할 수 없게 된다. 라벨을 먼저 확정시키고 이유를 뒤에 붙이면 판정 절차 자체는
이전 회차와 동일하게 유지된다.

판정자 메타(`_judge`)도 문항마다 남긴다 — 모델·프롬프트 해시·시각·소요시간.
1~3차에는 이 기록이 없어서 "누가 채점했나"를 코드에서 역추적해야 했다.

## 바뀐 것 ③ 판정 신뢰도를 실제로 측정한다

지금까지 "LLM이 판정한 걸 믿을 수 있나요"에 대한 근거는 하나뿐이었다 —
툴 로그와 교차했을 때 "조회도 안 했는데 정상" 판정이 0건이라는 간접 증거.
v4 는 세 가지를 직접 잰다. 대상은 **판정 라벨별 비례로 뽑은 층화 표본 40건**
('정상'만 뽑히면 검증이 되지 않는다).

| 측정 | 방법 | 답하게 되는 질문 |
|---|---|---|
| **재채점 일치율** | 같은 haiku 로 40건 재채점 | "두 번 돌리면 같나요" |
| **교차판정 일치율** | sonnet-5 로 같은 40건 채점 | "더 좋은 모델이 봐도 같나요" |
| **사람 검수 일치율** | 층화 20건 CSV 시트를 사람이 채움 | "사람이 봐도 같나요" — 가장 강력 |

**Cohen's κ 를 함께 낸다.** 라벨이 '정상'에 쏠려 있으면 아무 판정자나 단순 일치율이 높게
나오므로, 우연 일치를 걷어낸 값이 필요하다. 불일치가 **어느 라벨 쌍에서** 나는지도 함께
기록한다 — 일치율 한 숫자로는 개선 방향을 알 수 없다.

## 산출물

```
out/v4-20260812/
  personas.json · questions.json        표본과 문항
  excluded-uuids.json                   제외한 97명 (1·2차 77 + 3차 20)
  answers/                              원자료 (isolation 필드 포함)
  verdicts.json                         기본 판정 (haiku, rationale·_judge 포함)
  verdicts-rejudge.json                 재채점 (haiku, 40건)
  verdicts-sonnet.json                  교차판정 (sonnet, 40건)
  sample40.json                         층화 표본 ID 목록
  human-review-20.csv                   사람 검수 시트 (사람이 채움)
  reliability.json                      일치율·κ·불일치 내역
  report.md · summary.json              집계 (분자/분모·CI 병기)
  metrics.json                          근거 레이어
  detail-table.csv · detail.json        문항별 전문
```

## 실행 순서

```bash
python scripts/v4_sample40.py                         # 40명 (HF only, LLM 호출 없음)
python scripts/02_generate_questions.py v4-20260812   # 120문항 (LLM 40회)
ASK_SEOUL_KEY=... python scripts/03_run_queries.py v4-20260812   # 실측 120건 ← 가장 비싸다
python scripts/04_judge.py v4-20260812                # 기본 판정 120건

python scripts/08_reliability.py v4-20260812 --sample 40
python scripts/04_judge.py v4-20260812 --out verdicts-rejudge.json --only sample40.json
python scripts/04_judge.py v4-20260812 --model claude-sonnet-5 \
       --out verdicts-sonnet.json --only sample40.json
python scripts/08_reliability.py v4-20260812 --human-sheet 20     # 사람이 채울 시트
python scripts/08_reliability.py v4-20260812                      # 일치율 계산

python scripts/05_report.py v4-20260812                # 이하 LLM 호출 없음
python scripts/06_detail_table.py v4-20260812
python scripts/07_metrics.py v4-20260812
```

## v4 로도 답할 수 없는 것

- **회차 간 개선폭**. 격리 수정 때문에 v4 는 또 조건이 다르다. 개선폭을 인용하려면
  같은 조건으로 두 번 재야 한다.
- **1~3차 수치의 소급 정정**. 로컬 툴이 개입한 문항이 실제로 오염된 답을 냈는지는
  답변 본문을 문항별로 읽어야 알 수 있고, 자동 판정할 방법이 없다.
- **gap 자유 텍스트의 정확한 집계**. 같은 원인이 다른 문장으로 적혀 빈도가 과소계상된다.
