# CLAUDE.md — ops-dashboard 작업 지침

이 문서는 **현재 코드베이스의 실체**만 적는다. 방법론 카탈로그와 장래 계획은
[docs/](docs/index.md)로 분리했다 — 여기 없는 구조(Queues, Terraform, Access …)를
전제로 코드를 쓰지 않는다.

> **두 프로젝트에 걸친 합의는 [../docs/agreement.md](../docs/agreement.md) 가 정본이다** —
> 수집 축·소유 경계·환경 규약·공개 배포 결정과 **폐기된 안**이 거기 모여 있다. 같은 주제를
> 두 번 논의하지 않기 위한 문서이므로, 이슈를 다시 뒤지기 전에 먼저 본다.

> **작업 전에 [../docs/change-log.md](../docs/change-log.md) 를 읽는다** — 이 코드가 왜 이 모양인지,
> 무엇이 이미 시도됐다 되돌려졌는지가 시간순으로 있다. 커밋 메시지는 *무엇을* 바꿨는지만
> 남기고 **왜 그렇게 하기로 했나**는 거기 있다. 그리고 **작업이 끝나면 같은 커밋에서 한 항목을
> 추가한다**(날짜 · 작업자 · 의도·목표 · 조치 · 결과) — 나중에 몰아 쓰면 의도가 이미 흐려져 있다.
>
> ⚠️ 그 문서는 2026-08-04 에 시작했다. **그 이전 작업은 뒤늦게 복원한 것이라 빠진 것이
> 있을 수 있다** — 없다고 안 한 일은 아니다.

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

