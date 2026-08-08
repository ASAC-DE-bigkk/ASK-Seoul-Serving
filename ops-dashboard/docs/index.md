# docs — 문서 지도

ops-dashboard 의 문서는 **세 층**이고, 층마다 구속력이 다르다. 작업 지침은
[../CLAUDE.md](../CLAUDE.md)가 정본이며, 이 인덱스는 그 지침이 상시 참조하는 지도다.

| 층 | 성격 | 구속력 |
|---|---|---|
| [결정 — decision/](#결정--docsdecision) | 현재 구조가 왜 이 모양인지 | **있음** — 어기려면 개정이 먼저 |
| [방향 — direction.md](direction.md) | 어디로 가는가, 승격 경로 | 방향 제시 |
| [참조 — reference/](#참조--docsreference) | "이런 방법이 있다" 카탈로그 | **없음** — 채택 근거 아님 |
| [가이드 — runbook.md](runbook.md) | 구동·검증·조치의 절차 (설명+명령어) | 절차 안내 |

## 결정 — docs/decision/

현재 구조를 만든 결정들. 바꾸려면 **해당 문서 개정(또는 신규)이 코드보다 먼저**다.

| # | 결정 | 한 줄 |
|---|---|---|
| [0001](decision/0001-separate-worker-from-marketplace.md) | 마켓플레이스와 별도 Worker | 청중이 다르고, 배포 단위가 갈려야 사고 반경도 갈린다 |
| [0002](decision/0002-local-only-mentor-gate.md) | ~~로컬 전용~~ | **폐기** — 0015 가 대체. 그때의 판단으로만 읽는다 |
| [0003](decision/0003-single-shared-local-d1.md) | 게이트웨이 D1 공유 | 원본 하나 — 복제 계층 없음, 부분 강등(`meta.missing`) |
| [0004](decision/0004-read-open-write-token.md) | 읽기 공개·쓰기 토큰 | 보안 판단은 서버, 이메일은 서버측 마스킹 |
| [0005](decision/0005-slo-snapshot-to-d1.md) | 파이프라인 상태의 정본 | **조회 DB 4종에서 읽는다**(#78 D-2) — 웨어하우스 직결 복사 경로는 폐기 |
| [0006](decision/0006-key-hash-identifier.md) | 조치 식별자 `key_hash` | prefix 는 충돌한다 — 상태는 active/revoked 두 개 |
| [0007](decision/0007-schema-single-file-reset.md) | 마이그레이션 증분(추가만) | DROP 금지 — 팀 조회 DB 실존으로 리셋 규약 폐지 (#78 D-6) · 장부 추적 · **남의 표 소유 경계** |
| [0008](decision/0008-deferred-scope.md) | 후속으로 미룬 것 | 안 하기로 한 것의 전체 목록 + 도입 신호 |
| [0009](decision/0009-ops-records-consumption.md) | 운영 기록 소비 | 조회 DB 4종을 읽기 전용으로 — 실행 기록 탭 (#78 적용 3단계) |
| [0010](decision/0010-behavior-log-console-first.md) | 행동 로그 콘솔 선반영 | 이용 행동 탭 — 수집 스펙은 #9 검토 중, ALTER 미러 금지 |
| [0011](decision/0011-per-env-config.md) | 환경별 설정 | 한 파일 + `[env.production]` — **개정(0015)**: 기본 환경도 이제 운영이다 |
| [0012](decision/0012-runs-tab-observation-boundaries.md) | 실행 기록의 관측 경계 | 환경 스코프·신선도·감시 3분류·로그 번들 — **못 거른 범위까지 화면이 밝힌다** |
| [0014](decision/0014-console-route-contract.md) | 콘솔 route 계약 | route 전수(종 수는 §1 머리) + 퇴역분 → 화면 문구 · `SERVE` 한 곳 · **못 가른 MCP 를 화면이 말한다** (#63) |
| 🔴 [0015](decision/0015-single-production-d1.md) | **운영 D1 하나뿐** | dev D1 폐기 — 로컬도 운영에 직접 읽기/쓰기. **연습할 곳이 없다**. 남은 경계는 스키마뿐 |

## 방향 — docs/direction.md

[direction.md](direction.md) — 콘솔의 존재 이유(관측의 소비자 + 관측 공백을 드러내는 장치),
발전 축 3개(운영 기록 소비·SLO 실적재 정규화·인증 승격), 승격 단계, 하지 않을 것.

## 참조 — docs/reference/

**방법 카탈로그다 — "이런 방법이 있다"까지만.** 여기 나온 구조(Queues, R2, Durable Objects,
Terraform, Access, RBAC, 모노레포 …)를 구현 근거로 삼지 않는다. 채택 여부는 언제나
decision/ 이 정한다.

| 문서 | 내용 |
|---|---|
| [cloudflare_api_dashboard_role_plan_revised.md](reference/cloudflare_api_dashboard_role_plan_revised.md) | 2인 분업 전제의 초기 계획서 + 과설계 검토(§13~19) — MVP 축소 판단의 원형 |
| [cloudflare_api_dashboard_role_plan_with_iac.md](reference/cloudflare_api_dashboard_role_plan_with_iac.md) | 위 문서 + IaC 전략(§20~39): Terraform/Wrangler 경계, State, CI/CD |
| [ops-records-log-patterns.md](reference/ops-records-log-patterns.md) | 운영 기록 로그의 형태 패턴(F/V/D 표)과 인사이트 카탈로그 I-1~I-14 |
| [behavior-log-spec-draft.md](reference/behavior-log-spec-draft.md) | API 행동 로그 공통 스펙 v0 — #9 에서 ①~⑥ 확정(2026-08-03), 정본 반영(marketplace 0005) 대기 |

## 가이드 — docs/runbook.md

[runbook.md](runbook.md) — 구동 · API 검증 세트 · 실행 기록 탭 시나리오 확인 · 실적재 전환 ·
증분 마이그레이션 절차 · 운영 조치(키·멈춤 후보) · 트러블슈팅. 전부 설명+명령어 단위.

## 팀 규약 (외부 정본)

이 리포 밖에 정본이 있는 약속들 — 콘솔은 소비자다.

| 정본 | 내용 |
|---|---|
| [**`../../docs/agreement.md`**](../../docs/agreement.md) | **합의 정본** — 이슈에 흩어져 있던 결정을 하나로. 수집 축·소유 경계·환경·배포·MCP + **폐기된 안** |
| [`../../docs/setup.md`](../../docs/setup.md) | 로컬 실행 매뉴얼(macOS/Windows) — **게이트웨이 담당자와 공동 관리**. 실행 절차는 두 프로젝트가 하나를 공유한다 |
| [`../../docs/environments.md`](../../docs/environments.md) | 환경 규약 — 설정 배치·로컬/운영 도메인·D1·`-c` 의 함정 셋. **공동 관리**([0011](decision/0011-per-env-config.md)의 실행 규약) |
| ASK-Seoul#78 | 저장소·운영 기록 적용 규약 v1 — 존/경로/확인서/보관/기록 형식/값 집합/조회 DB |
| ASAC-DAG `common/ops/d1_ops.py` | 조회 DB 테이블 4종(`_ops_run_event` 등) 스키마 정본 |
| `../marketplace/migrations/` | `_keys`·`_usage`·`_burst`·`_gateway_request_log` 스키마 정본 |
| [`../marketplace/docs/decision/0001`](../../marketplace/docs/decision/0001-shared-contracts.md) | 두 앱 공통 계약 C-1~C-10 (problem+json·KST·key_hash·request_id·값 최소화·증분·정본/추종·유실 검증) — 개정은 상대 앱 담당 리뷰 필수 |

## 갱신 규칙

- 새 문서를 만들면 **이 인덱스에 한 줄 추가**한다.
- 구조를 바꾸는 작업은 decision/ 문서(신규·개정)가 코드보다 먼저다.
- 문서와 코드가 어긋나는 변경은 같은 커밋에서 문서를 고친다.
