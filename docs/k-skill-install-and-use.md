# K-Skill 설치·사용 가이드 — `seoul-weather-risk`

`seoul-weather-risk`는 ASK 서울 Marketplace의
`weather_place_risk_window` 제품을 hosted `k-skill-proxy`로 읽는 조회 전용 스킬이다.
장소별 폭염·한파·호우·대설·강풍 후보를 예보 임계값으로 선별해 보여 주며, 기상청의
공식 특보를 대체하지 않는다.

## 사용 가능 시점

이 스킬은 [upstream PR #552](https://github.com/NomaDamas/k-skill/pull/552)의 병합과 npm
배포 뒤 일반 설치 목록에 포함된다. 그 전에는 공식 `@nomadamas/k-skill` CLI에 helper asset이
없을 수 있으므로, 포크 경로나 임시 복사본을 일반 사용자 설치 경로로 안내하지 않는다.

## 사전 준비

- Node.js 18 이상과 `npx`가 필요하다.
- Marketplace 사용자 API Key, 별도 Vault 설치, k-skill proxy 서비스 키는 필요하지 않다.
- 서비스 키는 k-skill-proxy 운영 서버에만 보관한다. 사용자 환경·명령행·채팅·문서에 넣지
  않는다.

```bash
node --version
npx --version
```

## 설치

upstream 배포가 완료된 뒤 아래 명령으로 전역 설치한다.

```bash
npx --yes skills add NomaDamas/k-skill --skill seoul-weather-risk -g
```

설치된 instruction과 helper 목록은 다음처럼 확인한다.

```bash
npx -y @nomadamas/k-skill@0 instruct seoul-weather-risk
npx -y @nomadamas/k-skill@0 files seoul-weather-risk
```

`instruct`가 보여 주는 최신 instruction을 우선한다. npm cache 내부 경로를 직접 찾거나
helper를 임의로 복사하지 않는다.

## 사용 방법

설치 뒤 에이전트에게 `seoul-weather-risk` 스킬로 조회를 요청한다. 질문에는 가능한 경우
게시된 `place_id`와 확인할 예보 기간을 함께 준다. 현재 스킬은 장소 이름을 임의로
`place_id`로 변환하지 않는다.

```text
seoul-weather-risk 스킬로 place_id=<게시된 place_id>의 2026-08-10부터 2026-08-12까지
기상 위험 예상 시간대, 위험 유형, 판정 근거를 조회해줘. 기상청 공식 특보가 아닌
예보 기반 참고 정보라는 점도 함께 알려줘.
```

CLI로 호출해야 하는 경우에는 instruction에 나온 helper를 그대로 사용한다.

```bash
# 네트워크 호출 없이 proxy 모드 확인
npx -y @nomadamas/k-skill@0 exec seoul-weather-risk \
  scripts/seoul_weather_risk.py -- preflight

# 제품 준비 상태와 metadata 확인
npx -y @nomadamas/k-skill@0 exec seoul-weather-risk \
  scripts/seoul_weather_risk.py -- catalog
npx -y @nomadamas/k-skill@0 exec seoul-weather-risk \
  scripts/seoul_weather_risk.py -- describe \
  --product-id weather_place_risk_window

# 공개 column의 제한 조회
npx -y @nomadamas/k-skill@0 exec seoul-weather-risk \
  scripts/seoul_weather_risk.py -- query \
  --product-id weather_place_risk_window \
  --filter place_id=<게시된_place_id> \
  --from 2026-08-10 --to 2026-08-12 --limit 100
```

응답에서는 `publication_id`, 시간축 `forecast_at`, `row_count`, `next_cursor`, 위험 유형과
판정 근거를 확인한다. 다음 페이지는 같은 제품·publication에서만 `next_cursor`를 그대로
사용하며, publication이 바뀌어 `409`가 나면 bundle/product부터 다시 읽는다.

## 실패 시 처리

| 응답 | 의미 | 처리 |
|---|---|---|
| `upstream_not_configured` (503) | proxy origin 또는 운영 서버의 전용 서비스 키가 아직 준비되지 않음 | 사용자가 키를 넣어 우회하지 않는다. proxy 운영자에게 배포 상태를 문의한다. |
| `product_not_ready` (503) | 권리·품질·신선도·게시 gate 중 하나가 미충족 | `blockers`를 확인하고 준비 완료 전 데이터를 정상으로 표현하지 않는다. |
| `cursor_expired` (409) | publication이 갱신되어 이전 page cursor가 무효 | 새 bundle/product 응답으로 다시 시작한다. |
| `rate_limited` (429) | proxy rate limit 도달 | `Retry-After`를 따르고 반복 호출을 멈춘다. |
| `response_contract_invalid` | bundle/product/data가 단일 제품 계약과 다름 | 추정값이나 fixture로 대체하지 말고, 응답 요약과 배포 revision을 운영자에게 전달한다. |

## 운영 경계

- 이 스킬은 hosted proxy의 고정된 weather-risk read route만 사용한다. table name, SQL,
  join, aggregate, 임의 sort는 입력받거나 전달하지 않는다.
- 사용자 키 없이 동작하는 것은 proxy가 전용·회수 가능한 서비스 키를 서버 안에서만 사용하기
  때문이다. 개인 Marketplace 키를 proxy 설정이나 스킬 명령에 넣지 않는다.
- 설치·사용을 위해 ASK 서울 Marketplace Worker를 로컬에서 실행하지 않는다. 특히
  `wrangler dev`는 운영 D1의 사용량·burst·요청 로그에 영향을 줄 수 있다.