**운영자용 통합 품질 콘솔** (ASK-Seoul#58). 한 화면에서 다섯 가지를 본다.

| 탭 | 묻는 질문 | 원본 |
|---|---|---|
| 데이터 준비 상태 | 수집·변환이 제 몫을 했나 | `_ops_slo` (보조·합성 스냅샷) |
| 실행 기록 | 무엇이 돌았고, 무엇이 조용한가 | **조회 DB 4종** `_ops_run_event` 외 (ASK-Seoul#78, → [0009](docs/decision/0009-ops-records-consumption.md)) |
| 응답 상태 | 외부에 잘 나가고 있나 | `_gateway_request_log` (게이트웨이가 쌓는다) |
| 이용 행동 | 누가·무엇이·어떻게 쓰나 | `_gateway_request_log` + `_keys` + 행동 스펙 초안 #9 (→ [0010](docs/decision/0010-behavior-log-console-first.md)) |
| API 사용량 | 무엇이 얼마나 쓰이나 | `_gateway_request_log` + `_catalog` |
| 이용자 키 | 누가 쓰고, 손댈 게 있나 | `_keys` + `_usage` + `_gateway_request_log` |

탭 이름은 **화면 문구 규약(§5)** 을 따른다 — "파이프라인 품질"·"서빙 품질" 대신
"데이터 준비 상태"·"응답 상태". 묻는 질문이 겹치는 두 탭을 갈라 둔 이유는
'이용 행동'이 **누구**(사람·AI·여정), 'API 사용량'이 **무엇**(제품별 수요)이기 때문이다.

구성은 이것이 전부다:

```text
단일 Worker (src/index.js)          — GET /api/summary · /api/trace · /api/apis · /api/apis/<이름>, GET·POST /api/keys
+ Static Assets (public/index.html) — 탭 6개짜리 단일 페이지
+ 운영 D1 (ask-seoul-prod-d1)       — **하나뿐이다.** 로컬 구동도 여기 직접 붙는다 (0015)
+ migrations/                       — 0001 _ops_slo·_ops_domain(정본) · 0002 조회 DB 4종(IF NOT EXISTS 미러)
+ fixtures/                         — 합성 샘플 (slo_sample · ops_records_sample) — 시드 체인에 없다
```

🔴 **D1 은 운영 하나뿐이다**([0015](docs/decision/0015-single-production-d1.md)). dev D1 은
2026-08-05 에 폐기했고 로컬 Miniflare 사본도 없다 — 바인딩에 `remote = true` 가 걸려 있어
`npm run dev` 는 **띄우는 순간 운영 DB 에 붙는다.**

**연습할 곳이 없다는 뜻이다.** 예전에는 플래그를 빠뜨리면 로컬로 떨어져 실수의 방향이
안전한 쪽이었는데 **이제 기본값이 운영이다.** 화면의 '삭제' 두 번 클릭은 실제 고객의
키·이메일·사용량을 지운다(불가역). 이 대가는 팀이 알고 택했다(0015 §대가).

이용 행동 탭의 스펙 종속 축(ua_class 등)은 **게이트웨이 반영 전까지 '수집 전'** 이다 —
`_gateway_request_log` 에 ALTER 미러를 만들지 않는다(0010: 정본 마이그레이션과 duplicate column 충돌).

Queues, R2, Durable Objects, Analytics Engine, Terraform, Cloudflare Access,
TypeScript, 모노레포 — **전부 없다.** 없는 이유와 도입 신호는
[decision/0008](docs/decision/0008-deferred-scope.md)에 있다.

## 4. 불변 경계

어기는 순간 사고가 되는 것들. 완화하려면 해당 결정 문서 개정이 먼저다.

- 🔴 **띄우면 운영이다.** 바인딩이 `remote` 라 **로컬 화면의 조치가 실제 고객
  키에 그대로 간다.** 연습용 DB 는 없다. 조치 버튼을 누르기 전에 **무엇을 보고 있는지**
  배지를 확인한다 — 배지는 언제나 "운영"이라고 말한다. 그게 정상이고, 그래서 위험하다.
  → [0015](docs/decision/0015-single-production-d1.md)
- **배포는 `npm run deploy:prod` 로만**(→ ops.ask-seoul.kr). `dev` 브랜치 머지가 곧 운영
  배포다(CD `.github/workflows/deploy-prod.yml`) — **브랜치 이름과 배포 환경이 다르다.**
  env 없는 맨 `wrangler deploy` 금지. 배포본 D1 은 게이트웨이 운영 환경과 반드시 일치시킨다.
  ⚠️ 읽기 경로는 여전히 무인증이라(0004) Access 승격(#20 B-1)이 미완인 채 공개돼 있다.
  → [0015](docs/decision/0015-single-production-d1.md) · [0002(폐기된 원 결정)](docs/decision/0002-local-only-mentor-gate.md)
- 🔴 **남의 표 스키마는 절대 바꾸지 않는다 — 이 경계만 살아남았다.**
  `_keys`·`_usage`·`_burst`·`_gateway_request_log` 의 정본은 `../marketplace/migrations/`,
  `_ops_run_event` 외 3종은 ASAC-DAG, `_catalog`·`_publication_ledger` 는 도메인 export.
  **데이터 쓰기는 열렸어도 스키마는 아니다.** DDL 은 `scripts/d1-query.mjs` 가 전부 막고,
  콘솔 소유 표의 변경도 `migrations/` 추가 파일 + `npm run migrate` 로만 한다.
  → [0015 §안전장치](docs/decision/0015-single-production-d1.md) · [0007](docs/decision/0007-schema-single-file-reset.md)
- **이메일 원문을 API 응답에 싣지 않는다.** 마스킹은 서버에서(`email_masked`).
  화면에서만 가리는 건 마스킹이 아니다. → [0004](docs/decision/0004-read-open-write-token.md)
- **키 조치 식별자는 `key_hash`.** prefix 는 충돌한다.
  → [0006](docs/decision/0006-key-hash-identifier.md)
- **쓰기 경로는 언제나 서버의 `requireWrite`를 거친다.** 화면의 `can_write` 는 버튼 노출용일
  뿐이다 — 보안 판단은 서버가 한다. → [0004](docs/decision/0004-read-open-write-token.md)
- **비밀값(`OPS_TOKEN` 등)은 `.dev.vars`.** 커밋·출력 금지.
- **환경은 `wrangler.toml` 한 파일 안에서 갈린다** — 기본 = 로컬, `[env.production]` = 배포.
  플래그 없으면 언제나 로컬이다. env 섹션은 상속되지 않으니 assets·`run_worker_first` 는
  두 곳을 같이 고친다. → [../docs/environments.md](../docs/environments.md) · [0011](docs/decision/0011-per-env-config.md)
- 🔴 **화면에 모의 데이터를 올리지 않는다.** 예전에는 합성 행을 보여주고 배너로 알렸는데,
  "이 값으로 판단하지 마세요"를 붙여도 **화면에 있으면 읽힌다.** 질의에서 아예 뺀다
  (`is_sample=1` · `event_id LIKE 'smp_%'` · `updated_at='sample'`). 배제 조건은 환경 필터와
  **같은 조각**에 둔다 — 흩어 두면 새 질의에서 빠뜨리고, 그게 합성이 새는 경로다.
  → [0005](docs/decision/0005-slo-snapshot-to-d1.md)
- **거른 것은 걸렀다고 말한다.** 환경 스코프·감시 제외·미등록·미측정을 조용히 빼면 화면이
  거짓말을 한다. 특히 **못 거른 범위**(집계표는 `environment` 컬럼이 없다)를 밝히지 않으면
  섞인 값을 운영 수치로 읽는다. → [0012](docs/decision/0012-runs-tab-observation-boundaries.md)

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
  (그건 화면에서 못 고친다 — 정본이 `fixtures/` 다).
- **요청 값·응답 본문을 화면에 끌어오지 않는다.** `_gateway_request_log` 는 필터 **컬럼명**만 남긴다
  (게이트웨이 수집 원칙). API 사용량 상세는 축·건수·소요시간·request_id 까지이고,
  화면이 "값은 저장하지 않는다"를 직접 밝힌다.
- **프런트는 세 파일이다** — `public/index.html`(마크업 + 이 화면 전용 JS) · `public/ui.css`
  (반응형 UI 킷: 토큰·레이아웃·컴포넌트·툴팁 스타일) · `public/ui.js`(툴팁 엔진).
  🔴 **`ui.css`·`ui.js` 는 프로젝트 독립이다** — ASK-SEOUL 도메인을 하나도 모르고, 다른 앱에
  그대로 붙일 수 있다. 색·서체를 바꾸려면 `ui.css` 의 `:root` 토큰만 갈고, 재사용 가능한 새
  규칙은 인라인 `<style>` 이 아니라 `ui.css` 로 올린다(그래야 캐시되고 다음 앱이 쓴다).
- **반응형 계약**: 폭이 줄면 세 단계로 접힌다 — ≥981 사이드바+2열 / 641~980 상단탭+1열 /
  ≤640 모바일(상단바 2줄·표는 카드 안 스크롤). 근래 5년 삼성·아이폰 세로 폭(360~430)이 다
  이 안에 든다. **본문(body)은 가로로 절대 안 민다**(`overflow-x:hidden`) — 넘치는 표·히트맵은
  **카드 안(`.bd`·`.scroll`)에서만** 스크롤한다. 새 넓은 요소를 그 밖에 두면 화면이 밀린다.
- **상태값은 근거를 툴팁으로 단다.** 판정 배지(멈춤 후보·열화·미확인 …)는 `statePill()` 로
  만들고, 그 문구가 `STATE_HELP` 에 있으면 점선 밑줄 + 툴팁(누르면·올리면 열리고 벗어나면
  닫힌다)이 붙는다. 새 상태를 더하면 `STATE_HELP` 에 한 줄 넣는다 — 없으면 툴팁 없이 배지만 뜬다.
- **날것 수치를 그대로 찍지 않는다.** DB 의 부동소수(`17.7177…ms`)·소수 커버리지는 `fmtMs`·
  `Math.round` 로 접는다. 내부 슬러그(route·status·layer 코드)는 `ROUTE_KO`·`STATUS_KO`·
  `STAGE_KO`·`LAYERS` 번역표를 거친다 — 표에 코드가 필요하면 한글 옆 `pill dim` 으로만 남긴다.
- 주석은 "왜"를 적는다 — 이 리포의 기존 주석 밀도와 문체를 따른다.

## 6. 데이터 소유권

| 테이블 | 정본 | 이 프로젝트의 권한 |
|---|---|---|
| `_ops_slo`, `_ops_domain` | **여기** (`migrations/0001`) | 스키마·내용 모두 |
| `_ops_run_event`, `_ops_daily_metric`, `_ops_pipeline_state`, `_ops_pipeline_expectation` | ASAC-DAG (`common/ops/d1_ops.py`, ops-d1/v1) | **읽기 전용** — 파이프라인 산출물. 로컬 미러 `migrations/0002` 는 정본을 따라만 간다 |
| `_catalog`, 제품 표 `d1_*` | 도메인 export (`meta.serving` 계약) | **읽기 전용** — dbt 산출물 |
| `_keys` | 게이트웨이 | `status`·`daily_quota` 갱신, 삭제 — 정해진 조치만 |
| `_usage`, `_burst` | 게이트웨이 | 키 삭제 시 연쇄 삭제만 |
| `_gateway_request_log` | 게이트웨이 | 읽기 전용 |
| `_request_log` (4컬럼) | **transit 워커** | ❌ 읽지도 쓰지도 않음 — 이름 충돌로 게이트웨이가 비켰다(agreement §2) |

**남의 표를 만들거나 지우지 않는다 — 파이프라인·dbt 산출물은 결코 건드리지 않는다.**
`migrations/0002` 는 이 규칙의 **유일한 예외**이고, 그래서 조건이 붙는다: `CREATE TABLE IF
NOT EXISTS` 만, DROP·ALTER 없이, 팀 D1 에 이미 있으면 아무 일도 하지 않는 형태여야 한다
(로컬 화면을 돌려보기 위한 껍데기 — [0009](docs/decision/0009-ops-records-consumption.md)).
개발용 **표본 데이터**는 `migrations/` 가 아니라 `fixtures/` 에 둔다.

마이그레이션은 **증분(추가만)** — DROP 금지, 변경은 ALTER 추가 파일로([0007](docs/decision/0007-schema-single-file-reset.md),
#78 D-6). `0001` 은 더 고치지 않는다. 적용은 장부가 추적한다
(`wrangler d1 migrations apply`, 장부 표는 `d1_migrations_ops_dashboard` — 게이트웨이와 분리).
내용 리프레시는 픽스처가 자기 범위를 DELETE 하고 다시 넣는다.

## 7. 검증

🔴 **검증도 운영 D1 에서 한다**(0015). 연습용 DB 가 없으므로 **읽기로 확인할 수 있는 것을
먼저 다 하고**, 쓰기 검증은 마지막에 **자기가 만든 대상**으로만 한다.

```bash
npm run dev          # :8788 — 바인딩이 remote 라 곧바로 운영 D1 이다. 띄우는 순간 실물
npm run migrate      # 스키마 적용(수동). CREATE IF NOT EXISTS 뿐이라 있는 표는 안 건드린다
npm run migrate:list # 무엇이 적용됐나 먼저 본다
npm run d1 -- "SELECT COUNT(*) FROM _ops_run_event"   # DDL 은 막힌다
```

OS별 사전 준비·증상별 해결은 [../docs/setup.md](../docs/setup.md) — 게이트웨이 담당자와
함께 관리하는 문서다. 실행·마이그레이션·포트·비밀값 규약을 바꾸면 같은 커밋에서 그 문서를
고치고 상대 담당자에게 알린다.

- API 는 curl 로: `/api/summary?days=14`, `/api/keys` (GET 무인증 / POST 는 Bearer).
- 쓰기 경로를 고쳤으면 **토큰 미설정(503)·토큰 없음(401)·잘못된 토큰(401)** 을 다 본다.
  ⚠️ 정상 경로(200) 검증은 **실제 고객 키에 하지 않는다.** 확인용 키를 직접 발급해 그것으로만.
- 화면을 고쳤으면 탭 6개와 배지(수집 전·탭 경고 점) 동작을 본다.
- **화면 스크립트는 띄워서 실제로 눌러 본다** — `node --check` 는 TDZ 를 통과시킨다(실사례 2건).
- 검증 명령 세트와 실행 기록 탭의 시나리오별 확인법은 [docs/runbook.md](docs/runbook.md).

### 7-1. 문서 동기화 — 무엇을 고치면 어디를 같이 고치나

"문서와 코드가 어긋나면 같이 고친다"(10절)는 **이미 있던 규칙인데 지켜지지 않았다.** 2026-08-04
에 시드에서 픽스처를 뺐는데 README·runbook·이 문서가 그 다음 날까지 "시드가 합성값을 넣는다"고
말하고 있었다. 규칙이 약해서가 아니라 **어느 문장이 그 코드를 비추고 있는지 몰라서**다.
그래서 대응표를 못 박는다 — 왼쪽을 건드리면 오른쪽을 **같은 커밋에서** 연다.

| 고친 것 | 같이 여는 문서 |
|---|---|
| `package.json` 의 `scripts` (dev·migrate·d1·포트) | [README](README.md) 실행 절차 · [runbook §1](docs/runbook.md) · 이 문서 7절 · [../docs/index.md](../docs/index.md) 의 **해당 환경 매뉴얼** · [../docs/environments.md](../docs/environments.md) §3 명령표 |
| **스크립트 이름 변경** | 위 전부 + `grep -rn "<옛 이름>"` — 이름은 여러 문서에 흩어져 있다 |
| `migrations/` 실행 여부·대상 | [runbook §1-1·§5](docs/runbook.md) · README 해당 절 · 이 문서 6절 · [../docs/run-prod.md](../docs/run-prod.md) |
| 화면 배지·배너의 신설/폐기 | README 해당 절 · [runbook §6 증상표](docs/runbook.md) · 이 문서 7절 검증 항목 · [run-prod](../docs/run-prod.md) 의 "확인한다" 절 |
| **재사용 UI 규칙**(레이아웃·컴포넌트·툴팁·팔레트) | `public/ui.css`·`public/ui.js` 에 넣고 이 문서 §5 프런트 규약과 맞춘다 — 인라인 `<style>` 로 되돌리지 않는다(캐시·재사용이 목적) |
| `meta.*` 응답 필드 | [runbook §2](docs/runbook.md) 의 `jq` 예시 (없는 필드를 파면 `null` 이 조용히 나온다) · 환경 매뉴얼의 `curl` 예시 |
| **게이트웨이 route 값**(추가·개명·삭제) | [0014 §1 값 표](docs/decision/0014-console-route-contract.md) + `public/index.html` 의 `ROUTE_KO` 를 **같은 커밋에서**. 빠지면 화면에 내부 슬러그가 샌다. ⚠️ **퇴역한 값도 남긴다** — 로그는 개명보다 오래 산다(0014 §1-1) |
| **무엇을 '데이터 서빙'으로 세나** | [0014 §2](docs/decision/0014-console-route-contract.md) 의 `SERVE_ROUTES` **한 곳만** — 배열이 정본이고 SQL·`meta.serve_routes` 가 거기서 나온다. 다섯 곳에 흩어 뒀던 것이 #63 사고의 원인이다 |
| 🔴 **서빙 로그를 읽는 새 질의** | `gwWhere(env)`(별칭 있으면 `gwWhereR`)를 **반드시 건다**(#64). 안 걸면 `local`·`dev` 요청이 운영 지표에 조용히 합산된다. 일부러 안 거는 자리(요청 추적·환경 분포)는 **코드에 근거를 적는다** — 그 둘뿐이다 |
| `wrangler.toml` 환경·바인딩 | [../docs/environments.md](../docs/environments.md) · README · [0011](docs/decision/0011-per-env-config.md) · **환경을 늘렸으면 매뉴얼 한 장을 새로 쓰고 [../docs/index.md](../docs/index.md) 에 매핑** |
| 🔴 **D1 에 붙는 경로**(바인딩·`remote`·스크립트) | [0015](docs/decision/0015-single-production-d1.md) 먼저 — **운영에 직접 붙는다**는 전제가 유지되는지, 그리고 연결이 조용히 로컬로 떨어지지 않는지(0015 §대가의 실측표) |
| **남의 표를 건드리는 SQL·마이그레이션** | [0015 §안전장치](docs/decision/0015-single-production-d1.md) · [0007](docs/decision/0007-schema-single-file-reset.md) · 6절 소유권 표 — 정본 소유자가 먼저다 |
| 🔴 **인증·접근 제어**(게이트·토큰·라우트) | [0004](docs/decision/0004-read-open-write-token.md) **먼저** · [../docs/access-control.md](../../docs/access-control.md) 의 해당 레이어 절 · 새 `/api` 경로를 더했으면 **게이트가 그걸 덮는지** 확인(라우터 맨 앞 한 곳) |
| **사람이 직접 쳐야 하는 작업**(시크릿·마이그레이션·인프라) | [../docs/manual-steps.md](../../docs/manual-steps.md) 에 **먼저 적는다** — PR 본문에만 적으면 머지된 뒤 아무도 안 본다(실사례: `dev-ops` 도메인이 "폐기"로 적힌 채 살아 있었다) |
| 불변 경계(4절)에 해당하는 동작 | 해당 `decision/` 문서 **먼저**, 그다음 위 전부 |

**끝내기 전 확인** — 고친 코드에서 사라진 낱말(예: 배지 이름, 스크립트가 더 안 읽는 파일명)을
문서에서 되짚는다. 남아 있으면 그게 낡은 서술이다.

```bash
# 예: 스크립트를 없앴다면 — 문서가 아직 그 이름을 부르는지
grep -rn "npm run seed\|dev:remote\|dev:prod-readonly\|deploy:dev" --include=*.md . ../docs
```

이 표 자체도 대상이다 — 새 문서를 만들거나 코드 표면을 늘리면 **행을 추가한다.**

## 8. 완료 기준

- 요구사항이 코드에 반영되고 **운영 D1 에서 확인됨**(연습용 DB 가 없다 — 7절)
- 오류 응답이 problem+json 으로 일관됨
- 응답·로그에 이메일 원문과 토큰이 없음
- 불변 경계(4절)를 건드리지 않음 — 건드렸다면 결정 문서 개정이 먼저 있었음
- README·docs 가 실체와 어긋나지 않게 같이 갱신됨 — **7-1 대응표의 해당 행을 전부 열었음**

## 9. 구조 검토가 필요한 변경

바로 구현하지 않는다. decision/ 문서(신규 또는 개정)로 사유·비용·단순 대안·롤백을 먼저 적는다.

```text
인증 방식 변경                     → 0004 개정 (Access/OAuth 승격 포함)
조치 이력(누가 했나)을 남기는 것   → 0004 개정 — 0015 가 미룬 숙제다. 지금은 못 남긴다
저장소·인프라 추가(Queue·R2·DO·AE …) → 0008 의 도입 신호 확인 후 신규 결정
마이그레이션에 DROP·이름 변경      → 금지 — 0007 규약(증분·추가만, #78 D-6)
남의 표 스키마 변경                → 금지. 정본 소유자가 먼저 (marketplace · ASAC-DAG · dbt)
조회 DB 4종 스키마 변경            → 정본(ASAC-DAG)이 먼저 — 미러·화면은 0009 대로 추종
키 상태 모델 확장                  → 0006 개정 (게이트웨이와 공동)
격리 환경을 다시 만드는 것         → 0015 개정 — "왜 다시 필요한가"부터 적는다
```

## 10. Claude 작업 규칙

- 관련 파일과 기존 구조를 먼저 확인하고, 기존 규약을 재사용한다.
- 요구사항과 무관한 리팩터링·프레임워크 도입을 하지 않는다.
- 보안·비용에 영향을 주는 변경은 그 영향을 명시한다.
- 구현 후 변경 파일과 검증 결과를 요약하고, 실패·미검증 사항을 숨기지 않는다.
- 문서(docs/·README)와 코드가 어긋나는 변경이면 같은 커밋에서 문서를 고친다 —
  **어디를 고칠지는 추측하지 말고 7-1 대응표를 따르고**, 표에 없는 표면을 건드렸으면 행을 더한다.
- 코드에서 무엇을 **없앴을 때**가 특히 위험하다. 없앤 낱말로 `grep` 을 돌려 문서에 남은
  서술을 걷어낸다 — 추가는 눈에 띄지만 삭제는 문서에 흔적으로 남는다.
- 비밀값·API Token·실제 API Key 를 출력하거나 커밋하지 않는다.
