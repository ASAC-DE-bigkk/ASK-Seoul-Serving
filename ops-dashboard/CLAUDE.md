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
| 데이터 준비 상태 | 수집·변환이 제 몫을 했나 | `_ops_slo` (보조 스냅샷 — 로컬은 비어 있다) |
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
+ 공유 로컬 D1                       — 게이트웨이(../marketplace)와 같은 상태 (--persist-to)
+ 원격 D1 (dev:dev-d1·dev:prod-d1) — 조회 DB 4종의 **실측**은 여기에만 있다. **보기 전용**(0013)
+ migrations/                       — 0001 _ops_slo·_ops_domain(정본) · 0002 조회 DB 4종(로컬 미러)
+ fixtures/                         — 합성 픽스처 (slo_sample · ops_records_sample) — **시드가 실행하지 않는다**
```

**조회 DB 4종의 실측은 로컬 Miniflare 에 없다.** 팀 D1 에 있으므로 원격 바인딩으로 띄워야
보인다 — `npm run dev:dev-d1`(팀 dev, :8798) · `npm run dev:prod-d1`(운영, :8799).
로컬의 `migrations/0002` 미러는 화면을 돌려보기 위한 **빈 껍데기**이지 정본이 아니다.

`--remote` 는 그 자체로는 읽기 전용이 아니다 — 그 상태의 키 조치가 팀 DB 에 그대로
적용된다. 그래서 두 스크립트가 `--var ENV_READONLY:1` 을 넘겨 **코드로 잠근다**
([0013](docs/decision/0013-remote-readonly-attach.md)). **안전한 것은 `--remote` 가 아니라
그 스크립트 경로다** — wrangler 를 직접 치면 빗장이 없다. 절차는
[../docs/run-remote-dev.md](../docs/run-remote-dev.md) · [../docs/run-prod.md](../docs/run-prod.md).

이용 행동 탭의 스펙 종속 축(ua_class 등)은 **게이트웨이 반영 전까지 '수집 전'** 이다 —
`_gateway_request_log` 에 ALTER 미러를 만들지 않는다(0010: 정본 마이그레이션과 duplicate column 충돌).

Queues, R2, Durable Objects, Analytics Engine, Terraform, Cloudflare Access,
TypeScript, 모노레포 — **전부 없다.** 없는 이유와 도입 신호는
[decision/0008](docs/decision/0008-deferred-scope.md)에 있다.

## 4. 불변 경계

어기는 순간 사고가 되는 것들. 완화하려면 해당 결정 문서 개정이 먼저다.

- **`wrangler deploy` 금지.** 로컬 전용(`wrangler dev`)이다. 공개 URL 신설은 팀 결정 사항
  (agreement §8). package.json 에 deploy 스크립트를 만들지 않는다. `dev:prod-d1` 은
  배포가 아니다 — 워커는 로컬에서 돌고 D1 만 원격에 붙는다.
  → [0002](docs/decision/0002-local-only-mentor-gate.md)
- **팀(원격) D1 에 쓰지 않는다.** 모든 시드·로더는 로컬 상태(`--persist-to`)만 만진다.
  원격에 붙는 경로(`dev:dev-d1`·`dev:prod-d1`·`d1:dev`·`d1:prod`)는 **전부 보기 전용**이고,
  그 빗장은 문서가 아니라 코드에 있다. **새 원격 경로를 만들 때 빗장을 같이 달지 않으면
  경계가 뚫린다** — 빗장은 `--var ENV_READONLY:1`(워커) / 읽기 화이트리스트(SQL).
  → [0002](docs/decision/0002-local-only-mentor-gate.md) · [0013](docs/decision/0013-remote-readonly-attach.md)
- **게이트웨이 소유 테이블의 스키마를 여기서 바꾸지 않는다.** `_keys`·`_usage`·`_burst`·
  `_gateway_request_log` 의 정본은 `../marketplace/migrations/`. 여기서는 읽기와 정해진 키 조치만.
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

배포 파이프라인이 없으므로 로컬에서 직접 확인한다.

```bash
npm run seed   # _ops_* 증분 마이그레이션 → 공유 로컬 D1. **표만 만든다 — 데이터 0건**
npm run dev    # :8788 — 게이트웨이(:8787)와 동시 구동 가능 (인스펙터 9230 고정 — 저쪽 기본 9229 와 안 겹친다)

