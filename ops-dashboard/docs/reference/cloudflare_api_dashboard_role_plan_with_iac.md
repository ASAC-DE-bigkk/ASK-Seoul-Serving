> **문서 성격 — 방법 카탈로그 (구속력 없음).** `revised` 문서에 IaC 전략(§20~39:
> Terraform/Wrangler 경계·State·CI/CD)을 더한 판이다. "이런 방법이 있다"를 아는 용도까지만
> 쓴다 — 여기 나온 구조를 구현 근거로 삼지 않는다. 현재 이 프로젝트에는 Terraform 으로
> 관리할 원격 리소스 자체가 없다([../decision/0008](../decision/0008-deferred-scope.md)).
> 실체는 [../../CLAUDE.md](../../CLAUDE.md), 채택 여부는 [../decision/](../index.md)이 정한다.

# Cloudflare 기반 API 서비스 및 운영 대시보드 개발 역할 분담

## 1. 문서 목적

본 문서는 Cloudflare 기반으로 다음 서비스를 구축할 때 두 개발자의 역할과 작업 순서를 정의한다.

- 외부 사용자 대상 API 서비스
- API 문서 및 개발자 포털
- API Key 기반 인증 및 호출 제한
- API 호출 이력과 Input/Output 저장
- 운영 대시보드
- 이상 상황 탐지
- API Key 차단 및 해제
- 운영자 감사 로그

개발 역할은 다음 두 영역으로 구분한다.

1. **API 및 API 제공 화면 개발자**
2. **운영 대시보드 및 운영 처리 개발자**

두 역할은 완전히 독립적이지 않다.  
API Key 상태 모델, 로그 이벤트 스키마, 차단 인터페이스 등은 공동 계약으로 먼저 정의해야 한다.

---

# 2. 전체 아키텍처

```text
API 사용자
   │
   ▼
Cloudflare Edge
├─ DDoS Protection
├─ WAF / Custom Rules
├─ Rate Limiting
└─ Schema Validation
   │
   ▼
API Gateway Worker
├─ API Key 검증
├─ 키 상태 및 권한 확인
├─ 요청 크기 및 스키마 검증
├─ 키별 Rate Limit
├─ 차단 상태 확인
├─ request_id 생성
└─ 실제 API 호출
   │
   ├─────────────► Workers 기반 API
   │
   └─────────────► AWS/GCP 기반 API
                       ├─ Spring Boot
                       ├─ FastAPI
                       └─ 외부 AI/API 서비스

API Gateway Worker
   │
   ├─ Analytics Engine
   │      └─ 실시간 운영 지표
   │
   └─ Cloudflare Queue
          │
          ▼
      Log Consumer Worker
          ├─ R2: 원본 호출 로그
          ├─ D1/PostgreSQL: 검색용 메타데이터
          └─ 이상 탐지 및 집계

운영자
   │
   ▼
Cloudflare Access
   │
   ▼
운영 대시보드
├─ API Key 생성 및 관리
├─ 호출량 및 오류율
├─ 이상 요청 탐지
├─ 호출 이력 조회
├─ API Key 차단 및 해제
└─ 운영자 감사 로그
```

---

# 3. 역할 구분

## 3.1 API 및 API 제공 화면 개발자

외부 API 사용자와 직접 맞닿는 영역을 담당한다.

### 담당 범위

- Public API
- API Gateway Worker
- API Key 인증
- API Key 상태 확인
- Rate Limit
- 정확한 사용량 제한
- 호출 로그 이벤트 생성
- API 문서
- 개발자 포털
- 실제 차단 집행
- 업스트림 API 연동

### 담당 Cloudflare 서비스

| 영역 | Cloudflare 서비스 |
|---|---|
| API Gateway | Workers |
| API 문서 및 개발자 화면 | Workers Static Assets |
| API Key 및 정책 데이터 | D1 |
| 정확한 전역 상태 및 즉시 차단 | Durable Objects |
| 호출 로그 이벤트 | Queues |
| 실시간 지표 | Analytics Engine |
| 원본 호출 로그 | R2 |
| 공격 방어 | WAF, Rate Limiting, Schema Validation |

---

## 3.2 운영 대시보드 및 운영 처리 개발자

내부 운영자가 사용하는 조회 및 제어 영역을 담당한다.

### 담당 범위

- 운영 대시보드
- Admin Worker
- 운영자 인증
- 운영자 권한 관리
- API Key 검색 및 상세 조회
- 호출 이력 조회
- 이상 탐지
- 차단 및 해제 명령
- 운영자 감사 기록
- 장애 및 운영 상태 확인

### 담당 Cloudflare 서비스

| 영역 | Cloudflare 서비스 |
|---|---|
| 운영 화면 | Workers Static Assets |
| 운영 API | Admin Worker |
| 운영자 인증 | Cloudflare Access |
| 운영 권한 | Access + 자체 RBAC |
| 실시간 통계 | Analytics Engine |
| 호출 메타데이터 | D1 또는 외부 DB |
| 원본 로그 | R2 |
| 차단 명령 | Admin Worker → Durable Object |
| 감사 로그 | D1 또는 외부 DB |

---

# 4. API 개발자의 세부 역할

## 4.1 Public API 설계

다음 항목을 정의한다.

- URL 규칙
- API 버전 규칙
- 인증 방식
- 요청 및 응답 스키마
- 공통 오류 형식
- 페이지네이션
- 재시도 정책
- 요청 크기 제한
- 타임아웃
- 멱등성 정책
- Rate Limit 정책

예시:

```http
POST /v1/search
Authorization: Bearer ak_live_xxx
Content-Type: application/json
```

공통 오류 형식:

```json
{
  "error": {
    "code": "API_KEY_SUSPENDED",
    "message": "The API key has been suspended.",
    "requestId": "req_01K..."
  }
}
```

---

## 4.2 API Key 처리

### 주요 기능

- API Key 생성
- API Key 원문 1회 노출
- API Key 해시 저장
- API Key 상태 확인
- 만료 확인
- 허용 API 확인
- 요금제 확인
- 호출 제한 확인
- 재발급
- 폐기
- 차단 및 해제 상태 반영

### API Key 상태

```text
PENDING
ACTIVE
SUSPENDED
REVOKED
EXPIRED
```

### 상태별 처리

| 상태 | API 호출 | 복구 가능 여부 |
|---|---|---|
| PENDING | 차단 | 활성화 가능 |
| ACTIVE | 허용 | 해당 없음 |
| SUSPENDED | 차단 | 가능 |
| REVOKED | 차단 | 불가능 |
| EXPIRED | 차단 | 재발급 필요 |

---

## 4.3 Rate Limit 및 사용량 제한

Rate Limit은 두 종류로 나눈다.

### 순간적인 호출 제한

Workers Rate Limiting을 사용한다.

```text
api_key_id + endpoint + plan_code
```

예시:

```text
key_1234:/v1/search:PRO
```

용도:

- 순간 폭주 차단
- 봇 호출 제한
- API Key별 단기 요청 제한
- endpoint별 요청 제한

### 정확한 일/월 사용량 제한

Durable Objects 또는 중앙 DB를 사용한다.

```text
분당 제한
→ Workers Rate Limiting

일/월 계약 한도
→ Durable Objects 또는 중앙 DB
```

정확한 과금과 계약 한도는 Workers Rate Limiting 결과만으로 계산하지 않는다.

---

## 4.4 실제 차단 집행

운영 대시보드는 차단 명령만 발생시킨다.

실제 API 요청을 차단하는 책임은 API Gateway Worker에 있다.

```text
API 요청
   ↓
API Key 검증
   ↓
차단 상태 확인
   ↓
Rate Limit 확인
   ↓
실제 API 실행
```

차단 상태인 경우 다음과 같이 응답한다.

```json
{
  "error": {
    "code": "API_KEY_SUSPENDED",
    "message": "The API key has been suspended.",
    "requestId": "req_01K..."
  }
}
```

---

## 4.5 로그 이벤트 생성

모든 API 호출에 `request_id`를 생성한다.

호출 결과는 Queue에 비동기로 전달한다.

```json
{
  "eventVersion": "1.0",
  "requestId": "req_01K...",
  "apiKeyId": "key_1234",
  "method": "POST",
  "endpoint": "/v1/search",
  "statusCode": 200,
  "latencyMs": 182,
  "inputBytes": 320,
  "outputBytes": 2810,
  "country": "KR",
  "colo": "ICN",
  "blocked": false,
  "blockReason": null,
  "occurredAt": "2026-08-02T07:30:00Z"
}
```

