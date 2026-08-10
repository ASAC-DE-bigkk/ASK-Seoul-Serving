# 응답 상태 실패 목록의 제품 표시명 설계

## 목적

Ops Dashboard의 응답 상태 실패 목록에서 Traffic·Weather를 포함한 게시 제품을 한글 제품명으로 먼저 보여 주고, 운영 진단에 필요한 물리 `table_name`은 보조 식별자로 유지한다.

## 현재 문제

`/api/summary`의 `serving.failures` 행은 `table_name`만 반환한다. 프런트의 실패 목록도 그 값을 직접 렌더링하므로, 이미 게시된 `d1_catalog_display.title`이 있어도 `traffic_*`·`weather_*` 물리 테이블명이 노출된다.

## 설계

1. 실패 집계에 `MAX(product_id) AS product_id`를 추가한다. 기존 `status`·`route`·`table_name`·`domain` 집계 키와 건수는 바꾸지 않는다.
2. `summary()`가 이미 이용자별 통계에 읽어 둔 `displayMap()`을 재사용해 각 실패 행에 `display_title`만 붙인다. 별도 조인·수동 맵·D1 쓰기는 없다.
3. 프런트는 `display_title`이 있으면 `한글 제목 + table_name(또는 product_id) pill`을, 없으면 기존 식별자 폴백을 렌더링한다.
4. `d1_catalog_display`가 없거나 선언되지 않은 제품, 오래된 로그처럼 `product_id`가 없는 경우에는 실패 목록과 다른 카드가 빈 화면이 되지 않고 기존 물리 식별자를 계속 표시한다.

## 비범위

- D1 스키마·운영 데이터·Gateway 로그 형식 변경
- API 사용 현황, 제품 상세, 요청 추적 탭의 표기 변경
- 수동 한글 번역표 또는 외부 API 호출 추가

## 검증

- 새 정적 회귀 검증으로 서버의 제품 ID·표시명 부착 계약과 프런트의 제목 우선/pill/폴백 렌더링 계약을 확인한다.
- 기존 `check:hidden`과 JavaScript 문법 검사를 함께 실행한다.
