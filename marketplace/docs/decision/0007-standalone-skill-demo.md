# 0007 — standalone K-Skill artifact와 no-build 데모 페이지

- 상태: 채택
- 날짜: 2026-08-10
- 관련: ASK-Seoul-Serving #193, NomaDamas/k-skill #552

## 맥락

`seoul-weather-risk`의 upstream merge와 npm release 일정은 ASK 서울이 통제하지 못한다. 발표 전에 외부 AI 설치와 실제 `/skill/v1` 호출을 재현하려면 Serving이 검증 가능한 artifact와 독립 진입점을 소유해야 한다.

## 결정

1. 저장소 루트 `skills/seoul-weather-risk/`에 organization fork의 고정 commit에서 export한 standalone artifact를 둔다.
2. provenance가 source repository/ref/commit과 exported file SHA-256을 연결한다.
3. standalone `SKILL.md`는 runtime `npx`와 `@nomadamas/k-skill`에 의존하지 않는다.
4. `public/skill-demo.html`을 기존 no-build Static Assets 정본에 추가한다.
5. 페이지는 설치·API Key 입력·readiness 실검증·외부 AI handoff만 담당하고 챗봇이나 자연어 해석기를 구현하지 않는다.
6. API Key는 password input과 현재 document의 JS 메모리에서만 사용한다.
7. 화면은 기존 `site.css` 토큰과 문서형 `header.page`/`nav.toc` 문법을 사용하며, 별도 팔레트나 폰트를 만들지 않고 light/dark 테마를 모두 지원한다.

## 이유

- fork source와 배포 artifact를 hash로 추적할 수 있다.
- npm 미등록 상태에서도 Codex·Claude Code fresh install을 재현할 수 있다.
- 기존 `public/` 배포와 partial sync를 유지해 Worker·D1·build pipeline 변경을 피한다.
- 채팅 #159와 소비자 경계를 분리한다. 채팅은 Marketplace 내부 질문, K-Skill은 외부 AI 설치 경로다.

## 비용과 재검토 신호

루트 `skills/`와 상태를 가진 정적 화면 하나가 추가된다. 다음 중 하나가 발생하면 decision/0002의 SSG 전환을 다시 검토한다.

- 두 번째 standalone skill 또는 두 번째 stateful demo page 추가
- artifact export가 수동 반복 작업으로 남음
- `PAGES` 분기나 shared UI 상태 로직이 한 단계 더 증가

## Rollback

직전 검증 artifact commit URL로 복원한 뒤 `/skill-demo`와 vendored artifact를 제거한다. D1 데이터와 요청 로그는 손대지 않는다.