### 주의사항

- 호출마다 D1에 동기 INSERT하지 않는다.
- Queue를 사용해 비동기 처리한다.
- 모든 이벤트에 `request_id`를 포함한다.
- Queue 중복 전달에 대비해 멱등성을 보장한다.
- Authorization 헤더와 API Key 원문을 저장하지 않는다.
- 민감한 Input/Output은 마스킹한다.

---

## 4.6 개발자 포털

외부 API 사용자용 화면이다.

### 주요 화면

- API 문서
- API Key 발급
- API Key 폐기
- API Key 재발급
- 사용량 조회
- 호출 제한 확인
- 오류 코드 설명
- 예제 코드
- API 상태 확인

운영 대시보드와 별도 애플리케이션으로 분리한다.

```text
api.example.com
developers.example.com
admin.example.com
```

---

# 5. 운영 개발자의 세부 역할

## 5.1 운영자 인증 및 권한

운영 대시보드는 Cloudflare Access로 보호한다.

운영 권한은 자체 RBAC로 세분화한다.

```text
VIEWER
OPERATOR
SECURITY_ADMIN
SYSTEM_ADMIN
```

권한 예시:

| 기능 | VIEWER | OPERATOR | SECURITY_ADMIN | SYSTEM_ADMIN |
|---|---:|---:|---:|---:|
| 호출 이력 조회 | 가능 | 가능 | 가능 | 가능 |
| API Key 일시 차단 | 불가 | 가능 | 가능 | 가능 |
| 차단 해제 | 불가 | 가능 | 가능 | 가능 |
| API Key 영구 폐기 | 불가 | 불가 | 가능 | 가능 |
| 정책 변경 | 불가 | 제한 | 가능 | 가능 |
| 운영자 권한 변경 | 불가 | 불가 | 불가 | 가능 |

---

## 5.2 운영 대시보드 화면

### 요약 화면

- 오늘 총 호출 수
- 성공률
- 평균 응답시간
- P95/P99 응답시간
- 활성 API Key 수
- 차단 API Key 수
- 401/403/429 발생 수
- 5xx 발생 수
- Input/Output 데이터량
- 업스트림별 오류율

### API Key 관리

- API Key 목록
- API Key 상세
- 소유자
- 요금제
- 허용 API
- 분/일/월 호출 제한
- 만료일
- 마지막 사용 시각
- 차단 상태
- 차단 및 해제
- 재발급
- 폐기

### 호출 이력

- request_id
- api_key_id
- endpoint
- method
- 호출 시간
- status_code
- latency
- input_bytes
- output_bytes
- 국가
- Cloudflare colo
- 차단 여부
- 차단 사유
- 원본 로그 위치

### 운영 감사

- 운영자
- 작업 일시
- 작업 종류
- 대상 API Key
- 차단 및 해제 사유
- 변경 전 데이터
- 변경 후 데이터

---

## 5.3 이상 탐지

초기에는 규칙 기반으로 구현한다.

### 탐지 규칙 예시

```text
최근 5분 호출량이 기준 대비 10배 이상
429 비율이 30% 이상
401/403 반복 발생
고유 IP 수 급증
국가 또는 ASN 급변
평균 응답 크기 급증
특정 endpoint 집중 호출
평균 응답시간 급증
5xx 오류율 급증
```

### 이상 이벤트 상태

```text
OPEN
INVESTIGATING
CONFIRMED
FALSE_POSITIVE
RESOLVED
```

초기에는 자동 차단보다 운영자 확인 후 수동 차단을 권장한다.

```text
이상 감지
   ↓
운영자 경고
   ↓
운영자 확인
   ↓
수동 차단
```

규칙이 안정된 이후 제한적으로 자동 차단을 적용한다.

---

## 5.4 차단 및 해제 처리

운영 화면이 D1이나 Durable Object에 직접 접근하지 않는다.

```text
운영 대시보드
   ↓
Admin Worker
   ↓
운영자 인증 및 권한 확인
   ↓
감사 로그 기록
   ↓
Durable Object 상태 변경
   ↓
D1 상태 동기화
```

차단 요청 예시:

```json
{
  "apiKeyId": "key_1234",
  "action": "SUSPEND",
  "reason": "Abnormal request spike",
  "durationMinutes": 60
}
```

### 운영 안전장치

- 차단 사유 필수
- 영구 폐기 전 재확인
- 일시 차단과 영구 폐기 구분
- 자동 해제 시간 설정
- 대량 차단 권한 제한
- 차단 전 영향 범위 표시
- 자동 차단과 수동 차단 구분
- 모든 변경 감사 로그 저장

---

# 6. 공동으로 먼저 정의해야 하는 계약

## 6.1 Public API OpenAPI

파일 예시:

```text
docs/public-api.openapi.yaml
```

포함 내용:

- endpoint
- method
- request schema
- response schema
- 인증 방식
- 오류 코드
- Rate Limit 관련 헤더
- API 버전 정책

---

## 6.2 Admin API OpenAPI

파일 예시:

```text
docs/admin-api.openapi.yaml
```

예시 API:

```http
GET  /internal/api-keys
GET  /internal/api-keys/{id}
GET  /internal/api-keys/{id}/status
POST /internal/api-keys/{id}/suspend
POST /internal/api-keys/{id}/resume
POST /internal/api-keys/{id}/revoke
GET  /internal/requests
GET  /internal/anomalies
```

---

## 6.3 로그 이벤트 스키마

운영 개발자는 화면에 필요한 필드를 제시한다.

API 개발자는 요청 경로에서 해당 필드를 실제로 수집 가능한지 검토한다.

필수 필드:

```text
event_version
request_id
api_key_id
endpoint
method
status_code
latency_ms
input_bytes
output_bytes
country
colo
blocked
block_reason
occurred_at
```

---

## 6.4 API Key 상태 모델

두 개발자가 같은 상태 정의를 사용해야 한다.

```text
PENDING
ACTIVE
SUSPENDED
REVOKED
EXPIRED
```

상태 전이 예시:

```text
PENDING → ACTIVE
ACTIVE → SUSPENDED
SUSPENDED → ACTIVE
ACTIVE → REVOKED
ACTIVE → EXPIRED
SUSPENDED → REVOKED
```

---

## 6.5 데이터 보관 정책

공동으로 다음 사항을 결정한다.

- 호출 메타데이터 보관 기간
- Input/Output 원문 저장 여부
- 민감 데이터 마스킹 기준
- 정상 요청 샘플링 비율
- 오류 요청 저장 비율
- R2 Lifecycle 정책
- 데이터 삭제 요청 처리
- 감사 로그 보관 기간
- 운영자 조회 권한

---

## 6.6 환경 구분

```text
local
development
staging
production
```

환경별로 다음 리소스를 분리한다.

- D1
- R2
- Queue
- Durable Objects
- Analytics Engine
- Cloudflare Access 정책
- API Key
- 비밀값

---

# 7. 작업 순서

## 0단계: 공동 설계

두 개발자가 함께 진행한다.

### 산출물

```text
public-api.openapi.yaml
admin-api.openapi.yaml
api-key-state.md
api-event-schema.json
error-code.md
data-retention.md
architecture.md
```

이 단계가 끝나기 전에 실제 기능 구현을 깊게 진행하면 재작업 가능성이 높다.

---

## 1단계: API 개발자의 선행 작업

운영 개발자가 실제 연동을 시작하기 전에 API 개발자가 다음 계약을 제공한다.

1. Public API OpenAPI 초안
2. API Key 상태 모델
3. 공통 오류 코드
4. 로그 이벤트 스키마
5. 차단 및 해제 API 계약
6. 테스트용 API Key
7. Mock API 또는 Staging Worker
8. 요청별 `request_id` 정책

### 선행 이유

운영 개발자는 다음 정보를 알아야 화면과 운영 API를 확정할 수 있다.

- 어떤 로그 필드가 존재하는가
- API Key 상태가 어떻게 구분되는가
- 어떤 차단 동작이 가능한가
- 어떤 오류를 이상 상황으로 판단할 것인가
- 어떤 사용량 지표를 제공할 수 있는가

---

## 2단계: 병렬 기반 개발

