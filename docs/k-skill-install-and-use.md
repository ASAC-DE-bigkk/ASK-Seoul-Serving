# K-Skill 설치·사용 가이드 — `seoul-weather-risk`

`seoul-weather-risk`는 ASK 서울의 `weather_place_risk_window` 단일 제품을 읽어 서울 행정동별 기상 위험 예상 시간대를 설명하는 읽기 전용 skill이다. 결과는 예보값 기반 참고 정보이며 기상청 공식 특보가 아니다.

## 빠른 시연

브라우저에서 `/skill-demo`를 연다. 이 페이지는 다음을 한 흐름으로 제공한다.

1. Codex 또는 Claude Code에 standalone artifact 설치
2. Marketplace API Key로 운영 bundle/product/data readiness 확인
3. `publication_id`, `row_count`, `request_id` 확인
4. 자연어 질문을 설치된 AI에 전달

페이지의 password input 값은 현재 탭의 JavaScript 메모리에서만 사용한다. storage, URL, 로그, 설치 명령과 복사 프롬프트에는 포함하지 않는다.

## 설치

발표용 설치 URL은 ASK-Seoul-Serving의 artifact 전용 commit에 고정한다.

```bash
# Codex
npx skills add https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/archive/7203c869380f2907175919733b3282742767cbc6.tar.gz \
  --global --agent codex --copy --yes

# Claude Code
npx skills add https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/archive/7203c869380f2907175919733b3282742767cbc6.tar.gz \
  --global --agent claude-code --copy --yes
```

이 artifact의 `SKILL.md`와 helper는 runtime에 `npx` 또는 `@nomadamas/k-skill`을 다시 호출하지 않는다. source commit과 exported file hash는 `skills/seoul-weather-risk/provenance.json`에서 확인한다.

## 등록 전 local-direct 설정

K-Skill hosted proxy 등록 전에는 AI를 실행할 프로젝트의 로컬 `.env`에서 명시적으로 direct 모드를 켠다.

```dotenv
KSKILL_LOCAL_DIRECT=1
ASK_SEOUL_SKILL_API_BASE_URL=https://ask-seoul.kr
MARKETPLACE_API_KEY=<PASTE_LOCALLY>
```

키 원문을 명령행 인수, 채팅, 문서, 로그에 넣지 않는다. `/skill-demo`에 입력한 값은 로컬 AI 환경으로 자동 전달되지 않으므로 `.env`에는 사용자가 직접 저장한다.

## 자연어 질문

내부 `place_id` 대신 행정동 이름을 사용한다.

```text
성수2가3동의 이번 주 기상 위험 시간대를 알려줘.
잠실본동에서 오늘 이동할 때 주의할 날씨 시간대를 알려줘.
강남구 신사동의 내일 폭염·호우·강풍 후보를 근거와 함께 알려줘.
```

정식 행정동 이름을 먼저 사용하고, mapping에서 결정적으로 생성된 표기 변형만 허용한다. 동명이 있는 경우 자치구를 함께 묻고, `성수동` 같은 생활권·부분 이름이나 오타를 추측하지 않는다.

## 직접 helper 확인

설치된 skill 디렉터리에서 실행한다.

```bash
python scripts/seoul_weather_risk.py preflight
python scripts/seoul_weather_risk.py catalog
python scripts/seoul_weather_risk.py describe --product-id weather_place_risk_window
python scripts/seoul_weather_risk.py query \
  --product-id weather_place_risk_window \
  --admin-dong 성수2가3동 \
  --from 2026-08-10 --to 2026-08-16 --limit 100
```

응답에서 `registration_ready`, `blockers`, `publication_id`, `forecast_at`, `row_count`, `request_id`를 확인한다. `registration_ready=false` 또는 zero-row를 정상 답변으로 바꾸지 않는다.

## 실패별 처리

| 상태 | 처리 |
| --- | --- |
| 401 | 키 누락·오입력을 확인하고 다시 입력한다. |
| 403 | 폐기 또는 scope 부족이므로 새 사용자 키를 사용한다. |
| 404 | 배포본과 exact-one product 경로를 확인한다. |
| 409 | publication이 바뀐 cursor이므로 bundle/product부터 다시 읽는다. |
| 429 | `Retry-After` 이후 재시도한다. |
| 503 | blocker가 해소될 때까지 live 답변을 차단한다. |
| network | HTTPS origin과 연결 상태를 확인한다. |
| zero-row | 빈 결과로 설명하고 위험이 없다고 단정하지 않는다. |

## 운영 검증

로컬 secret 환경을 로드한 뒤 다음 명령으로 key 원문을 출력하지 않고 운영 API를 확인한다.

```bash
cd marketplace
npm run smoke:skill-demo
```

성공 출력에는 `publication_id`, `row_count`, bundle/product/data의 request ID만 포함한다.
