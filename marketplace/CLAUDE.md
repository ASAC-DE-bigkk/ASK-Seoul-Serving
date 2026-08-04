# CLAUDE.md — marketplace 작업 지침

이 문서는 **현재 코드베이스의 실체**만 적는다. 여기 없는 구조(공개 배포·Queues·DO·TS …)를
전제로 코드를 쓰지 않는다.

> **두 프로젝트에 걸친 합의는 [../docs/agreement.md](../docs/agreement.md) 가 정본이다** —
> 수집 축·소유 경계·환경 규약·공개 배포 결정과 **폐기된 안**이 거기 모여 있다. 같은 주제를
> 두 번 논의하지 않기 위한 문서이므로, 이슈를 다시 뒤지기 전에 먼저 본다.

이 프로젝트에 한정된 구속력 있는 결정은 [docs/decision/](docs/decision/)에 있고,
콘솔(ops-dashboard)과 공유하는 계약은
[decision/0001](docs/decision/0001-shared-contracts.md)이 정본이다.
페이지를 어떻게 합성하는지(=왜 SSG 가 아닌지)는
[decision/0002](docs/decision/0002-page-composition.md).

## 1. 이 프로젝트의 실체

**데이터 마켓플레이스 게이트웨이** (ASK-Seoul#58, 로컬 전용 프로토타입).
키 발급 → 쿼터 → 카탈로그 게이트 → 조회의 관문 역할을 로컬에서 실물 검증한다(#476).

| 경로 | 무엇 | 인증 |
|---|---|---|
| `POST /api/v1/keys` | 키 발급 (이메일당 1키, rotate 는 confirm 필수) | 무인증 + IP 시간당 5회 |
| `DELETE /api/v1/keys` | 폐기 / `?purge=true` 완전삭제(지울 권리 셀프 경로) | Bearer (폐기된 키 허용) |
| `GET /api/v1/catalog` | 공개 제품 목록 + join_axes + 문서 포인터 | 무인증 |
| `GET /api/v1/preview/<t>` | 고정 5행 미리보기, 무과금 | 무인증 + IP 버스트 |
| `GET /api/v1/data/<t>` | 필터·기간·키셋 커서 조회 | Bearer + 버스트 + 일일 쿼터 |
| `GET /api/v1/me` | 내 사용량 (이메일 원문은 여기만 — 본인 응답) | Bearer |
| `GET /v1/products/<id>` | 제품 번들 — 구조·컬럼 설명·질의 예시 (ASAC-DAG#642) | Bearer |
| `GET /v1/glossary` | 용어 사전 (`?vocabulary_id=`) | Bearer |
| 정적 | `/docs` `/legal` `/llms.txt` `/openapi.json` `/column-docs.json` | Assets 서빙 |

구성은 이것이 전부다:

```text
단일 Worker, 파일 셋      — src/index.js(라우터 + /api) · src/v1.js · src/shared.js
                             게이트 순서: 키 검증 → 버스트 → 쿼터 → external 게이트 → 조회
+ Static Assets (public/)   — run_worker_first = ["/api/*", "/v1/*"], 없는 경로는 404 화면
                              site.css(문서형 공유 뼈대) · theme.js(다크/라이트 토글 배선)
+ partials/                 — nav.html · footer.html. 머리·바닥의 **정본**이다
+ 로컬 D1 (Miniflare)       — wrangler dev --local. 콘솔(../ops-dashboard)이 같은 상태를 읽는다
+ migrations/               — 0001 키·쿼터 · 0002 요청 로그 · 0003 버스트 · 0004 request_id (증분만)
+ fixtures/                 — seed.sql(카탈로그·제품) · handoff_meta_sample.sql(서빙 메타 4종 미러)
```

**머리·바닥은 partials/ 가 정본이다.** `public/*.html` 의 `<nav class="nav">`·`<footer>`
블록은 `npm run sync`(scripts/sync-partials.mjs)가 써 넣는다 — 페이지에서 직접 고치면
`npm test` 의 `--check` 가 잡는다. 페이지마다 다른 건 셋뿐이고 전부 스크립트의 `PAGES`
표에 있다(활성 링크 · CTA · 바깥 폭). **정적 사이트 생성기가 아니다**: `public/` 은 여전히
그대로 서빙되는 정본이고 결과물도 손으로 읽히는 HTML 이다. `src/`→`dist/` 로 바꾸는 것,
즉 배포 경로에 빌드 단계를 넣는 것은 §6 영역이다.
카탈로그(`catalog.html`)는 머리가 사이드바라 대상이 아니다.

## 2. 불변 경계

어기는 순간 사고가 되는 것들. 완화하려면 결정 문서 개정이 먼저다.

- **`wrangler deploy` 금지.** 로컬 전용(`wrangler dev --local`)이다. 공개 URL 신설은
  배포 결정(agreement §8). package.json 에 deploy 스크립트를 만들지 않는다.
  게이트 통과 후의 배포는 `--env production`(prod D1 `ask-seoul-prod-d1` 바인딩) 만 쓴다
  — 절차는 docs/deploy-runbook.md.
- **팀(원격) D1 에 쓰지 않는다.** wrangler.toml 의 database_id 는 로컬 모드에서 쓰이지
  않으며, 시드·검증은 전부 Miniflare 로컬 상태만 만진다. 기본 환경의 dev D1 바인딩은
  콘솔과 로컬 상태를 공유하는 키(database_id)라 **prod 로 바꾸지 않는다**(wrangler.toml 주석).
- **키 원문은 어디에도 저장하지 않는다.** SHA-256 해시 + 표시용 접두 8자만. 발급 응답에서
  한 번 보여주는 게 전부다.
- **`_gateway_request_log` 에 값을 남기지 않는다** — 필터는 컬럼명만, 식별자는 key_hash 만,
  원문 UA·전체 Referer·쿼리 값·이메일 금지. 30일 보존
  ([0001 §값-최소화](docs/decision/0001-shared-contracts.md)).
- **비공개 제품은 404 로 답한다** — 403 은 "있긴 있다"를 알려준다. 공개는
  `_catalog.external = 1` 옵트인만 — NULL(미선언)은 공개하지 않는다.
- **마이그레이션은 증분(추가만)** — DROP 금지, 변경은 새 ALTER 파일. 적용 여부의 정본은
  D1 안의 장부(`d1_migrations`)다 — 시드가 `wrangler d1 migrations apply` 로 안 된 파일만
  실행하므로, **새 파일은 `migrations/` 에 추가하면 끝이고 시드 체인에 나열하지 않는다**
  (사람이 체인 갱신을 기억하던 시절, 0004 누락으로 로컬 요청 로그가 몇 주간 전량
  유실됐던 실사고 — 그 재발 방지가 장부의 존재 이유다).
- **쿼터 과금은 유효한 서빙 직전만** — 400/404/409 는 무과금. 버스트는 쿼터보다 앞에서
  본다(오류로 끝날 요청도 서버를 미는 건 같다).
- **비밀값·토큰·실키를 출력·커밋하지 않는다.**

## 3. 코드 규약

실체 기준. 새 코드는 이 규약을 따른다.

- **JavaScript, 경로별 파일 분리.** `src/shared.js` 는 경로가 갈려도 한 벌인 공유 층
  (키 발급·검증 · 쿼터·버스트 · 오류 형식 · 요청 로깅 · UA 분류)이고, 경로 묶음마다
  파일 하나다(`src/index.js` = 라우터 + `/api`, `src/v1.js`). 나눈 이유는 규모가 아니라
  **협업**이다 — `/skill/v1` 담당과 한 파일을 동시에 고치면 충돌이 잦다(ASAC-DAG#642).
  새 네임스페이스는 `src/<이름>.js` 를 만들고 공유 층을 가져다 쓴다. TS 전환은 아직 아니다.
- **새 API 네임스페이스는 `wrangler.toml` 의 `run_worker_first` 에 먼저 등록한다.**
  빠지면 요청이 워커에 닿지도 못하고 정적 404 로 떨어져 "경로가 없는 것처럼" 보인다.
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
| `_gateway_request_log` | **여기** (`migrations/0005`) | 읽기 전용 |
| `_catalog` + 제품 테이블 | 스키마는 여기, 내용은 도메인 export (meta.serving 계약) | 읽기 전용 |
| ~~`_request_log`~~ (4컬럼) | **transit 워커** — 우리 것이 아니다 | 읽지도 쓰지도 않음 |

`_request_log` 는 이름이 겹쳤을 뿐 **남의 표다.** 원격에 먼저 있었고 transit 이 계속 쓰므로
게이트웨이가 `_gateway_request_log` 로 비켰다(agreement §2-2 · `0005`). **`DROP` 도 `ALTER` 도
하지 않는다** — 조건 없는 `ALTER` 하나가 남의 표에 우리 컬럼을 얹은 사고가 이미 있었다
(`0004` → dev D1). 배포 전 `npm run preflight` 가 그 자리를 지킨다.

스키마 변경은 언제나 여기(정본)가 먼저다 — 콘솔은 미러를 만들지 않고 따라 읽는다
(ops-dashboard decision/0010: ALTER 미러는 duplicate column 충돌).
키 상태 모델(active/revoked 2값) 확장은 콘솔 decision/0006 과 **공동 개정**.

## 5. 검증

배포 파이프라인이 없으므로 로컬에서 직접 확인한다.

```bash
npm run seed   # migrations + fixtures → 로컬 D1 (Windows 는 npm 셸을 Git Bash 로: npm_config_script_shell)
npm run dev    # :8787 — 콘솔(:8788)과 동시 구동 가능
```

- 발급→조회 한 바퀴: `POST /api/v1/keys` → `GET /api/v1/data/<t>` (Bearer) → `GET /api/v1/me` 로 카운트 확인.
- 무과금 확인: 400(없는 필터)·404(없는 테이블) 뒤 `/api/v1/me` 카운트가 안 늘었는지.
- 커서: 재시드 후 이전 커서가 409 `cursor expired` 로 거절되는지.
- 한도: 429 응답에 `Retry-After` / `X-RateLimit-*` 헤더가 있는지.
- 관측: 요청 후 `_gateway_request_log` 에 행이 실제로 늘었는지 — **조용한 유실 검증, 생략 금지**.
- 오류 형식: 4xx 본문이 problem+json + `request_id` 인지.
- 머리·바닥을 건드렸다면 `npm test` — `--check` 가 partial 과 어긋난 페이지를 짚는다
  (팔레트가 페이지마다 갈려 5페이지가 구 테라코타로 남았던 사고가 복제 때문이었다).

## 6. 구조 검토가 필요한 변경

바로 구현하지 않는다. 결정 문서(신규 또는 개정)로 사유·비용·단순 대안·롤백을 먼저 적는다.

```text
공개 배포(어떤 형태든)              → 배포 결정(agreement §8) — wrangler.toml 주석이 정본
키 상태 모델 확장(2값 초과)          → 콘솔 0006 과 공동 개정
_gateway_request_log 컬럼 추가       → 새 ALTER 파일 + 시드 체인 + 콘솔 통지, 전부 nullable
공유 계약(오류·KST·key_hash …) 변경  → decision/0001 개정 + 콘솔 담당 리뷰
저장소·인프라 추가(DO·Queues·R2 …)  → 도입 신호 확인 후 신규 결정 (ops-dashboard 0008 방식)
배포 경로에 빌드 단계(SSG·번들러)    → decision/0002 개정 + 배포 결정(agreement §8). public/ 이 서빙
                                      정본인 한 partials 동기화기는 이 선 아래다(0002 D-2)
발급 rate limit 의 원문 IP           → #9 §7-①·⑥ 결정에 따라 정리 예정 — 그 전까지 확장 금지
```

> `#9` 의 intent 축은 **`0005` 에 컬럼이 이미 있다** — 값을 채우는 코드만 없다(`LOG_COLUMNS`).
> 컬럼을 늘릴 때 **대상은 `_gateway_request_log` 다.** `_request_log` 에 `ALTER` 를 얹으면
> 남의 표를 건드리게 된다(§4).

## 7. 완료 기준

- 요구사항이 코드에 반영되고 §5 검증을 통과함
- 오류 응답이 problem+json + request_id 로 일관됨
- 응답·로그에 키 원문·저장 금지 값이 없음
- 불변 경계(§2)를 건드리지 않음 — 건드렸다면 결정 문서 개정이 먼저 있었음
- README·docs·시드 체인이 실체와 어긋나지 않게 같이 갱신됨