### API 개발자

- API Gateway Worker
- API Key 검증
- 기본 Rate Limit
- `request_id` 생성
- Public API Mock
- Queue Producer
- 개발자 포털 기본 화면
- 공통 오류 응답

### 운영 개발자

- Cloudflare Access 설정
- 운영 대시보드 레이아웃
- 운영자 RBAC
- API Key 목록 Mock 화면
- API Key 상세 Mock 화면
- 호출 이력 Mock 화면
- 이상 탐지 Mock 화면
- Admin Worker 기본 구조

운영 개발자는 실제 API가 완성되지 않아도 Mock 데이터를 사용해 화면을 먼저 개발할 수 있다.

---

## 3단계: 로그 데이터 경로 연동

```text
API Gateway Worker
   ↓
Cloudflare Queue
   ↓
Log Consumer Worker
   ├─ Analytics Engine
   ├─ D1/PostgreSQL
   └─ R2
   ↓
운영 대시보드
```

### API 개발자 담당

- 로그 이벤트 생성
- Queue Producer
- 이벤트 버전 관리
- 민감 데이터 마스킹
- 요청 및 응답 크기 계산
- `request_id` 생성

### 운영 개발자 담당

- Queue Consumer 또는 조회용 집계
- 로그 메타데이터 저장
- 운영 조회 API
- 호출 이력 화면
- API Key별 통계
- 오류율과 응답시간 차트

### 의존성

운영 개발자의 실제 로그 조회 연동은 API 개발자의 이벤트 발행이 먼저 완료되어야 한다.

---

## 4단계: 차단 경로 연동

```text
운영자
   ↓
운영 대시보드
   ↓
Admin Worker
   ↓
Durable Object 상태 변경
   ↓
API Gateway Worker 차단 확인
   ↓
403 또는 429 반환
```

### API 개발자 담당

- Durable Object 상태 모델
- API Gateway 차단 검사
- 차단 오류 응답
- 차단 해제 처리
- 캐시 무효화
- 만료형 차단 처리

### 운영 개발자 담당

- 차단 버튼
- 차단 사유 입력
- 일시 차단
- 영구 폐기
- 차단 해제
- 운영자 감사 기록
- 차단 상태 표시

### 의존성

운영 개발자는 차단 UI를 먼저 만들 수 있다.

그러나 실제 차단 기능은 API 개발자의 API Gateway 차단 집행 로직과 Durable Object 인터페이스가 완료되어야 동작한다.

---

## 5단계: 이상 탐지 구현

실제 호출 로그가 수집된 이후 진행한다.

### 운영 개발자 주도

- 호출량 기준선
- 오류율 임계치
- IP 및 국가 변화
- payload 크기 이상
- 자동 차단 조건
- 경고 심각도
- 이상 이벤트 상태 관리

### API 개발자 지원

- 추가 이벤트 필드 제공
- Cloudflare 국가 및 colo 정보 제공
- 탐지용 요청 메타데이터 제공
- 자동 차단 명령 수신
- 차단 사유 기록

---

## 6단계: 보안 및 장애 테스트

두 개발자가 함께 진행한다.

### API Key 테스트

- 잘못된 API Key
- 만료된 API Key
- 폐기된 API Key
- 일시 차단된 API Key
- 차단 해제된 API Key
- 허용되지 않은 endpoint 호출

### 호출 제한 테스트

- 초당 호출량 초과
- 분당 호출량 초과
- 일간 할당량 초과
- 월간 할당량 초과
- 동시 호출량 초과

### 로그 테스트

- Queue 중복 메시지
- Queue 처리 실패
- R2 저장 실패
- D1 저장 실패
- 민감 데이터 마스킹
- Input/Output 크기 초과

### 운영 권한 테스트

- VIEWER의 차단 요청
- OPERATOR의 영구 폐기 요청
- 권한 없는 운영 API 호출
- Access 우회 시도
- 감사 로그 누락 여부

### 장애 테스트

- D1 장애
- Durable Object 장애
- Queue 장애
- 업스트림 API 장애
- R2 장애
- Analytics Engine 지연
- 운영 대시보드 장애

---

# 8. 역할 간 의존 관계

| 작업 | 선행 담당 | 후속 담당 |
|---|---|---|
| Public API 스펙 | API 개발자 | 운영 개발자 |
| 로그 이벤트 필드 요구사항 | 운영 개발자 | API 개발자 |
| 로그 이벤트 실제 발생 | API 개발자 | 운영 개발자 |
| 호출 이력 화면 | API 개발자 이벤트 필요 | 운영 개발자 |
| API Key 상태 모델 | 공동 | 양쪽 |
| 실제 차단 집행 | API 개발자 | 운영 대시보드 |
| 이상 탐지 규칙 | 운영 개발자 | API 개발자 필드 지원 |
| 운영자 인증 | 운영 개발자 | 독립 진행 가능 |
| 개발자 포털 | API 개발자 | 독립 진행 가능 |
| 감사 로그 | 운영 개발자 | 차단 계약 필요 |
| 차단 상태 UI | 운영 개발자 | API 차단 상태 조회 필요 |

---

# 9. 작업 우선순위

## 최우선

1. API Key 상태 모델
2. Public API OpenAPI
3. Admin API OpenAPI
4. 로그 이벤트 스키마
5. 공통 오류 코드
6. 차단 및 해제 인터페이스

## 두 번째

1. API Gateway Worker
2. Admin Worker
3. Queue Producer
4. 운영 대시보드 Mock 화면
5. 개발자 포털 Mock 화면
6. Cloudflare Access

## 세 번째

1. 로그 Consumer
2. R2 원본 저장
3. D1 조회 인덱스
4. Analytics Engine 지표
5. 실제 호출 이력 화면

## 네 번째

1. Durable Object 차단 상태
2. 실제 차단 집행
3. 차단 및 해제 UI
4. 감사 로그
5. 만료형 차단

## 마지막

1. 이상 탐지
2. 자동 차단
3. 고급 보안 정책
4. 비용 최적화
5. 장기 통계 저장소 분리

---

# 10. 저장소 구성

모노레포 구조를 권장한다.

```text
repository/
├─ apps/
│  ├─ public-api-worker/
│  ├─ developer-portal/
│  ├─ admin-worker/
│  └─ admin-dashboard/
│
├─ packages/
│  ├─ api-contracts/
│  ├─ event-schemas/
│  ├─ shared-types/
│  └─ error-codes/
│
├─ infrastructure/
│  ├─ wrangler/
│  ├─ d1/
│  ├─ r2/
│  ├─ queues/
│  ├─ durable-objects/
│  └─ access/
│
└─ docs/
   ├─ public-api.openapi.yaml
   ├─ admin-api.openapi.yaml
   ├─ api-key-state.md
   ├─ data-retention.md
   └─ architecture.md
```

### 코드 소유권

| 영역 | 담당 |
|---|---|
| public-api-worker | API 개발자 |
| developer-portal | API 개발자 |
| admin-worker | 운영 개발자 |
| admin-dashboard | 운영 개발자 |
| api-contracts | 공동 리뷰 |
| event-schemas | 공동 리뷰 |
| shared-types | 공동 리뷰 |
| error-codes | 공동 리뷰 |
| infrastructure | 리소스별 담당 |

---

# 11. 핵심 설계 원칙

1. API 개발자가 실제 요청 차단을 집행한다.
2. 운영 개발자는 차단 명령과 운영 이력을 관리한다.
3. API 호출마다 D1에 동기 로그를 저장하지 않는다.
4. 로그는 Queue를 통해 비동기 처리한다.
5. 원본 Input/Output은 R2에 저장한다.
6. API Key 원문과 Authorization 헤더는 로그에 저장하지 않는다.
7. 정확한 일/월 사용량은 Rate Limiting 결과만으로 계산하지 않는다.
8. 즉시 차단 상태는 KV만으로 관리하지 않는다.
9. 운영 대시보드는 Cloudflare Access로 보호한다.
10. 자동 차단은 로그와 규칙이 안정된 뒤 적용한다.

---

# 12. 최종 작업 흐름

