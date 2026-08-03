# ops-dashboard — 운영자용 통합 품질 콘솔 (ASK-Seoul#58)

파이프라인 품질과 서빙 품질을 **한 화면**에서 본다. [마켓플레이스](../marketplace/)와
**다른 Worker · 다른 호스트**다 — 청중이 다르고(외부 고객 vs 운영자), 배포 단위가 갈려야
사고 반경도 갈린다.

| 탭 | 묻는 질문 | 출처 |
|---|---|---|
| 데이터 준비 상태 (`#pipeline`) | 수집·변환이 매일 제때 끝났나 | `_ops_slo` (gold_*_slo_daily 스냅샷) |
| 응답 상태 (`#serving`) | 외부에 잘 나가고 있나 | `_request_log` (게이트웨이가 쌓는다) |
| API 사용량 (`#usage`) | 무엇이 얼마나 쓰이나 — API별·분야별 | `_request_log` + `_catalog` |
| 이용자 키 (`#keys`) | 누가 쓰고 있고, 손댈 것이 있나 | `_keys` + `_usage` + `_request_log` |

**화면 문구는 내부 용어를 쓰지 않는다.** SLO·route·status·preview 같은 말은 화면에 내보내지 않고
"제때 갱신된 날"·"요청 종류"·"없는 데이터"·"미리보기"로 번역한다. 번역표는
[public/index.html](public/index.html)의 `ROUTE_KO`·`STATUS_KO` 한 곳에 모아 뒀다 —
화면 곳곳에 한글을 흩뿌리면 어디를 고쳐야 할지 알 수 없게 된다.

탭은 URL 해시에 실린다 — 새로고침·링크 공유에도 보던 자리가 유지된다.
**탭 라벨의 점**은 그 탭이 아픈지를 전환 없이 알려준다(빨강 = 정기런 실패·계약 위반 /
에러율 5% 이상·0행 발생). 탭으로 나누면 안 보는 쪽 문제를 놓치기 쉬운데, 그 대가를
점이 상쇄한다.

## API 사용량 탭 — "무엇이 쓰이나"

응답 상태 탭이 "잘 나갔나"(실패·빈 응답)를 본다면, 여기는 **수요**를 본다.

- **분야별 사용 비중** — 전체 요청 중 각 분야의 몫. 분야는 `_catalog.product_id` 의 접두사다
  (`commerce_age_band` → commerce). 파이프라인이 그 규칙으로 발행하고 `_ops_domain` 6개와 그대로
  맞아서, **도메인 컬럼이나 매핑 테이블을 새로 만들지 않았다.**
- **API 전체 목록** — 등록된 62종 전부. **한 번도 안 불린 API 도 나온다** — 안 쓰이는 것이야말로
  알아야 하는 정보다. 분야 필터 · 이름·설명 검색 · "요청이 있었던 것만" 토글.
- **상세 보기** — `#usage/<API 이름>` 으로 주소에 실린다(탭과 같은 규약). 링크로 공유된다.

### 상세 보기가 보여주지 **않는** 것

요청에 담긴 **값**과 응답 본문은 애초에 저장하지 않는다 — `_request_log` 수집 원칙 ①(값이 아니라
축만)·②(식별자는 이미 해시인 것만)이고, 마켓플레이스의 불변 경계이기도 하다. 그래서 상세 보기는
**어떤 항목으로 걸렀나**(컬럼명 조합)·응답 건수·소요 시간·요청 번호까지만 보여주고, 화면이 그
사실을 직접 적는다("없는 게 아니라 안 남긴 것"으로 읽히게 — 버그 제보를 막는다).

값까지 보려면 그 원칙을 뒤집는 공동 결정(게이트웨이 스키마 정본 + 처리방침 개정)이 먼저다.
운영자가 특정 요청을 추적해야 하는 실제 상황은 **요청 번호**(`request_id`)로 해결된다 —
이용자가 문의에 그 번호를 실어 보내면 그 한 줄을 찾을 수 있다.

