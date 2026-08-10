# K-Skill 데모 페이지 구현 계획

## 완료 조건

`/skill-demo`에서 key를 저장·노출하지 않고 운영 readiness와 한 행 조회를 증명하며, commit-pinned standalone skill을 Codex·Claude Code에 설치해 자연어 질문을 실행할 수 있다.

## 순서

1. **RED — vendored artifact 계약**
   - provenance/hash 검증과 runtime `npx` 금지 테스트를 먼저 추가한다.
   - artifact가 없어서 실패하는 것을 확인한다.
2. **GREEN — standalone artifact**
   - 승인된 fork commit의 helper·mapping·instruction을 import한다.
   - standalone `SKILL.md`, `NOTICE`, `provenance.json`을 생성한다.
   - 성공 응답의 `X-Request-Id`가 결과에 보존되도록 source helper와 테스트를 맞춘다.
3. **RED — page security/state contract**
   - memory-only key, 금지 storage, masked preview, 오류별 상태, request ID 보존 테스트를 추가한다.
   - 페이지가 없어서 실패하는 것을 확인한다.
4. **GREEN — `/skill-demo` page**
   - no-build HTML/JS로 설치·key·readiness·handoff 단계를 구현한다.
   - 공통 CSS 최소 확장과 aria-live/focus/reduced-motion을 반영한다.
5. **Partial/OpenAPI/docs**
   - nav/footer sync 대상에 page를 등록한다.
   - 성공 `X-Request-Id` header를 skill OpenAPI에 문서화한다.
   - 설치 문서, page-composition 결정, change-log를 갱신한다.
6. **검증**
   - 집중 테스트 → `npm test` → responsive audit → `git diff --check` 순으로 실행한다.
   - `.env` 값은 출력하지 않고 운영 API smoke를 실행한다.
   - 설치 환경 E2E는 artifact commit이 확정된 뒤 Codex·Claude Code 각각 2회 수행한다.

7. **RED — Marketplace 디자인 정합성 계약**
   - `header.page`, `nav.toc`, 단일 열 설치 행, 검증 체크리스트, 대상별 복사 이름, `44px` 조작 높이, light/dark 토큰 사용을 정적 테스트로 먼저 고정한다.
   - 현재 landing형 hero와 2열 설치 카드 때문에 실패하는 것을 확인한다.
8. **GREEN — 문서형 3단계 페이지**
   - `/skill-demo`를 기존 문서 페이지의 정보 밀도와 radius로 재구성한다.
   - 설치·연결·검증 순서는 유지하고, API 호출·키 메모리·오류 처리 로직은 바꾸지 않는다.
   - 모바일 주요 액션을 전체 너비로 만들고 반복 복사 버튼의 접근성 이름을 구체화한다.
9. **양 모드 시각 검증**
   - light/dark 각각 `1280px`과 `320px` 화면을 캡처한다.
   - 동일 뷰포트의 `docs` 기준 화면과 함께 비교해 제목 크기, 여백, border/radius, 코드 행, overflow를 확인한다.
   - 전체 Marketplace 테스트와 responsive audit를 다시 실행한다.

## 영향 경계

Marketplace 정적 자산, skill OpenAPI 문서, vendored artifact와 검증 스크립트만 변경한다. 채팅/MCP/API 구현과 데이터 파이프라인은 변경하지 않는다.
