# Weather risk query context 설계

## 목적

`weather_place_risk_window`의 장소·시간 조회가 0행을 반환할 때, 현재 publication의
장소별 조회 가능 구간이 완전하고 최신인지 확인한 뒤에만 "예상 위험 후보 없음"으로
설명한다. availability 증거가 없거나 요청 구간을 증명할 수 없으면 정상 빈 결과로
위장하지 않고 명시적인 오류로 닫는다.

## 근거와 현재 문제

- `ASK-Seoul-Serving#291`의 남은 구현은 `/skill/v1` Weather 단일 제품 경로에 있다.
- 현재 `marketplace/src/skill.js`는 `from`·`to`를 원문 문자열로 비교하고, `place_id` 없이도
  조회를 허용하며, SQLite `rowid`를 cursor로 사용한다.
- DAG #781/#788과 DBT #531/#541이 `d1_product_query_availability`를 현재
  `publication_id`에 결속해 게시하도록 이미 `dev`에 병합했다.
- sidecar의 기준 컬럼은 `place_id`, `snapshot_as_of_hour`, `available_from_at`,
  `available_to_at`, `forecast_collected_at_min`, `forecast_collected_at_max`,
  `expected_forecast_hour_count`, `observed_forecast_hour_count`,
  `availability_status`, `source_population_revision`이며 Publisher가 추가로
  `availability_fingerprint`, `measured_at`을 기록한다.

## 범위

### 변경하는 것

1. `/skill/v1/products/weather_place_risk_window/data`의 입력 검증, sidecar 조회,
   `query_context`, cursor v2, 빈 결과 의미 구분.
2. `skills/seoul-weather-risk` helper의 응답 계약 검증과 bundled mapping revision 검증.
3. K-Skill 데모가 장소를 명시해 조회하고, availability 증거가 있는 정상 0행을
   실패로 오인하지 않도록 표시.
4. 이 동작을 고정하는 Worker/helper/demo 테스트와 `docs/change-log.md` 기록.

### 변경하지 않는 것

- 일반 `/api/v1/*`, MCP, 기존 Marketplace API와 service scope.
- D1 migration, `d1_product_query_availability`의 생성·소유권·게시 lifecycle.
- Weather 원천 수집, DBT Gold, DAG Publisher 코드.
- 폐기된 Traffic 도메인과 Dashboard 저장소.
- API key, Worker route/custom domain, 운영 배포 설정.

## API 계약

### 입력

- `place_id`는 필수이며 `seoul_admd_` canonical 형식만 허용한다.
- `from`과 `to`는 둘 다 주거나 둘 다 생략한다.
- 둘 다 생략하면 현재 publication의 해당 장소 availability 전체 구간을 사용한다.
- 날짜만 주면 `from`은 KST 00:00:00, `to`는 KST 23:59:59로 확장한다.
- offset 없는 datetime은 KST로 해석하고 RFC3339 offset/Z는 동일한 순간을 KST-naive
  canonical bound로 변환한다.
- 실제 달력 날짜, 시·분·초, offset을 엄격히 검증하고 `from > to`를 거부한다.

### publication-bound availability 검증

1. `_catalog.publication_id`를 현재 publication으로 고정한다.
2. `d1_product_query_availability`에서 `(product_id, publication_id, place_id)`로만
   sidecar를 읽는다. 이전 publication의 행이나 임의의 다른 장소 행으로 대체하지 않는다.
3. 행이 하나가 아니거나 sidecar 표·컬럼·값이 없거나 malformed이면 `503
   product_not_ready`로 종료한다.
4. `availability_status=complete`, `expected=observed`, 양 끝의 KST hourly slot,
   `forecast_collected_at_min` freshness SLO, 현재 K-Skill mapping의
   `source_population_revision` 일치를 모두 확인한다.
5. 요청 canonical 구간이 `[available_from_at, available_to_at]` 안에 완전히 들어가지
   않으면 부분 행을 반환하지 않고 `422 query_window_unavailable`로 종료한다.

### 시간·쿼터·결과

- canonical 구간에 hourly forecast slot이 하나도 없으면 `400 invalid_time_window`와
  `no_hourly_forecast_slot`을 반환하고 risk SQL과 quota를 실행하지 않는다.