```text
1. 공동으로 상태, 이벤트, 오류, 차단 계약 정의
2. API 개발자가 OpenAPI와 Mock Worker 제공
3. 운영 개발자가 Mock 기반 대시보드 개발
4. API 개발자가 인증, Rate Limit, Queue 구현
5. 운영 개발자가 로그 저장 및 조회 화면 구현
6. API 개발자가 실제 차단 집행 구현
7. 운영 개발자가 차단 및 해제 UI 연동
8. 실제 트래픽 기반 이상 탐지 구현
9. 보안, 장애, 권한 테스트
10. 제한적인 자동 차단 적용
```

가장 먼저 해야 하는 작업은 특정 개발자 한 명의 구현이 아니다.

먼저 두 개발자가 공동으로 다음 계약을 정의해야 한다.

```text
API Key 상태
Public API 스펙
Admin API 스펙
로그 이벤트 스키마
오류 코드
차단 및 해제 인터페이스
데이터 보관 정책
```

계약이 정해진 이후 기술적 선행 작업은 API 개발자가 진행한다.

운영 개발자는 API 개발자의 실제 구현을 기다리지 않고 Mock API와 Mock 데이터를 사용해 운영 화면, 권한 구조, Access 설정을 병렬로 개발한다.
---

# 13. 운영 유지비 및 과설계 검토

## 13.1 검토 결론

기존 설계는 트래픽과 운영 조직이 성장한 이후까지 고려한 확장형 구조다.

초기 단계에서는 다음 항목이 실제 기능보다 운영 복잡성과 유지비를 더 크게 만들 수 있다.

1. 모든 요청에 Durable Objects 적용
2. Analytics Engine, D1, R2, Workers Logs 중복 기록
3. 모든 Input/Output 원문 저장
4. D1과 PostgreSQL 동시 운영
5. 초기부터 자동 이상 탐지 및 자동 차단
6. 세분화된 운영자 RBAC
7. API Key 셀프서비스가 포함된 자체 개발자 포털
8. API Shield Enterprise 도입

초기 MVP에서는 다음 원칙을 적용한다.

```text
필요성이 명확한 기능만 도입
데이터 원본 저장소는 하나로 제한
로그 저장 경로 중복 최소화
자동 차단보다 수동 차단 우선
실시간 강한 일관성이 필요할 때만 Durable Objects 도입
```

---

## 13.2 기능별 초기 도입 판단

| 항목 | 초기 판단 | 검토 이유 |
|---|---|---|
| Workers | 유지 | API Gateway와 Public API 실행에 필요 |
| Workers Static Assets | 유지 | 개발자 포털과 운영 화면 배포에 적합 |
| 기본 WAF | 유지 | 외부 API 방어에 필요 |
| Workers Rate Limiting | 유지 | 순간 폭주와 반복 호출 방어에 필요 |
| D1 또는 PostgreSQL | 하나만 선택 | 이중 저장과 상태 불일치 방지 |
| Cloudflare Access | 유지 | 운영 대시보드 보호에 적합 |
| Queues | 조건부 유지 | 호출 이력이 서비스 기능이면 유지 |
| R2 | 선택적 유지 | 오류 또는 지정 요청의 원문 저장에 사용 |
| Durable Objects | 초기 보류 | 정확한 전역 상태가 필요할 때 추가 |
| Analytics Engine | 초기 보류 | D1 집계와 Workers 지표로 시작 가능 |
| Workers Logs 전체 기록 | 축소 | 장애 및 디버깅 로그에만 사용 |
| 전체 Input/Output 저장 | 제외 | 보안과 데이터 관리 비용이 큼 |
| 자동 이상 탐지 | 초기 보류 | 오탐 및 운영 대응 비용 증가 |
| 자동 차단 | 초기 보류 | 초기에는 운영자 수동 확인 권장 |
| 세분화된 RBAC | 축소 | 소규모 운영 조직에는 과함 |
| API Key 셀프서비스 | 초기 보류 | 수동 발급으로 시작 가능 |
| API Shield Enterprise | 초기 제외 | 초기 요구사항 대비 비용이 큼 |

---

# 14. 과설계 가능성이 높은 영역

## 14.1 모든 요청에 Durable Objects 적용

### 확장형 구조

```text
모든 API 요청
   ↓
Durable Object
   ↓
API Key 상태 확인
   ↓
정확한 카운터 증가
   ↓
API 실행
```

다음 요구사항이 있을 때만 필요하다.

- 전 세계에서 차단 상태를 수 초 안에 반영
- 일간 또는 월간 사용량을 실시간으로 정확하게 차단
- API Key별 동시 호출량을 정확하게 제한
- 강한 일관성이 필요한 과금 카운터
- 여러 요청 간 순차 처리 보장

### 초기 대안

```text
API Key 및 차단 상태
→ D1 또는 PostgreSQL

순간 호출 제한
→ Workers Rate Limiting

사용량 집계
→ Queue 기반 비동기 로그 집계
```

### 도입 기준

| 조건 | 권장 |
|---|---|
| 차단 반영 지연을 일부 허용 | D1 또는 PostgreSQL |
| 사용량이 참고 지표 | 비동기 집계 |
| 정확한 실시간 과금 필요 | Durable Objects 또는 중앙 과금 DB |
| API Key별 동시 실행 제한 필요 | Durable Objects |
| 수 초 내 글로벌 차단 필요 | Durable Objects |

초기에는 Durable Objects 없이 시작하고, 정확한 전역 상태가 실제 요구사항으로 확정될 때 추가하는 편이 낫다.

---

## 14.2 로그 저장소 중복

다음 데이터를 동시에 모두 기록하면 역할이 중복된다.

```text
Workers Logs
Analytics Engine
D1
R2
```

초기에는 저장소별 역할을 다음처럼 제한한다.

```text
Workers Logs
├─ Worker 예외
├─ 업스트림 연결 실패
├─ Queue 발행 실패
└─ 배포 디버깅

D1 또는 PostgreSQL
├─ API 호출 메타데이터
├─ API Key별 사용량 집계
├─ 차단 이력
└─ 운영 감사 로그

R2
├─ 오류 요청의 마스킹된 원문
├─ 운영자가 지정한 요청의 원문
└─ 대형 로그 파일

Analytics Engine
└─ 초기에는 제외
```

Analytics Engine은 다음 조건이 발생할 때 추가한다.

- API Key와 endpoint 조합이 많아 통계 쿼리가 복잡해짐
- D1 또는 PostgreSQL의 통계 쿼리 부하가 증가함
- 초 단위 또는 분 단위 실시간 차트가 중요해짐
- 운영 지표의 고카디널리티 분석이 필요해짐

---

## 14.3 모든 Input/Output 원문 저장

모든 요청과 응답을 저장하면 저장 비용보다 운영 비용이 더 커질 수 있다.

### 추가되는 운영 부담

- 개인정보 및 민감정보 마스킹
- 데이터 삭제 요청 대응
- 운영자 열람 권한 관리
- 보관 기간과 파기 정책 관리
- 유출 사고 대응
- 대형 payload 처리
- API 스키마 변경 대응
- 작은 R2 객체의 대량 생성
- 원문 조회 감사 로그 관리

### 권장 저장 정책

| 데이터 | 저장 정책 |
|---|---|
| request_id | 항상 저장 |
| api_key_id | 항상 저장 |
| endpoint, method | 항상 저장 |
| status_code | 항상 저장 |
| latency | 항상 저장 |
| input_bytes, output_bytes | 항상 저장 |
| 요청 및 응답 원문 | 기본 미저장 |
| 4xx 및 5xx 원문 | 마스킹 후 선택 저장 |
| 정상 요청 원문 | 샘플링 또는 미저장 |
| 대형 payload | 크기, 해시, 참조만 저장 |
| Authorization | 저장 금지 |
| API Key 원문 | 저장 금지 |
| Cookie 및 Token | 저장 금지 |

### 권장 처리 예시

```text
정상 2xx 요청
→ 메타데이터만 저장

4xx 또는 5xx 요청
→ 민감정보를 마스킹한 일부 body 저장

운영자가 추적 대상으로 지정한 API Key
→ 제한된 기간 동안 상세 로그 저장
```

---

## 14.4 D1과 PostgreSQL 동시 운영

API Key와 운영 상태를 D1과 PostgreSQL에 동시에 저장하면 다음 문제가 발생한다.

- 원본 데이터 저장소가 불명확해짐
- 차단 상태 불일치
- 이중 쓰기 실패
- 재처리 로직 필요
- 마이그레이션 두 벌 관리
- 장애 분석 어려움
- 개발자 간 책임 경계 불명확

