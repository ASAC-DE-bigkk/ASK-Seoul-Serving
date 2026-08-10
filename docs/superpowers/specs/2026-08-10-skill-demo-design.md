# K-Skill 데모 페이지 설계

- 이슈: ASK-Seoul-Serving #193
- 기준: `origin/dev@4af1961`
- 상태: 사용자 승인 완료

## 목적

upstream merge 또는 npm release와 무관하게 `seoul-weather-risk`를 Codex·Claude Code에 설치하고, ASK 서울 운영 `/skill/v1`의 준비 상태와 실제 데이터 응답을 확인한 뒤 자연어 질문을 실행할 수 있는 독립 시연 경로를 제공한다.

## 변경하지 않을 경계

- Marketplace 채팅, MCP, Ops, DAG, DBT, D1 schema를 변경하지 않는다.
- `/skill/v1`의 exact-one, 권리, 품질, freshness, quota 정책을 우회하지 않는다.
- API Key를 정적 자산, 저장소, URL, storage, 로그, 설치 명령 또는 복사 프롬프트에 넣지 않는다.
- `registration_ready=false` 또는 zero-row를 성공 시연으로 표현하지 않는다.

## 사용자 흐름

1. 사용자가 `/skill-demo`에 접속해 Codex 또는 Claude Code를 선택한다.
2. Serving이 보유한 commit-pinned standalone artifact 설치 명령을 복사한다.
3. Marketplace API Key를 password input에 입력한다. 값은 현재 document의 JS 메모리에만 존재한다.
4. 페이지가 같은 origin의 `/skill/v1`을 `bundle → product → data?limit=1` 순서로 호출한다.
5. readiness가 통과한 경우에만 publication ID, row count, request ID와 샘플 행을 표시한다.
6. 사용자는 API Key가 포함되지 않은 자연어 질문을 복사해 설치한 Codex·Claude Code에서 실행한다.
7. 외부 AI는 vendored skill helper로 행정동을 결정적으로 `place_id`에 매핑하고 실제 API를 호출한다.

## 구성

### Standalone artifact

저장소 루트 `skills/seoul-weather-risk/`에 다음을 둔다.

- `SKILL.md`: runtime `npx`/`@nomadamas/k-skill` 호출이 없는 독립 지침
- `scripts/seoul_weather_risk.py`: Python stdlib helper
- `references/admin-dong-place-map.json`: 서울 427개 행정동 매핑
- `NOTICE`: 원본과 라이선스
- `provenance.json`: source repository, ref, commit, exported file SHA-256

Serving artifact는 fork source commit을 정본으로 삼고 검증 스크립트가 hash drift와 금지 runtime 의존을 차단한다.

### `/skill-demo`

기존 no-build Static Assets 구조를 유지한다. `public/skill-demo.html`을 직접 서빙하고 nav/footer partial 동기화 대상에 등록한다.

화면은 네 단계로 구성한다.

1. AI 환경 선택 및 설치
2. API Key 입력
3. readiness·live smoke
4. 자연어 질문 복사 및 외부 AI 실행

페이지는 챗봇이 아니다. 자연어를 해석하거나 답변을 생성하지 않고, API 준비도 증명과 외부 AI 실행 handoff만 담당한다.

## 보안 계약

- password input은 autocomplete를 끄고 값은 module-local 변수에만 보관한다.
- `localStorage`, `sessionStorage`, IndexedDB, cookie를 사용하지 않는다.
- key를 URL, console, analytics, DOM text, generated command, clipboard prompt에 넣지 않는다.
- 요청 preview에는 `Authorization: Bearer ••••••••`만 표시한다.
- 페이지 unload와 명시적 초기화에서 input과 메모리 참조를 비운다.
- 로컬 `.env` key는 자동화된 live smoke 프로세스만 읽으며 값은 출력하지 않는다.

## 응답·오류 계약

성공 응답에서는 각 호출의 `X-Request-Id`를 보존하고 최종 data 결과에 `publication_id`, `row_count`, request ID를 함께 표시한다.

| 상태 | 화면 동작 |
| --- | --- |
| 401 | 키 누락·오입력 안내, 재입력 허용 |
| 403 | 폐기 또는 권한 부족 안내 |
| 404 | 배포 또는 exact-one 경로 불일치 안내 |
| 429 | `Retry-After`와 재시도 시점 안내 |
| 503 | blocker를 표시하고 live 단계 차단 |
| network | 연결 실패와 재시도 안내 |
| zero-row | 빈 결과로 표시하고 성공 답변 생성 금지 |

## 페이지 조합 결정

이번 변경은 기존 `public/` 정본과 partial sync 방식을 유지한다. 한 개의 독립 시연 화면 때문에 SSG/build pipeline을 추가하면 배포 경로와 rollback 단위가 커지기 때문이다. 재사용 상태 로직이나 유사 데모 페이지가 하나 더 생기면 page-composition 결정을 다시 검토한다.

## 시각·상호작용 계약

- `site.css`의 기존 light/dark 토큰을 그대로 사용한다. 페이지 전용 hex 색상이나 별도 폰트를 추가하지 않는다.
- 상단은 다른 문서 페이지와 같은 `header.page` 밀도, `26px` 제목, `14px` lede를 사용한다.
- `설치 → 연결 → 검증` 순서를 기존 `nav.toc` pill 문법으로 먼저 보여 준다.
- 설치 명령은 플랫폼별 전체 너비 행으로 쌓아 긴 URL이 2열 카드 안에서 과도하게 줄바꿈되지 않게 한다.
- 인증 전에는 bundle, product, one-row data 세 검증 항목을 명시하고, 통과 뒤에는 publication ID, row count, request ID를 한 증거 패널에 모은다.
- 보안·범위·로컬 실행 안내는 중첩 카드 대신 한 개의 보조 정보 영역으로 합친다.
- 모든 조작 버튼은 최소 높이 `44px`을 확보하고, 반복되는 복사 버튼에는 대상별 접근성 이름을 준다.
- `320/375/768/960/1280px`에서 문서 전체 가로 overflow가 없고, 모바일 주요 액션은 전체 너비가 된다.

## 검증

- vendored provenance/hash/runtime dependency 테스트
- key 비노출·memory-only 정적 계약 테스트
- readiness 상태 머신과 오류별 복구 안내 테스트
- 성공 `X-Request-Id` OpenAPI 계약 테스트
- partial sync, 기존 Marketplace 전체 테스트
- 320/375/768/960/1280px responsive audit
- 로컬 `.env` key를 이용한 운영 `/skill/v1` 실호출
- 빈 Codex·Claude Code 설치 및 자연어 질문 E2E

## Rollback

직전 검증 artifact commit 설치 URL로 복원하고 `/skill-demo` 정적 페이지 및 vendored artifact를 제거한다. D1 데이터, catalog, request log는 rollback 대상이 아니다.