## 이용자 키 탭 — 이 콘솔에서 유일하게 **쓰는** 화면

나머지 두 탭은 읽기 전용이지만 여기는 `_keys` 를 고친다. `GET /api/keys` 로 목록을,
`POST /api/keys` 로 조치를 받는다 — `{action, key_hash, daily_quota?}`, action 은
`revoke`·`restore`·`quota`·`delete`.

- **식별자는 `key_prefix` 가 아니라 `key_hash`** 다. prefix 는 8자(`ask_`+4hex)라 충돌할 수
  있고, 엉뚱한 사람의 키를 폐기하는 사고는 되돌리기 어렵다. 해시는 자격증명이 아니다 —
  인증에는 원문이 필요하므로 해시를 알아도 호출하지 못한다.
- **게이트웨이의 셀프 폐기와 다른 점은 키 원문이 필요 없다는 것**이다. 이용자가 키를
  잃어버려도 운영자는 조치할 수 있어야 한다.
- **이메일은 서버에서 가려서 내보낸다** — `lu***@gmail.com` 꼴(`email_masked`). 화면에서만
  가리면 API 응답·개발자도구·`curl` 에 원문이 그대로 남아 가린 게 아니다. 운영자에게 필요한
  건 "어느 행이 누구 것인지 구분"이고 조치는 전부 `key_hash` 로 돌기 때문에, 원문을 응답에
  실을 이유가 없다. 전체 주소가 정말 필요한 드문 경우는 D1 을 직접 조회한다.
  응답 키 이름도 `email` 이 아니라 `email_masked` 다 — 이 값을 실제 주소로 착각하지 않게.
- 마스킹은 **주소 유출만 막는다.** 도메인은 그대로 남고 이 화면은 여전히 쿼터·사용량·조치
  버튼을 노출하므로, `OPS_TOKEN` 게이트는 그대로 필수다. 공개 배포 시 토큰을
  Cloudflare Access / org OAuth 로 교체하는 건 이 탭 때문에 더 급해진다.
- 폐기·삭제는 **버튼을 두 번 눌러야** 실행된다(`정말 폐기`/`정말 삭제`로 바뀐 뒤). 폐기는
  되돌릴 수 있지만(`복구`) 삭제는 못 되돌린다.
- 삭제는 이용자의 삭제 요청을 운영자가 대신 처리하는 경로다. `_request_log` 의 `key_hash`
  는 남지만 해시→이메일 대응이 사라져 사람과 연결되지 않는다(처리방침에 적은 그대로).

## 인증 — 읽기는 열려 있고, 조치만 잠겨 있다

| | 토큰 없이 | `OPS_TOKEN` 으로 잠금 해제 |
|---|---|---|
| 파이프라인·서빙 품질 보기 | ✅ | ✅ |
| 키 목록 보기(이메일 마스킹) | ✅ | ✅ |
| 폐기·복구·쿼터 변경·삭제 | ❌ `401` | ✅ |

화면을 보여주는 게 이 콘솔의 쓸모라서 **읽기는 토큰 없이 연다.** 대신 되돌릴 수 없는 조치는
주소를 아는 사람 전부에게 열어둘 수 없으므로 `POST /api/keys` 는 언제나 토큰을 요구한다
(`OPS_TOKEN` 미설정이면 `503` — 조치가 열리는 게 아니라 닫힌다).