### Cloudflare 중심 MVP

```text
D1
├─ API Key
├─ API Key 정책
├─ 호출 메타데이터
├─ 운영자 감사 로그
└─ 단순 사용량 집계
```

### 기존 AWS/GCP 백엔드 중심

```text
PostgreSQL
├─ 고객
├─ API Key
├─ 요금제
├─ API 정책
├─ 사용량 원장
└─ 운영 감사 로그

Cloudflare Worker
└─ PostgreSQL 접근 또는 백엔드 API 호출
```

### 선택 원칙

```text
Cloudflare에서 독립된 MVP를 구축
→ D1 선택

기존 서비스의 고객, 결제, 요금제가 PostgreSQL에 존재
→ PostgreSQL 선택

초기에는 D1과 PostgreSQL을 동시에 원본으로 사용하지 않음
```

---

## 14.5 Queue 사용 여부

Queue는 무조건 과한 기능은 아니다.

호출 이력이 서비스 기능이거나 과금 근거라면 유지하는 것이 적절하다.

### Queue 유지 조건

- 고객에게 호출 이력을 제공
- 사용량이 과금 기준
- 로그 유실을 허용할 수 없음
- 실패 시 재시도 필요
- API 응답과 로그 저장을 분리해야 함
- 장애 후 재처리가 필요

### Queue 생략 가능 조건

- 내부 테스트 단계
- 로그 일부 유실 허용
- 과금과 무관
- 호출량이 작음
- 디버깅 목적의 로그만 필요

### Queue 없는 단순 구조

```text
API 응답
   ↓
응답 이후 비동기 작업
   └─ D1 또는 PostgreSQL에 메타데이터 저장
```

### 권장 판단

현재 요구사항에는 API Key별 호출 이력과 이상 탐지가 포함된다.

따라서 MVP에서도 Queue를 유지하는 편이 안전하다.

다만 Consumer, 재시도, Dead Letter Queue, 중복 처리 로직이 필요하다는 점을 고려해야 한다.

---

## 14.6 운영자 RBAC 축소

초기부터 다음 네 역할을 모두 운영할 필요는 없다.

```text
VIEWER
OPERATOR
SECURITY_ADMIN
SYSTEM_ADMIN
```

운영 인원이 적다면 다음 두 역할로 시작한다.

```text
VIEWER
ADMIN
```

또는 운영자가 극소수라면 다음 구조도 가능하다.

```text
Cloudflare Access 허용 사용자
+
영구 폐기와 대량 차단만 추가 확인
```

Cloudflare Access 자체는 유지한다.

축소 대상은 Access가 아니라 자체 RBAC의 복잡도다.

---

## 14.7 자동 이상 탐지 및 자동 차단

초기부터 다음 기능을 구현하면 유지비가 커진다.

- 사용자별 기준선 학습
- 국가 및 ASN 이동 탐지
- 호출 순서 분석
- 이상 점수 모델
- 자동 차단
- 오탐 복구
- 예외 고객 관리
- 탐지 규칙 버전 관리

초기에는 고정 임계치 기반으로 시작한다.

```text
최근 5분 호출량 > 설정 임계치
429 비율 > 설정 임계치
5xx 비율 > 설정 임계치
API Key별 고유 IP 수 급증
요청 크기 제한 초과 반복
인증 실패 반복
```

처리 흐름:

```text
이상 감지
   ↓
운영 대시보드 경고
   ↓
운영자 확인
   ↓
수동 차단
```

자동 차단은 악성 패턴과 오탐 사례가 충분히 축적된 이후 적용한다.

---

## 14.8 개발자 포털 축소

초기 개발자 포털에 다음 기능을 모두 넣으면 개발 및 운영 범위가 커진다.

- 회원가입
- API Key 셀프 발급
- API Key Rotation
- 사용량 차트
- 결제
- 요금제 변경
- Webhook
- 팀원 권한
- API Key 소유권 이전

초기에는 다음 기능만 제공한다.

```text
developers.example.com
├─ OpenAPI 기반 API 문서
├─ 호출 예제
├─ 오류 코드
├─ 인증 방식
├─ 사용 제한 정책
└─ 문의 경로
```

API Key는 운영자가 수동 생성해 전달한다.

셀프서비스는 수동 발급이 실제 운영 병목이 될 때 추가한다.

---

## 14.9 API Shield Enterprise

초기에는 다음 기능으로 충분하다.

```text
기본 WAF
Workers Rate Limiting
허용 method 제한
Content-Type 검사
요청 크기 제한
Worker 내부 스키마 검증
```

다음 조건이 생길 때 API Shield Enterprise를 검토한다.

- 고객사가 mTLS를 요구
- 고급 API Discovery가 필요
- JWT 검증을 Cloudflare 계층에서 통합해야 함
- BOLA 및 API Sequence 분석이 필요
- 규제 또는 보안 인증 요구사항이 있음

초기 요구사항만으로는 Enterprise 기능을 도입할 필요가 없다.

---

# 15. MVP 권장 구조

## 15.1 권장 아키텍처

```text
API 사용자
   │
   ▼
Cloudflare Edge
├─ DDoS Protection
├─ 기본 WAF
└─ Workers Rate Limiting
   │
   ▼
Public API Worker
├─ API Key 검증
├─ 차단 상태 확인
├─ 허용 endpoint 확인
├─ 요청 크기 및 Content-Type 확인
├─ request_id 생성
└─ 실제 API 호출
   │
   └─ Cloudflare Queue
          │
          ▼
      Log Consumer Worker
          ├─ D1 또는 PostgreSQL
          │   ├─ 호출 메타데이터
          │   ├─ API Key 상태
          │   ├─ 사용량 집계
          │   └─ 감사 로그
          │
          └─ R2
              └─ 오류 및 선택 요청 원문

운영자
   │
   ▼
Cloudflare Access
   │
   ▼
Admin Dashboard + Admin Worker
├─ API Key 조회
├─ 호출 이력 조회
├─ 기본 이상 경고
├─ 일시 차단
├─ 차단 해제
└─ 감사 로그
```

---

## 15.2 MVP 유지 항목

```text
Workers
Workers Static Assets
기본 WAF
Workers Rate Limiting
D1 또는 PostgreSQL 중 하나
Cloudflare Access
Queues
선택적 R2
수동 차단
기본 감사 로그
```

---

## 15.3 MVP 제외 항목

```text
Durable Objects
Analytics Engine
전체 Input/Output 저장
자동 차단
고급 이상 탐지
세분화된 4단계 RBAC
API Key 셀프서비스
D1과 PostgreSQL 이중 저장
API Shield Enterprise
```

---

# 16. 단계별 확장 기준

## 16.1 1단계: 내부 테스트

```text
Workers
D1 또는 PostgreSQL
Cloudflare Access
기본 WAF
기본 Rate Limit
Workers Logs
```

특징:

- API Key 수동 발급
- 호출 이력 일부 저장
- 운영자 수동 차단
- 원문 로그 기본 미저장
- Queue는 로그 중요도에 따라 선택

---

## 16.2 2단계: 외부 고객 제공

```text
Workers
Queues
D1 또는 PostgreSQL
선택적 R2
Cloudflare Access
기본 운영 대시보드
```

추가 기능:

- 안정적인 호출 이력 수집
- API Key별 사용량 제공
- 오류 요청 원문 선택 저장
- 차단 및 해제 감사 로그
- 운영 임계치 기반 경고

---

## 16.3 3단계: 과금 및 사용량 제한

다음 기능을 검토한다.

```text
정확한 사용량 원장
계약별 사용량 한도
월간 과금 집계
사용량 재처리
중복 이벤트 제거
```

이 단계에서 Durable Objects 또는 중앙 과금 DB를 검토한다.

---

## 16.4 4단계: 대규모 운영

다음 기능을 검토한다.

```text
Analytics Engine
고급 이상 탐지
자동 차단
세분화된 RBAC
API Key 셀프서비스
별도 분석 DB
API Shield Enterprise
```

도입은 트래픽과 운영 병목이 실제로 확인된 후 진행한다.

---

# 17. 역할별 비용 최적화 책임

## 17.1 API 개발자

다음 항목을 검토한다.

