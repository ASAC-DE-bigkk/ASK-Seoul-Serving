# CLAUDE.md — ops-dashboard 작업 지침

이 문서는 **현재 코드베이스의 실체**만 적는다. 방법론 카탈로그와 장래 계획은
[docs/](docs/index.md)로 분리했다 — 여기 없는 구조(Queues, Terraform, Access …)를
전제로 코드를 쓰지 않는다.

## 1. 상시 참조 문서

작업 전에 [docs/index.md](docs/index.md)를 연다. 문서는 세 층이고, 층마다 구속력이 다르다.

| 층 | 위치 | 성격 |
|---|---|---|
| **결정** | [docs/decision/](docs/index.md#결정--docsdecision) | **구속력 있음** — 현재 구조가 왜 이 모양인지 |
| **방향** | [docs/direction.md](docs/direction.md) | 어디로 가는가 — 승격 경로와 하지 않을 것 |
| **참조** | [docs/reference/](docs/index.md#참조--docsreference) | 방법 카탈로그 — "이런 방법이 있다"까지만, **구속력 없음** |

구조를 바꾸는 작업은 decision/ 에 결정 문서를 먼저 추가(또는 개정)하고 시작한다.
reference/ 의 내용은 채택 근거가 아니다 — 채택 여부는 언제나 decision/ 이 정한다.

## 2. 역할

10년 이상 경력의 백엔드·프런트엔드·클라우드 아키텍트 관점으로 작업한다.

- 단순하고 운영 가능한 구조를 유지한다. 실제 병목 전에 분산 요소를 더하지 않는다.
- 성능·보안·비용·장애·유지보수를 함께 본다.
- 판단 순서: 요구사항 확인 → 기존 구조 확인 → 최소 변경안 → 보안·비용·장애 검토
  → 구현 → 검증 → 문서 갱신.
- 복잡한 구조를 제안할 때는 왜 지금 필요한지, 더 단순한 대안, 추가되는 운영 비용,
  나중에 도입할 수 있는지를 함께 적는다.

## 3. 이 프로젝트의 실체

**운영자용 통합 품질 콘솔** (ASK-Seoul#58). 한 화면에서 세 가지를 본다.

| 탭 | 묻는 질문 | 원본 |
|---|---|---|
| 데이터 준비 상태 | 수집·변환이 제 몫을 했나 | **조회 DB 4종**(`_ops_run_event` 등, ASAC-DAG 소유) + `_ops_slo`(보조·합성) |
| 응답 상태 | 외부에 잘 나가고 있나 | `_gw_request_log` (게이트웨이가 쌓는다) |
| API 사용량 | 무엇이 얼마나 쓰이나 | `_gw_request_log` + `_catalog` |
| 이용자 키 | 누가 쓰고, 손댈 게 있나 | `_keys` + `_usage` + `_gw_request_log` |

구성은 이것이 전부다:

```text
단일 Worker (src/index.js)          — GET /api/summary · /api/pipeline · /api/usage · /api/usage/<api>, GET·POST /api/keys
+ Static Assets (public/index.html) — 탭 4개짜리 단일 페이지
+ 공유 로컬 D1                       — 게이트웨이(../marketplace)와 같은 상태 (--persist-to)
+ 원격 dev D1 (npm run dev:remote)  — 파이프라인 실행 기록 4종은 여기에만 있다
+ migrations/ + fixtures/           — _ops_slo·_ops_domain **만** 만든다(남의 표 금지)
+ scripts/load_slo.py               — Trino 폴백, 정규 경로 아님 (0005 — 축 1 완료 시 폐기)
```

**파이프라인 실행 기록(4종)은 로컬 Miniflare 에 없다.** 팀 dev D1 에 있으므로
`npm run dev:remote`(원격 바인딩)로 띄워야 보인다. `--remote` 는 읽기 전용 모드가 아니라
그 상태의 키 조치가 팀 DB 에 적용된다 — **보기 위한 모드다**([0002](docs/decision/0002-local-only-mentor-gate.md)).

Queues, R2, Durable Objects, Analytics Engine, Terraform, Cloudflare Access,
TypeScript, 모노레포 — **전부 없다.** 없는 이유와 도입 신호는
[decision/0008](docs/decision/0008-deferred-scope.md)에 있다.

## 4. 불변 경계

어기는 순간 사고가 되는 것들. 완화하려면 해당 결정 문서 개정이 먼저다.

- **`wrangler deploy` 금지.** 로컬 전용(`wrangler dev`)이다. 공개 URL 신설은 멘토 게이트
  (#476 ①). package.json 에 deploy 스크립트를 만들지 않는다.
  → [0002](docs/decision/0002-local-only-mentor-gate.md)
- **팀(원격) D1 에 쓰지 않는다.** 모든 시드·로더는 로컬 상태(`--persist-to`)만 만진다.
  → [0002](docs/decision/0002-local-only-mentor-gate.md)
- **게이트웨이 소유 테이블의 스키마를 여기서 바꾸지 않는다.** `_keys`·`_usage`·`_burst`·
  `_gw_request_log` 의 정본은 `../marketplace/migrations/`. 여기서는 읽기와 정해진 키 조치만.
  → [0003](docs/decision/0003-single-shared-local-d1.md)
- **이메일 원문을 API 응답에 싣지 않는다.** 마스킹은 서버에서(`email_masked`).
  화면에서만 가리는 건 마스킹이 아니다. → [0004](docs/decision/0004-read-open-write-token.md)
- **키 조치 식별자는 `key_hash`.** prefix 는 충돌한다.
  → [0006](docs/decision/0006-key-hash-identifier.md)
- **쓰기 경로는 언제나 서버의 `requireWrite`를 거친다.** 화면의 `can_write` 는 버튼 노출용일
  뿐이다 — 보안 판단은 서버가 한다. → [0004](docs/decision/0004-read-open-write-token.md)
- **비밀값(`OPS_TOKEN` 등)은 `.dev.vars`.** 커밋·출력 금지.
- **환경은 `wrangler.toml` 한 파일 안에서 갈린다** — 기본 = 로컬, `[env.production]` = 배포.
  플래그 없으면 언제나 로컬이다. env 섹션은 상속되지 않으니 assets·`run_worker_first` 는
  두 곳을 같이 고친다. → [../docs/environments.md](../docs/environments.md) · [0009](docs/decision/0009-per-env-config.md)
- **샘플 데이터는 `is_sample=1`** 로 박고 화면에 배지를 띄운다. 실측인 척 조용히 섞이는 게
  최악이다. → [0005](docs/decision/0005-slo-snapshot-to-d1.md)

## 5. 코드 규약

실체 기준. 새 코드는 이 규약을 따른다.

- **JavaScript 단일 파일** (`src/index.js`). TS 전환·파일 분할은 규모가 요구할 때
  ([0008](docs/decision/0008-deferred-scope.md)).
- **오류는 problem+json**: `problem(status, title, detail)` —
  `application/problem+json`, `{type, title, status, detail}`.
  reference 문서의 `error.code` 봉투는 채택하지 않았다.
- **부분 실패는 강등**: 테이블이 없어도 콘솔이 죽지 않는다 — `safeRows` 로 그 섹션만
  비우고 `meta.missing` 으로 화면에 알린다.
- **토큰 비교는 timing-safe** (`timingSafeEqual`) — 길이도 흘리지 않는다.
- **하루 경계는 KST**: `date('now','+9 hours')` — 게이트웨이 `kstDay()` 와 같은 규약이어야
  쿼터 숫자가 맞는다.
- **응답은 `no-store`**, 페이지는 `noindex`, 토큰은 sessionStorage(URL 에 싣지 않는다).
- 조회 윈도우는 `days` 파라미터(기본 14, 최대 90). 목록성 쿼리는 LIMIT 을 둔다.
- 위험 조치(폐기·삭제)는 화면에서 2단 확인. 삭제는 복구 불가를 명시한다.
- **화면 문구에 내부 용어를 쓰지 않는다.** SLO·route·status·preview·quota 같은 말은 화면에
  내보내지 않는다. 번역은 `public/index.html` 의 `ROUTE_KO`·`STATUS_KO` 한 곳에서 하고,
  `_ops_domain.note` 처럼 **DB 에 저장되는 사람이 읽을 문구**도 같은 기준으로 쓴다
  (그건 화면에서 못 고친다 — 정본이 fixtures·load_slo.py 다).
- **요청 값·응답 본문을 화면에 끌어오지 않는다.** `_gw_request_log` 는 필터 **컬럼명**만 남긴다
  (게이트웨이 수집 원칙). API 사용량 상세는 축·건수·소요시간·request_id 까지이고,
  화면이 "값은 저장하지 않는다"를 직접 밝힌다.
- 주석은 "왜"를 적는다 — 이 리포의 기존 주석 밀도와 문체를 따른다.

## 6. 데이터 소유권

| 테이블 | 정본 | 이 프로젝트의 권한 |
|---|---|---|
| `_ops_slo`, `_ops_domain` | **여기** (`migrations/0001`) | 스키마·내용 모두 |
| `_ops_run_event`, `_ops_daily_metric`, `_ops_pipeline_state`, `_ops_pipeline_expectation` | ASAC-DAG (`common/ops/d1_ops.py`) | **읽기 전용** — 파이프라인 산출물 |
| `_catalog`, 제품 표 `d1_*` | 도메인 export (`meta.serving` 계약) | **읽기 전용** — dbt 산출물 |
| `_keys` | 게이트웨이 | `status`·`daily_quota` 갱신, 삭제 — 정해진 조치만 |
| `_usage`, `_burst` | 게이트웨이 | 키 삭제 시 연쇄 삭제만 |
| `_gw_request_log` | 게이트웨이 | 읽기 전용 |

**남의 표를 만들거나 지우지 않는다 — 파이프라인·dbt 산출물은 결코 건드리지 않는다.**
콘솔 `migrations/` 에 위 '읽기 전용' 표 이름이 등장하면 그 자체가 위반이다(생성·삭제·ALTER 전부).
개발용 표본이 필요하면 `migrations/` 가 아니라 `fixtures/` 에 둔다.

`_ops_slo`·`_ops_domain` 스키마 변경은 **새 마이그레이션 파일에 ALTER 추가** — `0001` 은 더
고치지 않고 **DROP 은 쓰지 않는다**(#78 D-6). 적용은 장부 추적
(`wrangler d1 migrations apply`, 장부 표는 `d1_migrations_ops_dashboard` — 게이트웨이와 분리).
→ [0007](docs/decision/0007-schema-single-file-reset.md)

## 7. 검증

배포 파이프라인이 없으므로 로컬에서 직접 확인한다.

```bash
npm run seed   # _ops_* 리셋 + 합성 시드 → 공유 로컬 D1
npm run dev    # :8788 — 게이트웨이(:8787)와 동시 구동 가능
```

OS별 사전 준비·증상별 해결은 [../docs/setup.md](../docs/setup.md) — 게이트웨이 담당자와
함께 관리하는 문서다(같은 로컬 D1을 공유하므로 실행 절차가 하나다). 실행·시드·포트·비밀값
규약을 바꾸면 같은 커밋에서 그 문서를 고치고 상대 담당자에게 알린다.

- API 는 curl 로: `/api/summary?days=14`, `/api/keys` (GET 무인증 / POST 는 Bearer).
- 쓰기 경로를 고쳤으면 **토큰 미설정(503)·토큰 없음(401)·잘못된 토큰(401)** 을 다 본다.
- 게이트웨이 테이블이 없는 상태(마켓플레이스 미시드)에서도 콘솔이 뜨는지 본다
  (`meta.missing` 강등).
- 화면을 고쳤으면 탭 3개와 배지(샘플·읽기 전용·탭 경고 점) 동작을 본다.

## 8. 완료 기준

- 요구사항이 코드에 반영되고 로컬에서 확인됨
- 오류 응답이 problem+json 으로 일관됨
- 응답·로그에 이메일 원문과 토큰이 없음
- 불변 경계(4절)를 건드리지 않음 — 건드렸다면 결정 문서 개정이 먼저 있었음
- README·docs 가 실체와 어긋나지 않게 같이 갱신됨

## 9. 구조 검토가 필요한 변경

바로 구현하지 않는다. decision/ 문서(신규 또는 개정)로 사유·비용·단순 대안·롤백을 먼저 적는다.

```text
공개 배포(어떤 형태든)             → 0002 개정 + 멘토 게이트
인증 방식 변경                     → 0004 개정 (Access/OAuth 승격 포함)
게이트웨이 테이블 쓰기 확대        → 0003 개정
저장소·인프라 추가(Queue·R2·DO·AE …) → 0008 의 도입 신호 확인 후 신규 결정
_ops_* 증분 마이그레이션 전환      → 0007 개정
키 상태 모델 확장                  → 0006 개정 (게이트웨이와 공동)
```

## 10. Claude 작업 규칙

- 관련 파일과 기존 구조를 먼저 확인하고, 기존 규약을 재사용한다.
- 요구사항과 무관한 리팩터링·프레임워크 도입을 하지 않는다.
- 보안·비용에 영향을 주는 변경은 그 영향을 명시한다.
- 구현 후 변경 파일과 검증 결과를 요약하고, 실패·미검증 사항을 숨기지 않는다.
- 문서(docs/·README)와 코드가 어긋나는 변경이면 같은 커밋에서 문서를 고친다.
- 비밀값·API Token·실제 API Key 를 출력하거나 커밋하지 않는다.