- malformed bound, 한쪽 bound만 존재, 역전 구간은 `400 invalid_time_window`이며 무과금이다.
- sidecar가 stale/incomplete/missing이면 `503 product_not_ready`이며 무과금이다.
- 모든 사전 검증 후에만 `countUsage`를 호출한다.
- 첫 페이지의 risk 행이 0건이고 availability가 현재 publication에서 `covered`이며
  freshness가 `fresh`이면 `query_context.zero_result_reason`을
  `no_upcoming_weather_risk_candidate`로 설정한다.
- cursor 페이지의 0건은 정상 빈 결과가 아니다. quota를 환불하고 `400 invalid_cursor`로
  종료한다.
- 응답에는 요청·가용 구간, snapshot, collection bounds, mapping revision,
  publication, `coverage_status`, `freshness_state`, `zero_result_reason`을 포함한
  additive `query_context`를 넣는다.

## Cursor v2

cursor는 base64url JSON으로 다음 값을 가진다.

```json
{
  "v": 2,
  "publication_id": "...",
  "query_fingerprint": "...",
  "forecast_at": "2026-08-14 09:00:00",
  "product_row_id": "..."
}
```

`query_fingerprint`는 product, publication, place, canonical from/to의 결정적 표현에서
만들고 limit은 포함하지 않는다. SQL 순서는 `(forecast_at ASC, product_row_id ASC)`이며
같은 조건으로 keyset predicate를 만든다. publication·fingerprint 불일치는 `409`로
무과금 처리한다.

## Mapping revision

helper는 bundled `admin-dong-place-map.json`의 427개 행을 `place_id` 정렬 후
`[place_id, admin_dong, gu]` JSON 배열로 canonicalize하고 SHA-256을 계산한다.
서버의 `source_population_revision`이 `kma_admin_dong_grid_20260325:<hash>`와
정확히 다르면 `location_mapping_revision_mismatch`로 fail-closed 한다. prefix만
같은 경우도 통과시키지 않는다.

## 구현 구조

- `marketplace/src/skill.js`: Weather data route의 계약 순서와 SQL을 연결한다.
- `marketplace/src/weather-risk-query.js`: KST bound parser, availability row 검증,
  query fingerprint, cursor v2, query context 생성을 분리한다.
- `skills/seoul-weather-risk/scripts/seoul_weather_risk.py`: data 응답의
  `query_context`, cursor v2 표면, mapping revision을 검증한다.
- `marketplace/public/skill-demo.js`: `place_id`를 포함해 fast query를 실행하고,
  covered/fresh/reason이 있는 0행만 정상 no-candidate로 표시한다.

새 D1 migration은 만들지 않는다. sidecar 표와 publication lifecycle은 DAG Publisher가
소유하고 Serving은 현재 publication을 읽기만 한다.

## 검증 계획

- Worker: 실제 SQL bind 순서, 날짜 경계·윤년·offset 변환, sidecar 누락/불일치/stale,
  구간 미포함, valid empty, cursor fingerprint/publication mismatch, cursor page
  zero-row quota refund를 `marketplace/scripts/skill-v1.test.mjs`에서 검증한다.
- helper: valid/invalid `query_context`, mapping hash mismatch, cursor v2와 typed
  errors를 Python 표준 테스트로 검증한다.
- demo: 장소가 포함된 요청, 정상 0행과 evidence 없는 0행의 표시를 테스트한다.
- `npm test`와 helper 테스트를 실행하고, 일반 `/api/v1`·MCP 테스트가 변하지 않았는지
  함께 확인한다.
- 운영 D1에는 직접 쓰지 않고, clean `origin/dev` 기준의 계약 테스트와 검증 결과를 PR에
  남긴다. prod 배포와 이슈 close는 merged PR 및 live smoke 증거를 확인한 뒤 별도로
  판단한다.

## Rollback

코드 revert만으로 기존 `/skill/v1` 동작으로 돌아간다. DAG가 게시한 sidecar는 삭제하지
않으며, 일반 API·MCP·다른 제품에는 영향을 주지 않는다.