- 모든 요청이 불필요하게 Durable Object를 거치지 않는지
- API 응답 전에 로그 저장을 기다리지 않는지
- 정상 요청의 Input/Output 원문을 저장하지 않는지
- 요청 및 응답 body를 메모리에 전부 적재하지 않는지
- 동일 데이터를 여러 저장소에 중복 기록하지 않는지
- Rate Limit과 정확한 사용량 집계를 구분했는지
- 불필요한 외부 API 및 DB 왕복이 없는지

---

## 17.2 운영 개발자

다음 항목을 검토한다.

- 운영 대시보드가 원본 로그를 반복적으로 직접 조회하지 않는지
- 통계 조회에 적절한 집계 테이블을 사용하는지
- 과도하게 짧은 주기로 대시보드를 갱신하지 않는지
- 전체 로그를 무제한 보관하지 않는지
- 운영자가 필요하지 않은 원문을 열람하지 않도록 제한했는지
- 자동 탐지 규칙이 과도한 이벤트와 오탐을 발생시키지 않는지
- 운영 권한 체계가 실제 운영 인원보다 복잡하지 않은지

---

## 17.3 공동 책임

다음 항목은 공동으로 관리한다.

- 데이터 원본 저장소 결정
- 로그 보관 기간
- R2 Lifecycle 정책
- 정상 요청 샘플링 비율
- 오류 로그 저장 비율
- API Key 차단 반영 시간
- 사용량 정확성 수준
- 비용 임계치 및 알림
- Cloudflare 플랜 변경 기준

---

# 18. 개정된 최종 작업 순서

```text
1. 공동으로 API Key 상태, API 스펙, 로그 이벤트 계약 정의
2. D1과 PostgreSQL 중 원본 저장소 하나를 선택
3. API 개발자가 Public API Mock과 이벤트 스키마 제공
4. 운영 개발자가 Mock 기반 대시보드와 Access 설정
5. API 개발자가 인증, 기본 Rate Limit, request_id 구현
6. Queue 필요성을 확정하고 로그 경로 구현
7. 운영 개발자가 메타데이터 조회 및 수동 차단 구현
8. R2는 오류 및 지정 요청에만 선택적으로 적용
9. 실제 트래픽으로 임계치 기반 이상 경고 구현
10. Durable Objects와 Analytics Engine은 필요성 확인 후 도입
11. 자동 차단과 고급 RBAC는 운영 데이터 축적 후 검토
12. 과금 또는 대규모 운영 단계에서 별도 분석 및 사용량 시스템 확장
```

---

# 19. 최종 권장안

현재 요구사항에서는 다음 구성이 가장 균형이 좋다.

```text
Cloudflare Workers
Workers Static Assets
기본 WAF
Workers Rate Limiting
Cloudflare Access
Cloudflare Queues
D1 또는 PostgreSQL 중 하나
선택적 R2
수동 API Key 차단
기본 운영 감사 로그
```

초기에는 다음 기능을 제외한다.

```text
Durable Objects
Analytics Engine
전체 Input/Output 원문 저장
자동 이상 탐지
자동 차단
세분화된 운영자 RBAC
API Key 셀프서비스
D1과 PostgreSQL 이중 원본
API Shield Enterprise
```

가장 먼저 축소해야 하는 영역은 다음 세 가지다.

1. 모든 Input/Output 원문 저장
2. D1과 PostgreSQL 이중 운영
3. 초기 자동 이상 탐지 및 자동 차단

Queues는 호출 이력이 사용자 기능 또는 과금 근거라면 유지한다.

Durable Objects와 Analytics Engine은 초기 필수 요소가 아니며, 정확한 글로벌 상태와 대규모 시계열 분석이 실제 요구사항으로 확인된 이후 추가한다.

---

# 20. Cloudflare IaC 전략

## 20.1 결론

Cloudflare도 Terraform Provider를 통해 주요 인프라와 보안 설정을 코드로 관리할 수 있다.

현재 구조에서는 Terraform과 Wrangler의 역할을 다음처럼 분리한다.

```text
Terraform
= 공유 인프라, 보안 정책, 영속 리소스

Wrangler
= Worker 애플리케이션, 바인딩, 정적 자산, 배포, D1 마이그레이션
```

가장 중요한 원칙은 다음과 같다.

```text
하나의 Cloudflare 리소스를
Terraform, Wrangler, Dashboard가 동시에 관리하지 않는다.
```

같은 리소스를 여러 도구가 동시에 관리하면 다음 문제가 발생한다.

- Terraform State와 실제 리소스 불일치
- Dashboard 변경으로 인한 Drift
- Wrangler 배포 시 설정 덮어쓰기
- 변경 주체 추적 어려움
- 장애 발생 시 원인 파악 지연

---

# 21. Terraform과 Wrangler의 관리 경계

## 21.1 Terraform 담당 영역

Terraform은 수명이 길고 여러 애플리케이션에서 공유되는 리소스를 관리한다.

| 영역 | 관리 방식 |
|---|---|
| DNS Record | Terraform |
| D1 Database 리소스 생성 | Terraform |
| R2 Bucket 생성 | Terraform |
| R2 Lifecycle 정책 | Terraform |
| Queue 생성 | Terraform |
| WAF Custom Rules | Terraform |
| WAF Managed Rules 설정 | Terraform |
| Zone Rate Limiting Rules | Terraform |
| Cloudflare Access Application | Terraform |
| Cloudflare Access Policy | Terraform |
| 환경별 리소스 이름 | Terraform |
| Terraform Remote State | R2 또는 별도 Backend |

Terraform은 인프라 생성과 정책 관리에 사용하고, 애플리케이션 코드 배포에는 사용하지 않는 것을 기본 방침으로 한다.

## 21.2 Wrangler 담당 영역

Wrangler는 Worker 애플리케이션과 배포 단위를 관리한다.

| 영역 | 관리 방식 |
|---|---|
| Public API Worker | Wrangler |
| Admin Worker | Wrangler |
| Log Consumer Worker | Wrangler |
| 개발자 포털 정적 자산 | Wrangler |
| 운영 대시보드 정적 자산 | Wrangler |
| Worker와 D1 Binding | Wrangler |
| Worker와 R2 Binding | Wrangler |
| Worker와 Queue Binding | Wrangler |
| Queue Producer/Consumer 연결 | Wrangler |
| Worker 환경변수 | Wrangler |
| Compatibility Date/Flags | Wrangler |
| D1 SQL Migration | Wrangler |
| Worker 버전 배포 및 롤백 | Wrangler |

## 21.3 Terraform으로 Worker 코드까지 관리하지 않는 이유

Terraform으로 Worker 코드와 배포까지 관리할 수 있지만, 현재 구조에서는 권장하지 않는다.

- 단순 코드 배포에도 `terraform plan`과 `terraform apply`가 필요
- 인프라 변경과 애플리케이션 배포가 결합됨
- Worker 코드 변경이 Terraform State에 영향을 줌
- Worker 롤백이 Terraform 롤백과 연결됨
- API 개발자와 운영 개발자가 동일 State를 자주 수정
- 배포 주기가 긴 인프라와 짧은 애플리케이션이 결합됨

권장 구조:

```text
Terraform
├─ D1 리소스
├─ R2 리소스
├─ Queue
├─ DNS
├─ WAF
├─ Rate Limit
└─ Access

Wrangler
├─ Worker 코드
├─ Worker Binding
├─ Static Assets
├─ D1 Migration
└─ Worker Deployment
```

대규모 조직에서 모든 배포를 중앙 승인 방식으로 통제해야 할 때만 Worker 버전과 배포를 Terraform 관리 대상으로 검토한다.

---

# 22. IaC가 반영된 전체 아키텍처

```text
Git Repository
│
├─ infrastructure/
│   └─ Terraform
│       ├─ DNS
│       ├─ D1 Database
│       ├─ R2 Bucket
│       ├─ Queue
│       ├─ WAF
│       ├─ Rate Limiting
│       └─ Cloudflare Access
│
├─ apps/public-api-worker/
│   └─ Wrangler
│       ├─ API Worker
│       ├─ D1/R2/Queue Binding
│       └─ Public API Route
│
├─ apps/log-consumer-worker/
│   └─ Wrangler
│       ├─ Queue Consumer
│       └─ 로그 저장
│
├─ apps/admin-worker/
│   └─ Wrangler
│       ├─ Admin API
│       └─ D1/R2 Binding
│
├─ apps/developer-portal/
│   └─ Wrangler Static Assets
│
└─ apps/admin-dashboard/
    └─ Wrangler Static Assets
```

