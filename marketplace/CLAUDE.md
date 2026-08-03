# CLAUDE.md — marketplace 작업 지침

이 문서는 **현재 코드베이스의 실체**만 적는다. 여기 없는 구조(공개 배포·Queues·DO·TS …)를
전제로 코드를 쓰지 않는다. 구속력 있는 결정은 [docs/decision/](docs/decision/)에 있고,
콘솔(ops-dashboard)과 공유하는 계약은
[decision/0001](docs/decision/0001-shared-contracts.md)이 정본이다.

## 1. 이 프로젝트의 실체

**데이터 마켓플레이스 게이트웨이** (ASK-Seoul#58, 로컬 전용 프로토타입).
키 발급 → 쿼터 → 카탈로그 게이트 → 조회의 관문 역할을 로컬에서 실물 검증한다(#476).

| 경로 | 무엇 | 인증 |
|---|---|---|
| `POST /api/keys` | 키 발급 (이메일당 1키, rotate 는 confirm 필수) | 무인증 + IP 시간당 5회 |
| `DELETE /api/keys` | 폐기 / `?purge=true` 완전삭제(지울 권리 셀프 경로) | Bearer (폐기된 키 허용) |
| `GET /api/catalog` | 공개 제품 목록 + join_axes + 문서 포인터 | 무인증 |
| `GET /api/preview/<t>` | 고정 5행 미리보기, 무과금 | 무인증 + IP 버스트 |
| `GET /api/data/<t>` | 필터·기간·키셋 커서 조회 | Bearer + 버스트 + 일일 쿼터 |
| `GET /api/me` | 내 사용량 (이메일 원문은 여기만 — 본인 응답) | Bearer |
| 정적 | `/docs` `/legal` `/llms.txt` `/openapi.json` `/column-docs.json` | Assets 서빙 |

구성은 이것이 전부다:

```text
단일 Worker (src/index.js)   — 위 라우트 전부. 게이트 순서: 키 검증 → 버스트 → 쿼터 → external 게이트 → 조회
+ Static Assets (public/)    — run_worker_first = ["/api/*"], 없는 경로는 404 화면
+ 로컬 D1 (Miniflare)        — wrangler dev --local. 콘솔(../ops-dashboard)이 같은 상태를 읽는다
+ migrations/                — 0001 키·쿼터 · 0002 요청 로그 · 0003 버스트 · 0004 request_id (증분만)
+ fixtures/seed.sql          — 카탈로그·제품 샘플
```

## 2. 불변 경계

어기는 순간 사고가 되는 것들. 완화하려면 결정 문서 개정이 먼저다.

- **`wrangler deploy` 금지.** 로컬 전용(`wrangler dev --local`)이다. 공개 URL 신설은
  멘토 게이트(#476 ①). package.json 에 deploy 스크립트를 만들지 않는다.
- **팀(원격) D1 에 쓰지 않는다.** `config/local/wrangler.toml` 의 database_id 는 로컬 모드에서
  쓰이지 않으며, 시드·검증은 전부 Miniflare 로컬 상태만 만진다.
- **설정은 환경별로 갈린다** — `config/local/` · `config/prod/`, 같은 파일 이름 다른 디렉토리.
  루트에 `wrangler.toml` 을 되살리지 않는다(`-c` 누락이 조용히 통과하게 된다).
  배치·함정은 [../docs/environments.md](../docs/environments.md) 가 정본이다.
- **키 원문은 어디에도 저장하지 않는다.** SHA-256 해시 + 표시용 접두 8자만. 발급 응답에서
  한 번 보여주는 게 전부다.
- **`_request_log` 에 값을 남기지 않는다** — 필터는 컬럼명만, 식별자는 key_hash 만,
  원문 UA·전체 Referer·쿼리 값·이메일 금지. 30일 보존
  ([0001 §값-최소화](docs/decision/0001-shared-contracts.md)).
- **비공개 제품은 404 로 답한다** — 403 은 "있긴 있다"를 알려준다. 공개는
  `_catalog.external = 1` 옵트인만 — NULL(미선언)은 공개하지 않는다.
- **마이그레이션은 증분(추가만)** — DROP 금지, 변경은 새 ALTER 파일. ALTER 는 재시드가
  깨지지 않게 `||` 로 감싸고, **seed 체인에 같은 파일을 반드시 추가한다**
  (0004 누락으로 로컬 요청 로그가 몇 주간 전량 유실됐던 실사고).
- **쿼터 과금은 유효한 서빙 직전만** — 400/404/409 는 무과금. 버스트는 쿼터보다 앞에서
  본다(오류로 끝날 요청도 서버를 미는 건 같다).
- **비밀값·토큰·실키를 출력·커밋하지 않는다.**

## 3. 코드 규약

실체 기준. 새 코드는 이 규약을 따른다.

- **JavaScript 단일 파일** (`src/index.js`). TS·파일 분할은 규모가 요구할 때.
- **오류는 problem+json** — `problem(status, title, detail, extras, headers)`.
  4xx/5xx 본문에 `request_id` 를 넣고, 모든 응답에 `x-request-id` 헤더를 실는다.
- **하루 경계는 KST** (`kstDay()`) — 콘솔·파이프라인 시간축과 같은 규약
  ([0001 §KST](docs/decision/0001-shared-contracts.md)).
- **페이지네이션은 rowid 키셋 커서** — offset 금지(재발행 사이 중복·유실). 커서에
  `exported_at` 을 실어 다른 발행의 커서는 409 로 거절한다.
- **한도는 헤더로 알린다** — `X-RateLimit-*` 3종 + 429 에 `Retry-After`.
- **관측(`logRequest`)은 `ctx.waitUntil`** — 실패해도 응답에 영향을 주지 않는다.
  단 "조용한 유실" 위험과 세트다 — INSERT 컬럼을 바꿀 때 시드 체인·콘솔 미러 정합을
  같은 커밋에서 확인한다.
- **테이블명 검증은 화이트리스트** (`/^[a-z0-9_]+$/` + `_catalog` 존재 확인) — 사용자
  입력을 SQL 식별자로 쓰는 유일한 지점이므로 이 순서를 깨지 않는다.
- 주석은 "왜"를 적는다 — 기존 주석 밀도와 문체를 따른다.

## 4. 데이터 소유권

| 테이블 | 정본 | 콘솔(ops-dashboard)의 권한 |
|---|---|---|
| `_keys` | **여기** (`migrations/0001`) | `status`·`daily_quota` 갱신, 삭제 — 정해진 조치만 |
| `_usage`, `_burst` | **여기** | 키 삭제 시 연쇄 삭제만 |
| `_issuance_log` | **여기** | 없음 |
| `_request_log` | **여기** (`migrations/0002+`) | 읽기 전용 |
| `_catalog` + 제품 테이블 | 스키마는 여기, 내용은 도메인 export (meta.serving 계약) | 읽기 전용 |

스키마 변경은 언제나 여기(정본)가 먼저다 — 콘솔은 미러를 만들지 않고 따라 읽는다
(ops-dashboard decision/0010: ALTER 미러는 duplicate column 충돌).
키 상태 모델(active/revoked 2값) 확장은 콘솔 decision/0006 과 **공동 개정**.

## 5. 검증

배포 파이프라인이 없으므로 로컬에서 직접 확인한다.

```bash
npm run seed   # migrations + fixtures → 로컬 D1
npm run dev    # :8787 — 콘솔(:8788)과 동시 구동 가능
```

OS별 사전 준비·증상별 해결은 [../docs/setup.md](../docs/setup.md) — 콘솔 담당자와 함께
관리하는 문서다(같은 로컬 D1을 공유하므로 실행 절차가 하나다). 실행·시드·포트·비밀값 규약을
바꾸면 같은 커밋에서 그 문서를 고치고 상대 담당자에게 알린다.

- 발급→조회 한 바퀴: `POST /api/keys` → `GET /api/data/<t>` (Bearer) → `GET /api/me` 로 카운트 확인.
- 무과금 확인: 400(없는 필터)·404(없는 테이블) 뒤 `/api/me` 카운트가 안 늘었는지.
- 커서: 재시드 후 이전 커서가 409 `cursor expired` 로 거절되는지.
- 한도: 429 응답에 `Retry-After` / `X-RateLimit-*` 헤더가 있는지.
- 관측: 요청 후 `_request_log` 에 행이 실제로 늘었는지 — **조용한 유실 검증, 생략 금지**.
- 오류 형식: 4xx 본문이 problem+json + `request_id` 인지.

## 6. 구조 검토가 필요한 변경

바로 구현하지 않는다. 결정 문서(신규 또는 개정)로 사유·비용·단순 대안·롤백을 먼저 적는다.

```text
공개 배포(어떤 형태든)              → 멘토 게이트(#476 ①) — config/prod/wrangler.toml 주석이 정본
키 상태 모델 확장(2값 초과)          → 콘솔 0006 과 공동 개정
_request_log 컬럼 추가(#9·intent 축) → 새 ALTER 파일 + 시드 체인 + 콘솔 통지, 전부 nullable
공유 계약(오류·KST·key_hash …) 변경  → decision/0001 개정 + 콘솔 담당 리뷰
저장소·인프라 추가(DO·Queues·R2 …)  → 도입 신호 확인 후 신규 결정 (ops-dashboard 0008 방식)
발급 rate limit 의 원문 IP           → #9 §7-①·⑥ 결정에 따라 정리 예정 — 그 전까지 확장 금지
```

## 7. 완료 기준

- 요구사항이 코드에 반영되고 §5 검증을 통과함
- 오류 응답이 problem+json + request_id 로 일관됨
- 응답·로그에 키 원문·저장 금지 값이 없음
- 불변 경계(§2)를 건드리지 않음 — 건드렸다면 결정 문서 개정이 먼저 있었음
- README·docs·시드 체인이 실체와 어긋나지 않게 같이 갱신됨
