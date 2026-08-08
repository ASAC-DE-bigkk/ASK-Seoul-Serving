# 0005 — K-Skill proxy 서비스 키는 단일 제품 read scope로 제한한다

- 상태: **채택** (2026-08-08, ASK-Seoul-Serving #194)
- 관련: `src/skill.js`, `src/shared.js`, [K-Skill proxy 배포 문서](../../../k-skill/docs/deploy-k-skill-proxy.md)

## 맥락

`seoul-weather-risk`는 사용자가 ASK Seoul API Key를 발급·보관하지 않도록 hosted
`k-skill-proxy`를 통해 조회한다. proxy의 route allowlist만으로는 proxy 환경의 키가
유출됐을 때 ASK Seoul Worker의 다른 표면 접근을 막을 수 없다.

기존 `_keys`는 이메일 소유권 확인, 사용자 셀프 폐기, 사용량 조회를 전제로 한다. 이를
비인간 proxy key와 섞으면 사용자 key 수명주기와 최소 권한 계약이 서로 흐려진다.

## 결정

### 서비스 principal과 scope

| 항목 | 값 |
|---|---|
| service principal | `k-skill-proxy:seoul-weather-risk` |
| scope | `skill:seoul-weather-risk:read` |
| 허용 표면 | `GET /skill/v1/bundles/seoul-weather-risk`, 단일 product detail, 단일 product data |
| 거부 표면 | `/api/v1/*`, `/mcp`, Google OAuth, 사용자 key 폐기·삭제를 포함한 나머지 전부 |

Worker는 service key가 scope를 요구하지 않는 route에 도달하면 `403
service_key_scope_required`, scope가 없거나 깨졌으면 `403 insufficient_scope`로 중단한다.
이 판정은 burst·quota보다 앞이므로 거부 요청은 사용량을 소모하지 않는다. 일반 사용자 key는
기존 API 계약을 유지한다.

### 저장과 발급

서비스 key는 `_service_keys`에만 등록한다. 저장값은 `key_hash`, `key_prefix`,
`service_name`, `scopes_json`, `status`, `daily_quota`, 생성·폐기 시각뿐이며 key 원문은
어디에도 저장하지 않는다. `_keys`는 사용자 key 전용으로 유지한다.

서비스 key 원문은 ASK Seoul 운영자가 안전한 채널로 k-skill proxy 운영자에게 한 번만 전달한다.
proxy는 런타임 secret에만 보관하며 issue, PR, URL, query string, 로그, CLI 인자에 넣지 않는다.

### rotation과 폐기

상태 값은 기존과 같이 `active` / `revoked` 두 개다. 상태 모델을 늘리지 않는다.

1. rotation은 같은 service principal과 scope의 새 key를 먼저 등록한다.
2. proxy runtime secret을 새 key로 교체하고 bundle/product/bounded-data smoke를 확인한다.
3. 이전 key의 `_service_keys.status`를 `revoked`로 바꾸고 `revoked_at`을 기록한다.

두 key의 짧은 동시 active 구간은 무중단 교체만을 위한 것이다. incident 또는 proxy
compromise 때는 이전 절차를 기다리지 않고 key를 즉시 `revoked`로 바꾸고 proxy secret을
제거·재배포한다. D1은 매 인증 요청에서 상태를 확인하므로 다음 요청부터 차단된다.

## 대안과 기각

| 대안 | 기각 이유 |
|---|---|
| maintainer 개인 key 사용 | 소유자 퇴장·유출·회수 시 서비스와 개인 권한이 함께 묶인다. |
| `_keys`에 scope 컬럼 추가 | 이메일 사용자 key의 셀프서비스 수명주기와 비인간 principal이 섞이고, 다단계 ALTER 부분 적용이 인증 장애를 만들 수 있다. |
| proxy route allowlist만 사용 | proxy 밖에서 유출된 key의 API 범위를 Worker가 차단하지 못한다. |

## 결과와 후속

- `_service_keys` migration과 Worker scope gate가 같은 PR에 들어간다. 배포 순서는 migration → service key 등록 → proxy secret 교체 → smoke → 이전 key revoke다.
- 원격 D1 migration·key 발급·proxy/Worker 배포는 별도 승인 후에만 실행한다.
- 새 K-Skill 제품을 proxy로 열 때는 새 scope와 service principal을 이 결정에 추가하거나, 별도 decision으로 분리한다.
