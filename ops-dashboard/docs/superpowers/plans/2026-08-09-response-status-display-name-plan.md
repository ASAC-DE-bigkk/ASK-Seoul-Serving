# 응답 상태 실패 목록의 제품 표시명 구현 계획

> 구현 설계: `docs/superpowers/specs/2026-08-09-response-status-display-name-design.md`

1. `scripts/response-status-display.test.mjs`에 실패 행의 `product_id` 보존, 서버 `display_title` 부착, 프런트 제목 우선·물리 식별자 pill·폴백 계약을 검증하는 실패 테스트를 추가한다.
2. `src/index.js`의 실패 집계가 `product_id`를 보존하고, 기존 `displayMap()` 결과로 `display_title`을 붙이도록 최소 수정한다.
3. `public/index.html`의 실패 목록이 공통 표시명 렌더러를 사용하도록 바꾸고, 제목이 없을 때의 기존 식별자 폴백을 유지한다.
4. 회귀 테스트, `npm run check:hidden`, `node --check src/index.js`를 실행한다. 운영 D1을 연결하는 개발 서버와 배포 명령은 실행하지 않는다.
5. `docs/change-log.md`에 변경 의도·조치·정적 검증·비범위를 기록하고, diff 검토 후 커밋·push·`dev` 대상 PR을 생성한다.