원래는 토큰이 없으면 `503` 으로 화면 전체를 껐다. 그 취지("인증 없는 운영 화면이 실수로
열리는 것보다 낫다")를 버린 게 아니라 **쓰기 쪽으로 옮긴** 것이고, 그 사이 이메일 마스킹이
들어와 읽기의 위험이 줄었다는 판단이 깔려 있다.

- 화면의 `can_write` 는 **버튼을 낼지 말지**만 정한다. 그걸 콘솔에서 켜도 뚫리지 않는다 —
  실제 차단은 서버의 `requireWrite` 다. 화면은 못 할 일을 버튼으로 내밀지 않을 뿐이다.
- 상단 배지가 현재 상태를 늘 보여준다(`읽기 전용 · 잠금 해제` ↔ `운영자 모드 · 잠그기`).
  잠그기를 누르면 세션의 토큰을 지우고 읽기 전용으로 돌아간다.
- **읽기를 열었다고 노출해도 되는 화면이 된 건 아니다.** 파이프라인 SLO·요청 로그·키 사용량은
  여전히 내부 운영 정보이고, 이메일 도메인은 마스킹 뒤에도 남는다.

## ⚠️ 로컬 전용

`wrangler dev` 로만 구동. **`wrangler deploy` 금지** — 공개 URL 신설은 멘토 게이트(#476 ①).

## 실행

D1 은 게이트웨이와 **같은 로컬 상태를 공유**한다(`--persist-to`). 서빙 품질 원본인
`_request_log` 가 저쪽에 쌓이기 때문이다 — 그래서 **`../marketplace` 를 먼저 시드**해야 한다.

사전 준비(Node 20+)·OS별 차이·증상별 해결은 **[../docs/setup.md](../docs/setup.md)**,
환경별 설정 배치(로컬/운영 도메인·D1·시크릿)는 **[../docs/environments.md](../docs/environments.md)**
가 정본이다. 둘 다 게이트웨이와 공유하는 문서라 실행 규약을 바꾸면 저쪽 담당자와 같이 고친다.

```bash
# macOS / Linux
cd ops-dashboard
npm install
npm run seed         # _ops_slo/_ops_domain + 합성 SLO 14일 → 공유 D1
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
npm run dev          # http://localhost:8788
```

```powershell
# Windows (PowerShell) — openssl 은 없다. && 도 없다.
cd ops-dashboard
npm install
npm run seed
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" | Set-Content .dev.vars -Encoding ascii
npm run dev          # http://localhost:8788
```

`.dev.vars` 는 `.gitignore` 대상이다(커밋 금지). 변수의 의미는
[.dev.vars.example](.dev.vars.example) 에 적어 뒀다. 환경 배치(로컬/운영 도메인·D1·시크릿)는
[../docs/environments.md](../docs/environments.md) 가 정본이다.

**Windows 에서 `-Encoding ascii` 를 빼지 말 것.** 빠지면 `.dev.vars` 가 UTF-16LE 로 저장돼
wrangler 가 토큰을 못 읽는데, 기동 로그에는 `Using secrets defined in .dev.vars` 가 그대로
떠서 **조치만 503 이 되는 조용한 실패**가 된다([setup.md §3](../docs/setup.md)).

## 데이터 준비 상태 탭 — 실측 근거는 파이프라인 실행 기록이다

파이프라인·dbt 가 실행하면서 D1 에 남기는 **운영 기록 4종**을 읽는다(`GET /api/pipeline`).
정본은 ASAC-DAG `common/ops/d1_ops.py` 이고 **콘솔은 읽기 전용 소비자**다(#78 §8 · [0005](docs/decision/0005-slo-snapshot-to-d1.md)).

| 표 | 화면에서 |
|---|---|
| `_ops_daily_metric` | 날짜×분야×단계 집계 — 규약이 지정한 화면용 표(D-7) |
| `_ops_run_event` | 실행 기록 원본 — 집계가 비었을 때 "그래도 기록은 있다"를 보인다 |
| `_ops_pipeline_state` | 작업(DAG)별 마지막 결과 + 점검 상태 |
| `_ops_pipeline_expectation` | 얼마나 자주 돌아야 하는지(감시 대상 여부) |

**이 표들은 로컬 Miniflare 에 없다** — 팀 dev D1 에 있다. 그래서 보려면 원격 바인딩으로 띄운다.

```bash
cp .env.example .env      # CLOUDFLARE_API_TOKEN (D1:Read 면 충분)
npm run dev:remote        # wrangler dev --remote
```

⚠️ `--remote` 는 읽기 전용 모드가 아니다 — 그 상태에서 키 차단·삭제를 누르면 팀 dev D1 에
적용된다([0002](docs/decision/0002-local-only-mentor-gate.md) 불변 경계). **보기 위한 모드다.**

### 모른다 ≠ 0

측정하지 못한 값은 0 이 아니라 **미확인**으로 그린다(#78 F-3). `layer` 가 NULL 인 기록,
`row_count` 가 NULL 인 기록을 따로 세서 KPI·표·배너에 올린다 — 0 으로 그리면 관측 공백이
"이상 없음"으로 위장된다. 실측(2026-08-03): 186건 중 **52건이 단계 미기록**.

집계표(`_ops_daily_metric`)가 비었는데 원본에는 기록이 있으면 그 사실을 배너로 알린다.
콘솔이 집계를 대신 만들지는 않는다 — 만드는 순간 정본이 둘이 된다.

## "이 숫자는 합성 예시입니다" 배너는 무엇을 보고 뜨나

**환경(dev/prod)이나 D1 이 아니라 `_ops_slo` 행의 `is_sample` 값**을 본다. 서버가 세 상태로
갈라 내보내고(`meta.pipeline_source`), 화면은 그에 맞는 문구와 **다음에 할 일**을 적는다.

| `pipeline_source` | 언제 | 화면 |
|---|---|---|
| `none` | 그 기간에 `_ops_slo` 행이 없다 | "기록이 없습니다" + `npm run seed` / `load_slo.py` 안내 |
| `sample` | `is_sample=1` 이 섞였다 | 합성 배너 + 실측으로 바꾸는 법 |
| `live` | 전부 `is_sample=0` | 배너 없음 |

**환경을 바꿔도 이 값은 안 바뀐다.** 어느 D1 이든 `_ops_slo` 에는 **우리가 넣은 것만** 들어 있기
때문이다. 파이프라인은 이미 실행 기록을 조회 DB 에 싣고 있는데(아래) **콘솔이 아직 그걸 읽지
않아서**, 로컬에는 `npm run seed` 의 합성값만 남는다.

### 정본 공급자는 Trino 가 아니라 조회 DB 4종이다

팀 규약 **ASK-Seoul#78 D-2** — "기존 `_ops_slo`·`_ops_domain` 은 스키마를 바꾸지 않는다.
화면이 이미 쓰는 계약이며, **위 4종에서 값을 채운다**"(`_ops_run_event`·`_ops_daily_metric`·
`_ops_pipeline_state`·`_ops_pipeline_expectation`). 그 적재는 **이미 동작한다** —
ASAC-DAG#647 병합 후 **#655**(2026-08-03)가 실제 조회 DB 에 표 4종 생성 · 52건 적재를 확인했다.

남은 일은 **콘솔이 4종을 읽는 것**([direction.md 축 1](docs/direction.md)). 그 전에
**#78 D-6 이 선행**이다 — 콘솔 마이그레이션이 `DROP TABLE IF EXISTS` 로 시작하므로
([0007](docs/decision/0007-schema-single-file-reset.md)) 팀 DB 에 표를 만들기 전에 증분으로
바꿔야 한다. 안 바꾸면 첫 스키마 수정이 팀 데이터를 지운다.

**`scripts/load_slo.py`(Trino)는 그때까지의 로컬 폴백**이지 정규 경로가 아니다
([0005 개정 주석](docs/decision/0005-slo-snapshot-to-d1.md)).

지금 어느 환경의 무슨 DB 를 보고 있는지는 **화면 상단 배지**에 늘 떠 있다
(`wrangler.toml` 의 `[vars] ENV_LABEL·ENV_D1`, 운영은 붉은색). 숫자만 보고 추측하게 두면
로컬 값을 운영 실적으로 오해하는 사고가 난다.

## 왜 SLO 를 복사하나

Trino 는 `http://trino:8080` — **Docker 내부 주소라 Cloudflare Worker 가 닿지 못한다.**
그래서 콘솔이 파이프라인 품질을 보려면 요약을 밀어 넣는 수밖에 없다. 다행히 SLO 마트는
**날짜 1행**이라 도메인 6개 × 1년 = 2,200행 — 웨어하우스를 옮기는 게 아니라 요약 한 줌이다.

## 실적재

```bash
# macOS / Linux
python3 scripts/load_slo.py            # Trino 조회 → fixtures/slo_live.sql → 로컬 D1 적용
python3 scripts/load_slo.py --dry-run  # SQL 만 생성
TRINO_URL=http://127.0.0.1:30586 python3 scripts/load_slo.py   # 포트가 다르면
```

```powershell
# Windows — VAR=값 접두 문법이 없다. $env: 로 미리 넣는다.
python scripts\load_slo.py
python scripts\load_slo.py --dry-run
$env:TRINO_URL = 'http://127.0.0.1:30586'
$env:TRINO_CATALOG = 'iceberg'         # 기본값은 iceberg_dev — 환경마다 다르다
python scripts\load_slo.py
```

카탈로그 이름은 docker-compose 구성에 따라 다르다. `Catalog 'iceberg_dev' not found` 는
**Trino 접속은 됐다는 뜻**이고 이름만 틀린 것이다 — `SHOW CATALOGS` 로 확인한다
([setup.md §5](../docs/setup.md)).

의존성 없이 Trino REST(`v1/statement`)를 직접 호출한다. 실측(2026-07-28):
`iceberg_dev.culture.gold_culture_slo_daily` **29행 · 2026-06-30 ~ 07-28**.

**이 스크립트는 임시다.** 정규 경로는 culture DAG 의 export task 여야 하고(팀 D1 쓰기 =
멘토 게이트), 그때까지 콘솔을 실측으로 채우는 수단이자 **export task 가 무엇을 하면 되는지의
실행 가능한 명세**다. `fixtures/slo_sample.sql` 은 Trino 가 없는 사람을 위한 폴백으로 남긴다
(`npm run seed`) — 모든 행에 `is_sample=1` 이 박혀 화면에 경고 배너가 뜬다.

### 초록 위장을 놓치지 않는다

`green_disguise_runs` = Airflow 는 success 인데 `expected=0` 인 run. **SLO 가 통과로
계산되는 날**이라 실패 목록에 안 잡힌다 — 그게 함정이다. 그래서 콘솔은 이걸
① KPI 로 세우고 ② 캘린더에서 초록이 아니라 **붉은 테두리**로 칠하고 ③ '살펴야 할 날'에
실패와 나란히 올린다. 실적재 결과 **6/30·7/7 두 건**이 잡혔다(7/7 은 설계 문서가 적어 둔 실사례).

## 콘솔이 드러내는 실측 하나

**SLO 마트를 가진 도메인은 culture 하나뿐이다** (ASAC-DBT 전체에서 `*_slo_daily` 검색, 2026-07-28).
`_ops_domain` 은 없는 도메인도 행으로 남겨 `1 / 6` 으로 보여준다 — 나머지 5개는 품질을 잴
수단 자체가 없다는 뜻이고, 그게 이 콘솔이 팀에 던지는 첫 질문이다.

## 인증 한계

공유 토큰(`OPS_TOKEN`)이라 **"누가 봤나"가 남지 않는다.** 공개 배포 시 Cloudflare Access 나
org OAuth 로 **교체 필수**(멘토 게이트). 토큰 미설정이면 503 으로 기능이 꺼진다 —
인증 없는 운영 화면이 실수로 열리는 것보다 낫다. 토큰은 sessionStorage 에만 두고
URL 에 싣지 않으며, 페이지는 `noindex` 다.

## 승격 경로

- `_ops_slo` 실적재 — culture SLO export task(내 도메인) → 나머지 도메인은 각자 (팀 합의)
- 인증 — 공유 토큰 → Cloudflare Access / org OAuth
- 알림 — 지금은 조회 전용. 정기런 실패 시 푸시는 Airflow 콜백(DeadlineAlert) 쪽이 맞다