# 원격 D1 을 볼 때 (배포 아님 — 워커는 로컬, D1 만 원격). 셋 다 동시 구동 가능.
npm run dev:dev-d1    # 팀 dev D1  → :8798  🔒 보기 전용
npm run dev:prod-d1   # 운영 D1    → :8799  🔒 보기 전용
npm run d1:local -- "SELECT ..."   # d1:dev · d1:prod — 읽기 문장만 통과
```

시드는 `fixtures/` 를 실행하지 않는다(4절 🔴). **시드 직후 화면이 비어 있는 것이 정상**이고,
그걸 "덜 됐다"고 읽어 픽스처를 시드 체인에 도로 넣지 않는다.

OS별 사전 준비·증상별 해결은 [../docs/setup.md](../docs/setup.md) — 게이트웨이 담당자와
함께 관리하는 문서다(같은 로컬 D1을 공유하므로 실행 절차가 하나다). 실행·시드·포트·비밀값
규약을 바꾸면 같은 커밋에서 그 문서를 고치고 상대 담당자에게 알린다.

- API 는 curl 로: `/api/summary?days=14`, `/api/keys` (GET 무인증 / POST 는 Bearer).
- 쓰기 경로를 고쳤으면 **토큰 미설정(503)·토큰 없음(401)·잘못된 토큰(401)** 을 다 본다.
  그리고 **보기 전용(503 `read-only mode`)** — 올바른 토큰을 들고 와도 막혀야 한다([0013](docs/decision/0013-remote-readonly-attach.md)).
- 게이트웨이 테이블이 없는 상태(마켓플레이스 미시드)에서도 콘솔이 뜨는지 본다
  (`meta.missing` 강등).
- 화면을 고쳤으면 탭 6개와 배지(읽기 전용·수집 전·탭 경고 점) 동작을 본다 — '샘플' 배지는
  없다(4절 🔴 에서 폐기).
- 검증 명령 세트와 실행 기록 탭의 시나리오별 확인법은 [docs/runbook.md](docs/runbook.md).

### 7-1. 문서 동기화 — 무엇을 고치면 어디를 같이 고치나

"문서와 코드가 어긋나면 같이 고친다"(10절)는 **이미 있던 규칙인데 지켜지지 않았다.** 2026-08-04
에 시드에서 픽스처를 뺐는데 README·runbook·이 문서가 4개월 뒤까지 "시드가 합성값을 넣는다"고
말하고 있었다. 규칙이 약해서가 아니라 **어느 문장이 그 코드를 비추고 있는지 몰라서**다.
그래서 대응표를 못 박는다 — 왼쪽을 건드리면 오른쪽을 **같은 커밋에서** 연다.

| 고친 것 | 같이 여는 문서 |
|---|---|
| `package.json` 의 `scripts` (seed·dev·포트) | [README](README.md) 실행 절차 · [runbook §1](docs/runbook.md) · 이 문서 7절 · [../docs/index.md](../docs/index.md) 의 **해당 환경 매뉴얼** · [../docs/environments.md](../docs/environments.md) §3 명령표 |
| **스크립트 이름 변경** | 위 전부 + `grep -rn "<옛 이름>"` — 이름은 여러 문서에 흩어져 있다 |
| `migrations/` · `fixtures/` 실행 여부 | [runbook §1·§3·§4](docs/runbook.md) · README 해당 절 · 이 문서 6절 · [../docs/run-local.md](../docs/run-local.md) |
| 화면 배지·배너의 신설/폐기 | README 해당 절 · [runbook §6 증상표](docs/runbook.md) · 이 문서 7절 검증 항목 · 원격 관련이면 [run-remote-dev](../docs/run-remote-dev.md)·[run-prod](../docs/run-prod.md) 의 "확인한다" 절 |
| `meta.*` 응답 필드 | [runbook §2](docs/runbook.md) 의 `jq` 예시 (없는 필드를 파면 `null` 이 조용히 나온다) · 환경 매뉴얼의 `curl` 예시 |
| `wrangler.toml` 환경·바인딩 | [../docs/environments.md](../docs/environments.md) · README · [0011](docs/decision/0011-per-env-config.md) · **환경을 늘렸으면 매뉴얼 한 장을 새로 쓰고 [../docs/index.md](../docs/index.md) 에 매핑** |
| **원격에 붙는 경로**(스크립트·플래그) | [0013](docs/decision/0013-remote-readonly-attach.md) 먼저 — 빗장 없는 원격 경로를 만들지 않았는지 확인 |
| 불변 경계(4절)에 해당하는 동작 | 해당 `decision/` 문서 **먼저**, 그다음 위 전부 |

**끝내기 전 확인** — 고친 코드에서 사라진 낱말(예: 배지 이름, 스크립트가 더 안 읽는 파일명)을
문서에서 되짚는다. 남아 있으면 그게 낡은 서술이다.

```bash
# 예: 픽스처를 시드에서 뺐다면 — 문서가 아직 시드가 넣는다고 말하는지
grep -rn "slo_sample\|ops_records_sample\|npm run seed" --include=*.md . ../docs
```

이 표 자체도 대상이다 — 새 문서를 만들거나 코드 표면을 늘리면 **행을 추가한다.**

## 8. 완료 기준

- 요구사항이 코드에 반영되고 로컬에서 확인됨
- 오류 응답이 problem+json 으로 일관됨
- 응답·로그에 이메일 원문과 토큰이 없음
- 불변 경계(4절)를 건드리지 않음 — 건드렸다면 결정 문서 개정이 먼저 있었음
- README·docs 가 실체와 어긋나지 않게 같이 갱신됨 — **7-1 대응표의 해당 행을 전부 열었음**

## 9. 구조 검토가 필요한 변경

바로 구현하지 않는다. decision/ 문서(신규 또는 개정)로 사유·비용·단순 대안·롤백을 먼저 적는다.

```text
공개 배포(어떤 형태든)             → 0002 개정 + 배포 결정(agreement §8)
인증 방식 변경                     → 0004 개정 (Access/OAuth 승격 포함)
게이트웨이 테이블 쓰기 확대        → 0003 개정
저장소·인프라 추가(Queue·R2·DO·AE …) → 0008 의 도입 신호 확인 후 신규 결정
마이그레이션에 DROP·이름 변경      → 금지 — 0007 규약(증분·추가만, #78 D-6)
조회 DB 4종 스키마 변경            → 정본(ASAC-DAG)이 먼저 — 미러·화면은 0009 대로 추종
키 상태 모델 확장                  → 0006 개정 (게이트웨이와 공동)
원격에서 조치 허용(빗장 해제)      → 0013 + 0002 개정 — "누가 했나"가 남는 인증(0004)이 선행
새 원격 접속 경로 추가             → 0013 대로 빗장을 같이 단다. 빗장 없는 경로는 만들지 않는다
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
