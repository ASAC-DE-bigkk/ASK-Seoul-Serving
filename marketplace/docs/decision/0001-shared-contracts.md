# 0001 — marketplace ↔ ops-dashboard 공통 계약

- 상태: 초안 (양측 합의 시 확정)
- 당사자: marketplace(@yooseongjin527) · ops-dashboard(@Exisign)
- 관련: ASK-Seoul-Serving#5(문서 3층 체계) · #7(실행 기록 탭) · #9(행동 로그 스펙 v0) · ASK-Seoul#78

## 왜

두 앱은 **같은 로컬 D1 상태를 공유**하고(콘솔이 `--persist-to` 로 marketplace 상태를
읽는다), 콘솔의 화면·조치가 marketplace 의 테이블·헤더·시간 규약 위에 서 있다.
그런데 이 계약들은 지금까지 양쪽 코드와 주석에 흩어진 **암묵 계약**이었다 — 한쪽이
모르고 바꾸면 조용히 깨진다(쿼터 숫자 불일치, 추적 탭 사망, 시드 유실).
이 문서는 그 계약을 한 곳에 명문화하고, 바꾸는 절차를 정한다.

콘솔 쪽 대응물: ops-dashboard decision/0003(공유 로컬 D1) · 0006(key_hash 식별자) ·
0010(스키마 정본 추종). 이 문서와 그 문서들이 어긋나면 **먼저 합의된 쪽이 이긴다**.

## 계약

### C-1. 오류 형식 = problem+json

`application/problem+json` `{type, title, status, detail, …}`. marketplace 는 4xx/5xx
본문에 `request_id` 를 추가로 싣는다. `error.code` 봉투는 채택하지 않았다 — 기계판독
코드가 필요해지면 봉투 교체가 아니라 problem+json 확장 필드(`code`)로 **추가**한다(RFC 9457).

### C-2. 하루 경계 = KST

쿼터·일별 집계의 하루는 KST 다. marketplace `kstDay()` ≡ 콘솔 `date('now','+9 hours')`.
어느 한쪽이 UTC 로 바뀌면 같은 키의 사용량 숫자가 두 화면에서 달라진다.

### C-3. 키 식별자 = `key_hash` (SHA-256 hex 64자)

키 원문은 어디에도 저장하지 않는다. `key_prefix`(8자)는 표시 전용 — 충돌하므로 식별자로
쓰지 않는다. 콘솔의 키 조치(폐기·복구·쿼터·삭제)는 key_hash 로만 온다.

### C-4. 키 상태 = 2값 (`active` / `revoked`)

물리 삭제(purge)는 상태가 아니라 행 제거다. suspended·expired 등 확장은 이 문서와
콘솔 0006 의 **공동 개정**이 먼저다 — 한쪽만 상태를 추가하면 다른 쪽 화면·게이트가
모르는 상태를 만난다.

### C-5. 요청 추적 = `request_id`

marketplace 는 모든 API 응답에 `x-request-id` 헤더, 오류 본문에 `request_id` 를 싣고
`_request_log.request_id` 에 기록한다. 콘솔 `/api/trace` 는 이 열쇠 하나로 단건을
특정한다. 헤더 이름·컬럼 이름·`req_` 접두를 바꾸면 추적이 끊긴다.

### C-6. 값이 아니라 축만 (+ 30일)

`_request_log` 에는 분류·축만 남긴다: 필터는 **컬럼명만**, 식별자는 **key_hash 만**.
저장 금지: 키 원문 · 이메일 · 쿼리 값 · 원문 UA · 전체 Referer URL · Authorization.
보존 30일(sweep). #9 의 신규 축(ua_class 등)과 #3 의 intent 축도 이 원칙 위에서만
추가된다. 이메일 원문이 나가는 곳은 본인 인증 응답(`/api/me`)뿐 — 운영 화면은 마스킹.

### C-7. NULL = 모른다 ≠ 0 (#78 F-3)

새 컬럼은 전부 nullable 로 추가하고, 컬럼이 생기기 전 기록은 NULL 로 남는다.
모르는 값을 0 이나 기본값으로 지어내지 않는다. 화면은 NULL 을 "미측정·수집 전"으로
구분 표시한다.

### C-8. 마이그레이션 = 증분·추가만 (#78 D-6)

DROP·이름 변경 금지. 변경은 새 ALTER 파일로만. SQLite 의 ALTER 에는 IF NOT EXISTS 가
없으므로 재시드가 깨지지 않게 `||` 로 감싼다. **같은 커밋에서 seed 체인에 그 파일을
추가한다** — 0004 누락으로 로컬 `_request_log` 가 몇 주간 조용히 전량 유실된 실사고의
재발 방지 조항이다.

### C-9. 스키마 정본은 marketplace, 콘솔은 추종

`_keys`·`_usage`·`_burst`·`_request_log`·`_catalog` 의 정본은 `marketplace/migrations/`.
콘솔은 ALTER 미러를 만들지 않는다(0010 — duplicate column 충돌). 콘솔이 필요로 하는
컬럼(#9 의 9종 등)은 marketplace 마이그레이션으로만 태어난다.

### C-10. 관측 실패는 응답 무해 — 단, 유실은 검증으로 잡는다

로그 실패가 서빙을 깨뜨리면 안 된다(`ctx.waitUntil`, 조용히 버림). 그 대가로 유실이
보이지 않으므로, 관측 경로를 고친 커밋은 **행이 실제로 늘었는지**를 검증 항목에
포함한다(각 CLAUDE.md 검증 절).

## 개정 절차

이 문서의 계약을 바꾸는 PR 은 **상대 앱 담당의 리뷰를 필수**로 한다. 순서:
① 이 문서 개정(사유·영향·마이그레이션 경로 명시) → ② 양측 코드 반영 → ③ 콘솔 쪽
대응 결정 문서(0003/0006/0010)와 상호 참조 갱신.