실제 요청 흐름:

```text
API 사용자
   ↓
Terraform으로 관리되는 WAF / Rate Limit
   ↓
Wrangler로 배포된 Public API Worker
   ├─ D1 또는 PostgreSQL
   ├─ Queue
   └─ 실제 API
         ↓
Queue
   ↓
Log Consumer Worker
   ├─ D1 또는 PostgreSQL
   └─ 선택적 R2

운영자
   ↓
Terraform으로 관리되는 Cloudflare Access
   ↓
Admin Dashboard / Admin Worker
```

---

# 23. 권장 저장소 구조

```text
repository/
├─ apps/
│  ├─ public-api-worker/
│  │  ├─ src/
│  │  ├─ migrations/
│  │  ├─ wrangler.jsonc
│  │  └─ package.json
│  │
│  ├─ log-consumer-worker/
│  │  ├─ src/
│  │  ├─ wrangler.jsonc
│  │  └─ package.json
│  │
│  ├─ admin-worker/
│  │  ├─ src/
│  │  ├─ wrangler.jsonc
│  │  └─ package.json
│  │
│  ├─ developer-portal/
│  └─ admin-dashboard/
│
├─ packages/
│  ├─ api-contracts/
│  ├─ event-schemas/
│  ├─ shared-types/
│  └─ error-codes/
│
├─ infrastructure/
│  ├─ bootstrap/
│  │  └─ terraform-state/
│  ├─ modules/
│  │  ├─ storage/
│  │  ├─ queues/
│  │  ├─ waf/
│  │  ├─ access/
│  │  └─ dns/
│  └─ environments/
│     ├─ development/
│     ├─ staging/
│     └─ production/
│
└─ .github/
   └─ workflows/
      ├─ terraform-plan.yml
      ├─ terraform-apply.yml
      ├─ deploy-public-api.yml
      ├─ deploy-admin.yml
      └─ deploy-log-consumer.yml
```

---

# 24. 환경별 Terraform 구성

환경별로 디렉터리와 State를 분리한다.

```text
infrastructure/environments/
├─ development/
│  ├─ backend.tf
│  ├─ main.tf
│  ├─ variables.tf
│  └─ terraform.tfvars
├─ staging/
└─ production/
```

환경별 리소스 이름도 분리한다.

```text
api-platform-dev-db
api-platform-staging-db
api-platform-prod-db

api-logs-dev
api-logs-staging
api-logs-prod

api-events-dev
api-events-staging
api-events-prod
```

Terraform Workspace 하나로 모든 환경을 구분하기보다 디렉터리와 State를 환경별로 분리하는 편이 안전하다.

- Production State 오조작 가능성 감소
- 환경별 권한 분리 가능
- Plan 결과가 명확함
- 환경별 승인 정책 적용 가능
- 장애 영향 범위 제한

---

# 25. Terraform State 관리

## 25.1 Remote State

Terraform State는 다음 중 하나를 사용한다.

```text
Cloudflare R2 Remote Backend
또는
기존 조직 표준 Backend
```

R2를 사용하는 경우 State Bucket은 일반 업무용 R2 Bucket과 분리한다.

```text
terraform-state/
├─ development/cloudflare.tfstate
├─ staging/cloudflare.tfstate
└─ production/cloudflare.tfstate
```

## 25.2 Bootstrap

Terraform State를 저장할 R2 Bucket은 해당 State를 사용하는 Terraform 코드 자체로 처음부터 만들 수 없다.

```text
1. Dashboard, Wrangler 또는 별도 Bootstrap Terraform으로 State용 R2 Bucket 생성
2. Backend 설정 작성
3. terraform init
4. 이후 Cloudflare 인프라를 Terraform으로 생성
```

Bootstrap 리소스는 일반 인프라와 분리한다.

```text
infrastructure/bootstrap/terraform-state/
```

## 25.3 State 보안

- State Bucket Public Access 금지
- 업무 로그 Bucket과 State Bucket 분리
- CI 전용 Credential 사용
- 개발자 개인 Credential 공유 금지
- Terraform Output에 비밀값 출력 금지
- Production Apply 권한 제한
- State 백업 및 버전 관리
- 동일 환경 동시 Apply 금지

---

# 26. Terraform 모듈 구성

```text
infrastructure/modules/
├─ storage/
│  ├─ d1.tf
│  ├─ r2.tf
│  ├─ variables.tf
│  └─ outputs.tf
├─ queues/
├─ waf/
├─ access/
└─ dns/
```

모듈화 대상:

- 환경별 반복되는 D1, R2, Queue
- API와 Admin 도메인
- WAF 기본 규칙
- Access Application과 Policy
- 공통 이름 규칙

과도하게 모듈화하지 않을 영역:

- 한 환경에서만 사용하는 단일 규칙
- 실험적 리소스
- 요구사항이 확정되지 않은 구조
- 자주 변경되는 Worker 애플리케이션 설정

---

# 27. Terraform Output과 Wrangler 연결

Terraform이 만든 리소스 이름과 ID를 Wrangler 배포 단계에서 사용한다.

```hcl
output "d1_database_id" {
  value = cloudflare_d1_database.api.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.api.name
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.api_logs.name
}

output "queue_name" {
  value = cloudflare_queue.api_events.queue_name
}
```

CI에서 Output을 추출한다.

```bash
terraform output -json > infrastructure-output.json
```

이 값을 기반으로 환경별 Wrangler 설정을 생성한다.

```json
{
  "env": {
    "production": {
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "api-platform-prod-db",
          "database_id": "${D1_DATABASE_ID}"
        }
      ],
      "r2_buckets": [
        {
          "binding": "API_LOGS",
          "bucket_name": "api-platform-prod-logs"
        }
      ],
      "queues": {
        "producers": [
          {
            "binding": "API_EVENTS",
            "queue": "api-platform-prod-events"
          }
        ]
      }
    }
  }
}
```

권장 연결 방식:

1. `wrangler.template.jsonc`를 CI에서 렌더링
2. Terraform Output을 GitHub Actions 환경변수로 전달
3. 배포 전 임시 Wrangler 설정 파일 생성

Terraform Output에는 리소스 ID, 이름, 도메인 등 비민감 값만 포함한다.

---

# 28. 비밀값 관리

Terraform과 Wrangler 설정 파일에 실제 비밀값을 직접 기록하지 않는다.

권장 저장 위치:

```text
GitHub Actions Secret
Cloudflare Wrangler Secret
외부 Secret Manager
환경별 CI Credential
```

Worker Secret 예시:

```bash
wrangler secret put API_SECRET --env production
```

IaC는 Secret의 존재와 이름만 알고 실제 값은 관리하지 않는 구조가 적절하다.

---

# 29. WAF와 Rate Limit 관리

WAF와 Zone Rate Limiting은 Terraform으로 관리한다.

관리 원칙:

- 동일 Phase의 Ruleset은 한 곳에서 관리
- API 개발자와 운영 개발자가 별도 Ruleset을 만들지 않음
- 규칙 추가는 Pull Request로 진행
- 긴급 변경 후 반드시 Terraform 코드에 반영
- Rule 설명과 목적을 명확히 작성
- Production 적용 전 Staging 검증

```text
WAF Ruleset
├─ 허용하지 않는 method 차단
├─ 비정상 Content-Type 차단
├─ 과도한 요청 크기 차단
├─ 알려진 공격 패턴 차단
└─ 관리자 경로 보호

Rate Limit Ruleset
├─ IP 기반 기본 제한
├─ endpoint별 제한
├─ 인증 실패 반복 제한
└─ 관리자 API 강화 제한
```

API Key별 동적 제한은 Worker 내부에서 처리한다.

```text
Zone Rate Limit
= IP, 경로, 기본 공격 방어

Worker Rate Limit
= API Key, 요금제, endpoint 기반 동적 제한
```

---

# 30. Cloudflare Access 관리

Cloudflare Access는 Terraform으로 관리한다.

대상:

```text
admin.example.com
internal-api.example.com
운영용 Preview 환경
```

Access 정책:

- 허용 이메일 도메인
- 허용 사용자 그룹
- 운영자 MFA 요구
- Service Token
- 환경별 접근 분리
- Production 접근 제한

역할 구분:

```text
Cloudflare Access
= 운영 대시보드에 들어올 수 있는 사람

자체 RBAC
= 들어온 운영자가 수행할 수 있는 작업
```

---

# 31. D1 마이그레이션 관리

D1 Database 리소스 생성은 Terraform이 담당한다.

D1 스키마 변경은 Wrangler가 담당한다.

```text
Terraform
→ D1 Database 생성

Wrangler
→ CREATE TABLE, ALTER TABLE, INDEX 등 스키마 마이그레이션
```

```text
apps/public-api-worker/
└─ migrations/
   ├─ 0001_initial.sql
   ├─ 0002_add_api_key_status.sql
   └─ 0003_add_request_index.sql
```

배포 순서:

```text
1. 마이그레이션 검증
2. Staging 적용
3. Worker 호환성 확인
4. Production 마이그레이션 적용
5. Worker 배포
6. Smoke Test
```

스키마와 Worker 코드가 동시에 변경되는 경우 하위 호환성을 유지한다.

```text
1차 배포: 새 컬럼 추가
2차 배포: 새 컬럼을 사용하는 Worker 배포
3차 배포: 더 이상 사용하지 않는 컬럼 제거
```

---

# 32. CI/CD 파이프라인

## 32.1 Terraform Plan

Pull Request마다 실행한다.

```text
terraform fmt -check
terraform init
terraform validate
terraform plan
```

Production Apply는 승인 단계를 둔다.

## 32.2 Terraform Apply

```text
main 브랜치 병합
   ↓
환경 선택
   ↓
Production 승인
   ↓
terraform apply
```

## 32.3 Worker 배포

```text
코드 테스트
   ↓
타입 검사
   ↓
빌드
   ↓
D1 Migration 확인
   ↓
wrangler deploy
   ↓
Smoke Test
```

각 Worker는 독립적으로 배포할 수 있어야 한다.

```text
deploy-public-api.yml
deploy-admin.yml
deploy-log-consumer.yml
deploy-developer-portal.yml
deploy-admin-dashboard.yml
```

---

# 33. 최초 환경 구축 순서

```text
1. Cloudflare Account와 Zone 준비
2. CI 전용 Cloudflare API Token 발급
3. Terraform State용 R2 Bucket Bootstrap
4. Terraform Backend 설정
5. terraform init
6. terraform plan
7. terraform apply
   ├─ D1
   ├─ R2
   ├─ Queue
   ├─ DNS
   ├─ WAF
   ├─ Rate Limit
   └─ Access
8. Terraform Output 추출
9. Wrangler 환경 설정 생성
10. D1 Migration 적용
11. Log Consumer Worker 배포
12. Public API Worker 배포
13. Admin Worker 배포
14. 개발자 포털 배포
15. 운영 대시보드 배포
16. Access, WAF, Rate Limit 검증
17. End-to-End Smoke Test
```

Log Consumer Worker를 먼저 배포하는 이유는 로그 이벤트를 받을 Consumer가 없는 상태를 줄이기 위해서다.

---

# 34. 일반 배포 순서

## 34.1 애플리케이션 변경

```text
1. 테스트
2. 타입 검사
3. 계약 스키마 호환성 검사
4. D1 Migration 필요 여부 확인
5. Worker 배포
6. Smoke Test
7. 문제 발생 시 Worker 롤백
```

## 34.2 인프라 변경

```text
1. terraform fmt
2. terraform validate
3. terraform plan
4. Pull Request 검토
5. Production 승인
6. terraform apply
7. Terraform Output 변경 확인
8. Wrangler Binding 변경
9. Worker 재배포
10. Smoke Test
```

---

# 35. 개발자별 IaC 책임

## 35.1 API 개발자

직접 담당:

- Public API Worker
- 개발자 포털
- API Key 인증
- Worker 내부 Rate Limit
- Queue Producer
- Public API Wrangler 설정
- D1 마이그레이션
- Public API Smoke Test

Terraform 변경 요청 또는 공동 작업:

- D1 리소스 추가
- Queue 추가
- Public API DNS
- API 경로 WAF 정책
- Zone Rate Limit 정책
- R2 저장 요구사항

## 35.2 운영 대시보드 개발자

직접 담당:

- Admin Worker
- Admin Dashboard
- Log Consumer Worker
- 운영 조회 API
- 수동 차단
- 운영 감사 로그
- Admin Wrangler 설정
- 운영 화면 Smoke Test

Terraform 변경 요청 또는 공동 작업:

- Cloudflare Access
- Admin DNS
- 로그용 R2 Lifecycle
- 관리자 경로 WAF
- 운영 대시보드 보안 정책

## 35.3 IaC 최종 소유자

두 명 중 한 명 또는 별도의 담당자를 IaC 최종 소유자로 지정한다.

최종 소유 영역:

- Terraform State
- Provider 버전
- 공통 모듈
- DNS
- WAF Ruleset
- Rate Limit Ruleset
- Access 공통 정책
- 환경별 Apply
- Import와 Drift 처리
- CI Credential
- Production 권한 관리

---

# 36. Dashboard 직접 변경 정책

Terraform으로 관리하는 리소스는 Dashboard에서 직접 수정하지 않는 것이 원칙이다.

```text
Terraform 관리 리소스
→ Dashboard는 조회 전용

Wrangler 관리 Worker
→ Wrangler와 CI를 통해서만 변경
```

긴급 변경 절차:

```text
1. Dashboard에서 긴급 변경
2. 변경 내용 기록
3. 즉시 Terraform 또는 Wrangler 코드에 반영
4. terraform plan으로 Drift 확인
5. 필요 시 Import 또는 State 정리
6. 재배포 및 검증
```

기존 Dashboard 리소스를 Terraform으로 전환할 때는 삭제 후 재생성하지 않고 Import를 우선 검토한다.

---

# 37. Provider 버전 관리

Cloudflare Terraform Provider는 버전을 고정한다.

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.x"
    }
  }
}
```

정확한 버전은 도입 시점에 공식 문서를 확인한 후 고정한다.

업그레이드 절차:

```text
1. Changelog 확인
2. Development 환경 업그레이드
3. terraform plan 검토
4. Staging 적용
5. 주요 리소스 검증
6. Production 적용
```

Provider 버전을 검증 없이 자동으로 최신 버전까지 올리지 않는다.

---

# 38. Terraform 도입 시 유지비를 줄이는 원칙

1. Worker 코드까지 Terraform으로 관리하지 않는다.
2. 환경별 State를 분리한다.
3. 공통 리소스만 모듈화한다.
4. 비밀값을 Terraform State에 넣지 않는다.
5. Dashboard 직접 변경을 제한한다.
6. WAF와 Rate Limit Ruleset의 소유자를 한 명으로 정한다.
7. D1 리소스와 D1 스키마 관리를 분리한다.
8. 모든 변경은 Pull Request와 Plan을 거친다.
9. 사용하지 않는 리소스는 Terraform 코드에서도 제거한다.
10. Provider 업그레이드는 별도 작업으로 진행한다.

---

# 39. IaC 반영 후 최종 권장 구조

```text
Terraform
├─ DNS
├─ D1 리소스
├─ R2 및 Lifecycle
├─ Queue
├─ WAF
├─ Zone Rate Limit
├─ Cloudflare Access
└─ Remote State

Wrangler
├─ Public API Worker
├─ Admin Worker
├─ Log Consumer Worker
├─ 개발자 포털
├─ 운영 대시보드
├─ Worker Binding
├─ Queue Producer/Consumer
├─ D1 Migration
└─ Worker Deployment

GitHub Actions
├─ terraform plan
├─ terraform apply
├─ D1 migration
├─ wrangler deploy
└─ smoke test
```

현재 규모에서는 다음 분리가 가장 적절하다.

```text
Terraform
= 인프라와 보안 계층

Wrangler
= 애플리케이션과 배포 계층

D1 Migration
= 데이터 스키마 계층

GitHub Actions
= 검증과 배포 자동화
```

이 구조를 사용하면 Cloudflare의 서버리스 특성을 유지하면서도 AWS/GCP와 유사하게 다음을 확보할 수 있다.

- 인프라 변경 이력
- 환경별 설정 분리
- Pull Request 기반 리뷰
- 재현 가능한 환경 구성
- 보안 정책의 코드화
- 애플리케이션과 인프라 배포 분리
- Drift 탐지와 변경 책임 추적
