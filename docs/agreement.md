# ASK-Seoul-Serving 합의 문서 **v2**

> **이 문서가 정본이다.** 이슈 #1·#3·#7·#9·#20·#26·#36·#43 과 도메인 제품 이슈(#12~#18)에
> 흩어져 있던 논의·결정을 하나로 합쳤고, **#44 에서 전원 확인을 거쳤다.**
>
> 🔴 **이 문서를 고치려면 전체 합의가 필요하다.** 여기 적힌 것은 개인이 바꿀 수 없다 —
> 바꿀 일이 생기면 이슈를 열어 관계자 전원의 답을 받고, 그 결과를 이 문서에 옮긴다.
> 코드가 문서와 어긋나면 **문서가 맞다.**
>
> 범위 밖: **#2**(K-Skill 등록 준비도) · **#4**(seoul-urban-analytics 제품 API 계약)
>
> v1 2026-08-04 작성 · **v2 2026-08-04 전원 확인 반영**
> 확인: @yooseongjin527(게이트웨이) · @kang-gyeongmin(citydata·MCP) · @Exisign(콘솔)

## 목차

1. [무엇을 만들고 있나](#1-무엇을-만들고-있나)
2. [🔴 요청 로그 표 — 게이트웨이가 이름을 비킨다](#2--요청-로그-표--게이트웨이가-이름을-비킨다)
3. [수집 축 — 무엇을 남기고 무엇을 안 남기나](#3-수집-축--무엇을-남기고-무엇을-안-남기나)
4. [운영 기록 — 파이프라인 관측을 콘솔이 소비한다](#4-운영-기록--파이프라인-관측을-콘솔이-소비한다)
5. [소유 경계 — 누가 무엇을 고칠 수 있나](#5-소유-경계--누가-무엇을-고칠-수-있나)
6. [환경 규약](#6-환경-규약)
7. [사용량 제한 — 과금이 아니라 구조로](#7-사용량-제한--과금이-아니라-구조로)
8. [공개 배포 — 무엇이 남았나](#8-공개-배포--무엇이-남았나)
9. [MCP](#9-mcp)
10. [폐기된 안](#10-폐기된-안)
11. [남은 과제와 담당](#11-남은-과제와-담당)

---

## 1. 무엇을 만들고 있나

두 개의 Cloudflare Worker다. **다른 Worker · 다른 호스트**이고, 청중이 다르기 때문이다.

| | `marketplace/` (게이트웨이) | `ops-dashboard/` (콘솔) |
|---|---|---|
| 청중 | 외부 고객 · AI 에이전트 | 운영자 |
| 하는 일 | 키 발급 → 쿼터 → 카탈로그 게이트 → 조회 | 파이프라인·서빙 품질 관측 |
| 운영 호스트 | `ask-seoul.kr` | `ops.ask-seoul.kr` |
| 현재 | 로컬 검증 완료 | 로컬 전용 |

둘은 **같은 D1** 을 본다. 게이트웨이가 쓰는 표를 콘솔이 읽어야 하기 때문이다.
로컬에서는 `--persist-to` 로 같은 Miniflare 상태를 공유한다.

**공통 계약**(오류 형식·KST 경계·`key_hash`·`request_id`·값 최소화·증분 마이그레이션)의 정본은
[`marketplace/docs/decision/0001-shared-contracts.md`](../marketplace/docs/decision/0001-shared-contracts.md).

### 1-1. 공개 식별자는 `product_id` 다

게이트웨이가 같은 제품을 두 이름으로 불렀다 — `/api/…/gold_culture_activity_by_dong`(물리
테이블명)과 `/v1/products/culture_activity_by_dong`(계약 id). 테이블명은 도메인마다 접두사가
갈리고(`_catalog` 62종 실측: `gold_` 40 · `d1_` 22), 외부 소비자에게 `gold_`·`d1_` 는 뜻이 없다.

**공개 식별자는 `product_id` 로 통일한다.** 테이블명은 **별칭으로 유지**해 기존 호출을 안 깬다.
→ marketplace `decision/0003` · 구현 #45

| 규칙 | |
|---|---|
| 조회 SQL | 사용자 입력이 아니라 **카탈로그에서 해석한 물리명**으로 실행 |
| **관측** | 로그에 **해석된 물리명**(`table_name`)과 **`product_id`** 를 **둘 다** 남긴다(§3-1) |
| 비공개 제품 | 두 식별자 모두 **404** (403 은 존재를 알려준다) |

> 관측에 물리명이 필요한 이유 — 콘솔이 `table_name` 을 `_catalog.name` 과 **조인**한다.
> 별칭이 그대로 쌓이면 `product_id` 로 온 호출이 **"한 번도 안 불린 API"** 로 보인다.
> `product_id` 도 같이 남기는 이유는 §3-1 참조.

### 1-2. URL 은 소비자 축으로 가른다

→ marketplace `decision/0004` · 구현 #48

```
/api/v1/…    사람·일반 소비자 (카탈로그·미리보기·데이터·키)
/skill/v1/…  K-Skill seoul-urban-analytics 전용
/mcp         MCP 클라이언트 전용 (POST 하나, 무버전 — 프로토콜이 버전을 협상)
```

기술 계층이 아니라 **누가 쓰는가**로 가른다. 같은 데이터에 문이 여럿인 것은 중복이 아니라
**정책 차이**다. `/v1/*` 는 폐기했다(소비자 전수 0 실측).

---

## 2. 🔴 요청 로그 표 — 게이트웨이가 이름을 비킨다

### 2-1. 무엇이 문제였나

운영·개발 D1 에 게이트웨이 정본과 **다른 스키마**의 `_request_log` 가 이미 있었다.

| | 원격에 실제로 있는 것 | 게이트웨이 정본 |
|---|---|---|
| prod | `ts · path · query · token` (389행) | `ts · route · table_name · status · key_hash · filters · row_count · ms · request_id` |
| dev | `ts · path · query · token ·` **`request_id`** (578행, **지금도 유입 중**) | 〃 |

`migrations/0002` 가 `CREATE TABLE IF NOT EXISTS` 라 **다른 주체가 선점하면 조용히 넘어간다.**
그 상태로 배포하면 게이트웨이 INSERT 가 `ctx.waitUntil` 안에서 실패하고 **요청 로그가 전량
버려진다** — #23 에서 이미 겪은 형태다.

### 🔴 그리고 이미 사고가 났다

**dev 의 남의 표에 `request_id` 컬럼이 붙어 있다.** `0004_request_id.sql` 의
`ALTER TABLE _request_log ADD COLUMN request_id TEXT` 가 정본이 아닌 표에 얹혔다.

*"정본이 안 선 상태에서 ALTER 를 얹으면 어느 표에 붙는지가 배포 순서에 좌우된다"* 가
**가정이 아니라 일어난 일**이다. 이름을 공유하는 한 §3 의 신규 컬럼에도 같은 일이 반복된다.

### 2-2. ✅ 결정 — 개명한다 (#44 전원 확인)

**전제**: `transit` 워커가 기존 4컬럼 `_request_log` 를 **계속 쓴다**(@kang-gyeongmin 확정).
`citydata` 쪽 참조는 정리 완료. 쓰는 쪽이 안 멈추므로 **게이트웨이가 비킨다.**

| | 결정 |
|---|---|
| **새 이름** | **`_gateway_request_log`** |
| 기존 `_request_log` | **손대지 않는다** — transit 소유로 남긴다 |
| `_keys`·`_usage`·`_burst`·`_issuance_log` | 이름 안 바꾼다 (충돌한 하나만 비킴) |

**왜 `_api_request_log` 가 아닌가** — 그 표는 `/api` 만의 로그가 아니다. 로깅이 워커 하나의
깔때기라 **네 표면이 전부 들어온다**: `/api/v1`(`catalog`·`preview`·`data`·`me`·`keys`) ·
`/skill/v1`(`skill_*`) · **`/mcp`**(`route="mcp"`). §1-2 가 "소비자가 다르면 문을 가른다"로
셋을 나눴는데, 그 셋이 **공유하는** 표에 한 문의 이름을 붙이면 다음 사람이 *"그럼 `/skill`
로그는 어느 표냐"* 를 묻게 된다. `_gateway_request_log` 는 **이 워커의 자기 이름**이다
(`wrangler.toml` 의 `name = "ask-seoul-gateway"`).

### 2-3. 마이그레이션 — `0005` 하나로 완성형

**ALTER 물결을 아예 없앤다.** 새 표를 만드는 김에 §3-1 의 신규 축을 처음부터 넣는다.

```sql
-- marketplace/migrations/0005_gateway_request_log.sql
CREATE TABLE IF NOT EXISTS _gateway_request_log (
  -- 0002 + 0004 (기존 9종)
  ts TEXT NOT NULL, route TEXT NOT NULL, table_name TEXT, status INTEGER NOT NULL,
  key_hash TEXT, filters TEXT, row_count INTEGER, ms INTEGER, request_id TEXT,
  -- 공개 식별자 (§1-1)
  product_id TEXT,
  -- #9 행동 로그 8종 · 전부 nullable
  ua_class TEXT, agent_name TEXT, agent_mode TEXT, agent_verified INTEGER,
  country TEXT, asn TEXT, referer_host TEXT, page_path TEXT,
  -- #3 intent · ASAC-DAG#642 패턴 키 · 환경 축
  intent TEXT, pattern_id TEXT, publication_id TEXT, env TEXT
);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_ts      ON _gateway_request_log (ts);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_table   ON _gateway_request_log (table_name, ts);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_product ON _gateway_request_log (product_id, ts);
```

**컬럼 22종.** 규칙 셋:

1. **`0002` 는 고치지 않는다.** 마이그레이션 파일은 역사다. 이미 적용된 D1 은 장부가 재실행을
   막으니 고쳐도 효과가 없고, 새 D1 에서는 `IF NOT EXISTS` 라 남의 표가 있으면 아무 일도 안 한다.
2. **`DROP` 을 넣지 않는다.** 원격의 `_request_log` 는 남의 표다. `0005` 는 새 표만 만든다.
3. **데이터 이관 없음.** 로컬 개발 로그라 잃을 게 없고, `INSERT … SELECT` 는 컬럼이 없으면
   **준비 시점에 실패**해서 조건부로 쓸 수도 없다.

### 🔴 2-4. 표 신설과 코드 전환은 **같은 PR**

`DROP` 만 위험한 게 아니다. 게이트웨이 코드에 **30일 sweep** 이 있다:

```js
await env.DB.prepare("DELETE FROM _request_log WHERE ts < ?").bind(cutoff).run();
```

**표만 새로 생기고 코드가 옛 이름을 가리킨 채 원격 배포가 한 번이라도 되면, 이 DELETE 가
transit 의 30일 지난 행을 지운다.** 지금까지 게이트웨이가 원격 배포된 적이 없어 안 일어났을 뿐이다.

> **불변식: 표 신설과 코드 전환은 같은 PR. 원격 apply 는 그 배포 이전.**

### 2-5. 원격 적용 절차

> ⚠️ **원격 D1 쓰기다.** §8-3 의 조율을 먼저 거친다.

```bash
# 0단계 ⚠️ 필수 — **배포 전 검사.** 표가 있는지만이 아니라 모양(컬럼)까지 본다.
#   `모양 다름` 이면 여기서 멈춘다 — 되돌리는 것보다 멈추는 게 싸다.
#   기대 모양은 migrations/*.sql 을 인메모리 sqlite 에 실제로 적용해 뽑는다(드리프트 없음).
npm run preflight -- <D1> [--env production]        # 0=진행 1=중단 2=검사실패
#   중단되면 → 소유 확인(§5) → 사람이 결정 → #52 에 적고 → --ack "<결정과 근거>" 로 재실행.
#   --ack 는 판정을 바꾸지 않는다. 사유를 함께 찍고 종료 코드만 바꾼다.

# 1단계 ⚠️ 필수 — 장부 백필. 두 D1 모두 d1_migrations 가 없어서,
#   이걸 건너뛰면 apply 가 0001 부터 재실행하고 0004(조건 없는 ALTER)가
#   **남의 표에 request_id 를 또 붙인다.** prod 에서 그 사고가 재연된다.
#   백필은 이름이 아니라 route 컬럼 유무로 우리 표를 판정한다 (PR #50).
npx wrangler d1 execute <D1> --remote [--env production] \
  --file=scripts/backfill-migrations-ledger.sql

# 2단계 — 안 된 파일만 실행된다
npx wrangler d1 migrations apply <D1> --remote [--env production]

# 3단계 — 우리 표가 정본 스키마인가 (컬럼 수가 아니라 **필수 이름 집합**으로 본다.
#   개수 하드코딩은 컬럼이 하나 늘면 바로 STOP 을 뱉는다)
npx wrangler d1 execute <D1> --remote [--env production] --command \
"SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_table_info('_gateway_request_log')
   WHERE name IN ('route','table_name','status','key_hash','filters','row_count','ms',
                  'request_id','product_id','env','intent')) = 11
 THEN 'OK' ELSE 'STOP' END verdict"

# 4단계 — 남의 표를 안 건드렸는가. **행 수만 보면 안 된다** —
#   ALTER 로 컬럼이 붙는 사고는 행 수가 그대로다. 컬럼 수를 같이 본다.
#   기대: prod cols=4 · dev cols=5
npx wrangler d1 execute <D1> --remote [--env production] --command \
"SELECT (SELECT COUNT(*) FROM _request_log) rows,
        (SELECT COUNT(*) FROM pragma_table_info('_request_log')) cols"
```

**dev D1 에 돌릴 때는 `--env production` 을 뺀다.**

3·4단계는 `npm run preflight` 가 같은 것을 보므로, 적용 뒤 한 번 더 돌려 확인해도 된다.

`scripts/check-request-log-schema.sql` 은 역할이 바뀐다 — "이름 충돌 검사"가 아니라
**"남의 표를 안 건드렸는지"** 확인용이다.

---

## 3. 수집 축 — 무엇을 남기고 무엇을 안 남기나

### 대원칙: **값이 아니라 축만**

`_gateway_request_log` 에는 **요청에 담긴 값과 응답 본문을 남기지 않는다.** 필터는 컬럼명만,
식별자는 `key_hash` 만. 원문 UA·전체 Referer·쿼리 값·이메일은 금지다.

> 이 원칙 때문에 §2 의 기존 4컬럼 표(`query`·`token`)를 **인수하지 않는다.**

### 3-1. 컬럼 22종 (`0005` 한 번에)

전부 **nullable**, **추가만**(삭제·개명 금지 — ASK-Seoul#78 `D-3`).

| 컬럼 | 무엇 | 근거 |
|---|---|---|
| `ts`·`route`·`table_name`·`status`·`key_hash`·`filters`·`row_count`·`ms`·`request_id` | 기존 9종 | 0002 · 0004 |
| **`product_id`** | 공개 식별자 (§1-1) | #44 |
| `ua_class` | browser / ai_agent / ai_crawler / bot / cli / unknown | #9 ③ |
| `agent_name` · `agent_mode` | 에이전트 이름(코드 상수) · crawler vs on_demand | #9 ③ |
| `agent_verified` | **NULL 로 시작** — 검증 수단 없음 ≠ 검증 실패 | #9 ④ · #78 `F-3` |
| `country` · `asn` | 남용 판정 축 (원문 IP 대신) | #9 ① |
| `referer_host` | 호스트만. 전체 Referer 아님 | #9 |
| `page_path` | 핵심 페이지 + 기계 문서 3종만 | #9 ② |
| `intent` | `X-ASK-Intent` 슬러그. **질문 원문 아님** | #3 |
| `pattern_id` · `publication_id` | 패턴 실행 API 로깅 키 | ASAC-DAG#642 |
| `env` | `local` / `prod` — 지표가 조용히 섞이는 것을 막는다 | §6-2 |

**`product_id` 를 넣는 이유** — §1-1 로 공개 식별자가 `product_id` 가 됐는데 로그는
`table_name`(물리명)만 남긴다. intent 어휘로 쓰는 `d1_usage_patterns` 의 키도 `product_id` 다.
그리고 **D1 물리 표명 통일이 합의된 후속 작업**이라, 그날 과거 로그의 `table_name` 은
아무것도 못 가리킨다. 완성형으로 만드는 지금이 넣을 유일한 때다.

> ⚠️ **배선 전까지 `env`·`intent`·`pattern_id`·#9 8종은 전량 NULL 이다.**
> 콘솔은 이걸 **`0` 으로 그리지 않는다** — "재지 않은 것"과 "재서 0"을 섞으면 관측 공백이
> "이상 없음"으로 위장된다(#78 `F-3`, ASAC-DAG#619 에서 겪은 자리).

### 3-2. IP 축 — **`_gateway_request_log` 에는 (A) 미저장**

`ip_hash` **컬럼 자체를 만들지 않는다.** "안 모은 건 나중에 모을 수 있지만, 모은 건 되돌릴 수
없다"가 판단 기준이다. 남용 방어는 버스트 제한·발급 rate limit 이 맡고 있고, IP 이력의 용도는
사후 분석뿐인데 그 수요가 아직 실증 전이다.

> ⚠️ **`_issuance_log.ip` 는 별개다** — §3-3. (A) 를 "어디에도 IP 를 안 남긴다"로 읽으면
> `/legal` 안내와 어긋난다. 이 절은 **요청 로그 한정**이다.

> 논의 경과: 콘솔 쪽에서 (B) 일 회전 솔트 해시를 권고했으나(같은 ASN 안의 서로 다른 출처를
> 못 가른다), 게이트웨이 오너 결정은 (A) 이고 그것이 최종이다. 실증되면 ALTER 한 줄로 승격.

### 3-3. 발급 IP — 일 회전 솔트 해시 + 24h sweep

발급 rate limit(IP당 시간당 5회)은 IP 축이 필요해 완전 미저장이 불가능하다. `_issuance_log` 는
원문을 **일 회전 솔트 SHA-256** 으로 바꾸고 24시간 지난 행을 sweep 한다. §3-2 와 합쳐
**원문 IP 가 어디에도 남지 않는다.**

`ISSUANCE_SALT` 미설정 시 발급은 **503 으로 닫힌다**(무염 해시 방지 — 의도된 fail-closed).

> 솔트 회전 경계에서 카운터가 리셋돼 이론상 상한 2배 통과 — 시간당 5회라 실해 없음. 인지하고 채택.

### 3-4. 페이지 관측 범위

`/` · `/docs` · `/legal` + **`/llms.txt` · `/openapi.json` · `/column-docs.json`**.

뒤 3개가 핵심이다 — AI 여정의 **시작점**이 기계 문서 접근이고, 이게 관측에 없으면 `cli` 얼굴로
오는 에이전트를 여정으로 이을 수 없다. `/status` 는 제외(스스로 API 를 불러 이미 로그에 잡힘).

### 3-5. 보관

**요청 로그 30일.** 샘플링은 보류 — 넣는 순간 "전체의 몇 %인가"를 못 세고 비율 지표가 먼저
죽는다. 페이지 행이 전체의 절반을 넘으면 **샘플링이 아니라 `route='page'` 만 짧은 보관(7일)** 으로.

### 3-6. 질문 원문은 수집하지 않는다 — intent 슬러그만

원문을 로그에 넣으면 같은 행의 `key_hash`(↔이메일 1:1) 때문에 **"이메일에 연결된 개인 질의
이력"** 이 생긴다. 원문엔 PII 도 섞인다. 슬러그면 `filters` 와 같은 "축만" 철학이라 무손상이다.

**수집 축은 하나(`intent` 컬럼), 전달 경로는 둘:**

| 클라이언트 | 전달 |
|---|---|
| 헤더 제어 가능 (K-Skill 등) | `X-ASK-Intent: <슬러그>` |
| **MCP** | `query_product(intent: "<슬러그>")` **선택 인자** → 서버가 로그에 옮겨 실음 |

> MCP 에서 HTTP 헤더는 클라이언트 설정의 **고정값**이라 LLM 이 질의마다 바꿔 실을 수 없다
> (@kang-gyeongmin). 그래서 경로를 둘로 가르되 **컬럼과 화면은 하나**다.

**어휘는 `d1_usage_patterns.pattern_id` 재사용** — 실측 **305종**. 새로 만들지 않는다.
패턴 밖 질의는 `other`.

얻는 것: **`intent × row_count=0`** = "이 의도로 물었는데 빈 응답" — 커버리지 갭의 실측 신호.
콘솔은 **상위 N + `other` 비중**으로 그리고, 갭(`row_count=0`)만 전량 나열한다.

---

## 4. 운영 기록 — 파이프라인 관측을 콘솔이 소비한다

### 4-1. 정본은 ASAC-DAG, 콘솔은 읽기 전용 소비자

조회 DB 4종(`_ops_run_event`·`_ops_daily_metric`·`_ops_pipeline_state`·
`_ops_pipeline_expectation`)의 스키마 정본은 `common/ops/d1_ops.py`(`ops-d1/v1`)다.
쓰는 쪽은 ASAC-DAG 의 관문(C-2)과 점검 적재기(C-3)뿐이다.

콘솔은 **읽기만** 한다. 집계를 대신 만들지 않는다 — 만드는 순간 정본이 둘이 되고 값이 갈린다.

### 4-2. 성공률 하나로 뭉개지 않는다 (#78 `D-7` 3분류)

성공률 100% 인 7일 중 4일이 재발이던 실측이 근거다.

| | 운영 D1 실측 (2026-08-04) |
|---|---:|
| 정기 실행 통과 | 성공률 100% (14,301/14,363) |
| **수동 복구로 살림** | **210** |
| **빈 실행 = 초록 위장** | **3** |
| 행수 미측정 | **9,670** (측정 4,839) |

### 4-3. 모른다 ≠ 0 (`F-3`)

측정 못 한 값은 `NULL` 로 두고 화면도 "미확인"으로 구분한다. 0 으로 그리면 관측 공백이
"이상 없음"으로 위장된다.

- `layer` 는 **nullable 이 설계**다. 관문 이전 기록엔 단계 정보가 없고, 없는 것을 추측해 채우면
  거짓말이 된다. 단계별 합계에 넣지 않고 "단계 미기록 n건"으로 따로 센다(운영 **1,364건**).
- `observation_state` = `complete` / `partial` / **`unverified`**.
  **`unverified` 는 "정상"이 아니라 "아직 점검이 안 지난 구간"** 이다. 초록으로 그리지 않는다.

### 4-4. 감시 3분류 — '감시 제외'와 '미등록'은 뜻이 정반대다

| 상태 | 뜻 | 판정 | 운영 실측 |
|---|---|---|---:|
| `watched` | 기대치 등록 + 감시 대상 | 침묵 한도로 판정 | 8 |
| `unmonitored` | `monitored=0` | **감시 제외** — 수동 전용. 안 도는 게 정상 | 1 |
| `unregistered` | 기대치 행 자체가 없음 | **미등록** — 판정 근거 없음 ≠ "이상 없음" | **37** |

기대 주기가 commerce 9건만 등록돼 **DAG 37개가 판정 없이 돈다.** 경보로는 `watched` 의 멈춤
후보만 센다 — 미등록을 경보로 세면 등록 지연이 장애로 둔갑한다.

### 4-5. 신선도 — 조회 DB 는 실시간이 아니다

적재 DAG(`common_ops_d1_load`)는 **3시간 주기**다. 화면은 "마지막 반영 시각 + 경과"를 같이
쓰고, 주기의 1.5배를 넘기면 경고한다. 안 쓰면 실시간으로 읽혀 **없는 장애를 쫓는다.**

### 4-6. 로그 원문 포인터

`log_bundle_key` 는 그 run 의 로그 tar.gz(R2) 위치. 번들이 하루 1회 뒤늦게 올라오므로
**당일 실행은 NULL 이 정상**이다. 콘솔은 경로만 보여주고 **링크로 만들지 않는다** — R2
자격증명이 없어 눌러도 안 열리는데, 그건 안 보여주는 것보다 나쁘다.

> ⚠️ 실측: 운영 **17,158건 중 0건**. 전 구간이 비어 있다 → §11 C-1

---

## 5. 소유 경계 — 누가 무엇을 고칠 수 있나

**남의 표를 만들거나 지우지 않는다.**

| 표 | 정본 | 게이트웨이 | 콘솔 |
|---|---|---|---|
| `_keys` · `_usage` · `_burst` · `_issuance_log` | **게이트웨이** | 전권 | 정해진 키 조치만 |
| **`_gateway_request_log`** | **게이트웨이** | 전권 | 읽기 전용 |
| `_request_log` (4컬럼) | **transit 워커** | ❌ 안 건드림 | ❌ 안 건드림 |
| `_ops_slo` · `_ops_domain` | **콘솔** | — | 전권 |
| `_ops_run_event` · `_ops_daily_metric` · `_ops_pipeline_state` · `_ops_pipeline_expectation` | **ASAC-DAG** | — | 읽기 전용 |
| `_publication_ledger` · `_publication_log` | **ASAC-DAG** | — | 읽기 전용 |
| `_catalog` · 제품 표 `d1_*` · `d1_usage_patterns` | 도메인 export | 읽기 전용 | 읽기 전용 |

### 5-1. 마이그레이션은 증분 — DROP 금지

**항목 추가는 허용, 삭제·개명은 금지**(#78 `D-3`·`D-6`). 변경은 새 ALTER 파일로만.
파이프라인 정본(`d1_ops.py`)은 `DROP TABLE` 을 아예 만들지 않게 코드 수준에서 막혀 있다.

### 5-2. 적용 여부의 정본은 D1 안의 장부

`wrangler d1 migrations apply` 가 안 된 파일만 실행한다. **새 파일은 `migrations/` 에 추가하면
끝이고 시드 체인에 나열하지 않는다** — 사람이 체인 갱신을 기억하던 시절 0004 누락으로 로컬
요청 로그가 몇 주간 전량 유실된 실사고가 있었다(#23).

장부 표는 **소유자별로 가른다** — 게이트웨이 `d1_migrations`, 콘솔
`d1_migrations_ops_dashboard`. 같은 D1 을 공유하므로 기본 이름을 쓰면 파일명이 겹치는 순간
한쪽이 "이미 적용됨"으로 조용히 건너뛴다.

> ⚠️ **두 원격 D1 모두 장부가 아직 없다.** §2-5 의 0단계(백필)가 그래서 필수다.

### 5-3. 로컬 미러의 유일한 예외

콘솔 `migrations/0002` 는 조회 DB 4종의 **로컬 미러**다. 조건 셋: ① `CREATE TABLE IF NOT
EXISTS` 만 ② DROP·ALTER 금지 ③ 미러는 소유 주장이 아니다 — 정본이 바뀌면 따라간다.

---

## 6. 환경 규약

### 6-1. 한 파일 안에서 갈린다

`wrangler.toml` 의 **기본 = 로컬**, `[env.production]` = 배포. `--env production` 을
**명시해야만** 선택되므로 플래그가 없으면 언제나 로컬이다.

⚠️ **env 섹션은 상속되지 않는다.** `assets`·`run_worker_first`·`vars`·`d1_databases` 를 두 곳에
같이 쓴다.

| | 로컬/개발 | 운영 |
|---|---|---|
| D1 | `ask-seoul-dev-d1` (`9db0e851-…`) | `ask-seoul-prod-d1` (`59a8409e-…`) |
| 게이트웨이 | `:8787` | `ask-seoul.kr` |
| 콘솔 | `:8788` | `ops.ask-seoul.kr` |

**비밀값은 로컬은 파일(`.dev.vars`), 배포는 파일 밖(`wrangler secret put`).** 환경별 비밀
파일을 만들지 않는다 — `.dev.vars` 의 `dev` 가 이미 "개발 환경"을 뜻한다.

**환경을 아는 값은 `[vars]` 에 둔다:**

```toml
# marketplace/wrangler.toml
[vars]
ASK_ENV = "local"                 # 기본 = 로컬

[env.production.vars]
ASK_ENV = "prod"                  # 상속 안 되므로 두 곳에
```

> ⚠️ **base env 는 로컬 전용이다 — 배포 금지.** `[vars]` 기본이 `local` 인데 base env 로
> 배포하면 dev D1 을 쓰면서 `ASK_ENV="local"` 로 기록돼 값이 실제 배포면을 못 덮는다.
> 값집합은 `local`·`prod` 둘이고, 프리뷰가 생기면 그때 `dev` 를 예약한다.
> (#78 `Z-7` — 키 이름이 아니라 **값**이 환경을 정한다)

콘솔도 같은 규약이다(`ENV_LABEL`·`ENV_D1`·`ENV_SCOPE`).

### 6-2. 🔴 환경이 섞인다 — 걸러 읽는다

실측(2026-08-04): 운영 D1 에 `environment='dev'` **17건**(citydata), 개발 D1 에 `'prod'`
**63건**(citydata 46 · traffic 7 · weather 6 · transit 4). **NULL 은 없다** — 축이 빠진 게
아니라 **값이 반대로 들어간다**. 판정 결함이 고쳐져도 **과거 행은 남는다.**
→ ASAC-DAG#654 · #677

- 콘솔은 `ENV_SCOPE` 로 **운영 화면만** 좁힌다. 개발 화면에서까지 좁히면 "섞였다"는 사실
  자체가 안 보이는데, 그건 콘솔이 드러내야 할 관측이다.
- '환경' 카드에는 **언제나 전량**을 보여준다.
- 요청 로그에는 §3-1 의 `env` 컬럼으로 같은 함정을 미리 막는다.

**⚠️ 집계표(`_ops_daily_metric`)는 못 거른다** — `environment` 컬럼이 없다. 그래서 KPI 와
도메인×단계 매트릭스는 환경이 섞인 값이고, 화면이 그 사실을 직접 밝힌다. → §11 C-2

---

## 7. 사용량 제한 — 과금이 아니라 구조로

### 7-1. ✅ 과금 결정은 지금 하지 않는다

ASAC-DAG#476 ③(Workers Paid $5/월 전환)이 걱정한 것은 *"rate limit 구현 방식이 무료 플랜에서
되는지"* 였다. **이미 D1 로 구현돼 동작한다** — Durable Objects·KV 가 필요 없다.

**그래서 과금 게이트를 구체적으로 만들지 않는다.** 무료 플랜으로 간다. 필요한 것은
**사용자·API 키별로 제한할 수 있는 구조**이고, 그건 아래처럼 이미 서 있다.

### 7-2. 이미 있는 구조

| 층 | 저장소 | 무엇 |
|---|---|---|
| **키별 일일 한도** | `_keys.daily_quota` | 기본 1000. **키마다 다르게 줄 수 있다** — 콘솔에서 변경 |
| **일별 사용량** | `_usage (key_hash, day, count)` | KST 일 경계. `GET /api/v1/me` 로 본인 확인 |
| **분당 버스트** | `_burst (bucket, window_start, count)` | `k:<key_hash>`(인증) / `ip:<addr>`(익명) |
| **발급 제한** | `_issuance_log` | IP당 시간당 5회 (§3-3) |
| **상태** | `_keys.status` | `active` / `revoked` — 콘솔에서 차단·해제 |

**알림 규약:**

- 429 응답에 **`Retry-After`**
- 모든 응답에 **`X-RateLimit-Limit` · `X-RateLimit-Remaining` · `X-RateLimit-Reset`**(KST 자정 epoch)
  — 한도를 응답으로만 알리면 클라이언트가 429 를 맞고 나서야 안다. 헤더면 SDK 층에서 자동 감속한다.
- **버스트를 쿼터보다 먼저** 본다 — 오류로 끝날 요청도 서버를 미는 건 같다.
- **400/404/409 는 무과금** — 유효한 서빙 직전에만 센다.

### 7-3. 나중에 결정할 것 (지금 아님)

| | 신호 |
|---|---|
| Workers Paid 전환 | 무료 플랜 한도를 **실제로** 칠 때 |
| 유료 티어(키별 차등 과금) | 외부 소비자가 기본 쿼터를 반복해서 소진할 때 |
| 조직 단위 쿼터 | 한 조직이 키를 여러 개 발급받아 우회하는 게 실측될 때 |

**지금 만들지 않는다.** 구조가 키 단위로 서 있으므로 티어가 생기면 `daily_quota` 값과
`_keys` 컬럼 하나로 확장된다 — 되돌릴 수 없는 선택을 미리 하지 않는다.

---

## 8. 공개 배포 — 무엇이 남았나

### 🔴 8-1. "배포 결정(agreement §8)" 은 **잘못된 표기다**

우리 문서 여러 곳이 `wrangler deploy 금지 — 배포 결정(agreement §8)` 라고 적었는데, 확인해 보니
사실이 다르다.

- **ASAC-DAG#476 은 멘토 게이트가 아니라 팀 투표다.** 발행자 @yooseongjin527, 4건에 A/B/C 를 고르는 형식.
- **① 구조(게이트웨이 Worker)는 만장일치 A 로 통과했다** — @codingpoppy94 · @kang-gyeongmin ·
  @masondev1024. 막고 있는 것이 아니다.
- ② URL 형태는 만장일치 **B(커스텀 도메인)**.
- **"멘토"는 ③ 과금에 딱 한 번 나온다** — *"과금은 팀·멘토 판단 영역"*. 즉 팀 관행상
  **비용·인프라 승인권자**를 뜻하고, **실명은 어디에도 없다.**

**§7-1 로 과금 결정 자체를 미뤘으므로, "멘토 게이트"라고 부를 것이 지금은 없다.**

### 8-2. 실제로 남은 결정

| | 상태 |
|---|---|
| **A. 어느 D1 에 쓰는가** | ✅ **팀 D1 1개 유지** (A-3 바인딩 분리 철회). ⚠️ 대가: 통합 검증 기간 동안 **외부 이용자 이메일·키가 팀 창고에 쌓인다** |
| **B. 콘솔 공개 형태** | ✅ **전체를 Cloudflare Access 뒤로** (읽기 포함). `decision/0002`·`0004` 개정이 코드보다 먼저 |
| **C. 공개 URL** | ✅ 경로 문법 확정(§1-2) · **호스트 확정(2026-08-04)** — zone `ask-seoul.kr` Active. 4종: `ask-seoul.kr`(서비스 운영) · `dev.`(서비스 개발) · `ops.`(콘솔 운영) · `dev-ops.`(콘솔 개발). dev 2종 배포 시행. ⚠️ citydata 워커 정리는 그대로 남았다(아래) |
| **D. 문의 창구** | ❌ 미결 — 팀 공용 메일 별칭 하나가 최소선 |

**C 에 함께 정리할 것**: citydata 공개 워커가 **같은 데이터에 URL 2개**로 떠 있고, 그 워커는
파이프라인 D1 을 보고 있지 않다(카탈로그가 구 13종에서 멈춤). 새 창구를 여는 김에 정리하지
않으면 창구가 3개가 된다.

### 🔴 8-3. 원격 D1 에 표를 만드는 것 — 조율이 필요하다

**prod D1(`ask-seoul-prod-d1`)에는 우리 표가 하나도 없다.** 62개 제품이 사는, 파이프라인이
발행하는 DB다. `migrations apply` 는 거기에 `_keys`·`_usage`·`_burst`·`_issuance_log`·
`_gateway_request_log` 를 **처음 만드는 일**이다.

@masondev1024 이 #476 에서 짚은 것이 이 지점이다:

> **D1 Time Travel 은 테이블 단위가 아니라 DB 전체를 특정 시점으로 덮어쓴다.** 제품 publish 를
> 되돌리려고 Time Travel 을 하면 — 폐기한 키가 되살아나고, 복구 시점 이후 발급한 키가 사라지고,
> 쿼터·버스트 카운터가 과거로 돌아가고, 요청 로그가 유실된다.

**승인 주체가 정해져 있지 않다.** "멘토"는 과금 얘기라 여기 해당 없다. 필요한 것은
**그 DB 를 실제로 쓰는 파이프라인 쪽(ASAC-DAG)과의 조율**이다.

→ **§11 P-0**: 누가 승인하는지를 먼저 정한다. 정해지지 않은 것을 정해진 것처럼 문서에 남기면
나중에 아무도 못 누른다.

### 8-4. 배포 전 기술 작업

| 항목 | 상태 |
|---|---|
| `ISSUANCE_SALT` + 미설정 시 거부 | ✅ #19 |
| `/legal` 발급 IP 무만료 해소 | ✅ 24h sweep |
| `npm test` (partial 드리프트) | ✅ #42 — `pass 34 / fail 0` |
| **§2 표 개명 + 코드 전환** | 🔴 착수 대기 |
| **§2-5 원격 적용** | 🔴 §8-3 조율 후 |
| `/legal` 이메일 평문 저장·소유 확인 부재 | ❌ 처리 또는 명시적 유예 결정 |
| `culture_serving_export` unpause | ❌ 결정 C 이후 |
| **CI 신설** | ⬜ **지금 가능** — 막는 것이 없어졌다 |

---

## 9. MCP

AI 가 데이터를 **발견·이해·조회**하게 하는 **읽기 전용** MCP 서버.

| | |
|---|---|
| 전송 | **Streamable HTTP `POST /mcp` (stateless)**. stdio 는 로컬 개발·Inspector 용 |
| 위치 | 게이트웨이 Worker 안. 내부 HTTP 재호출이 아니라 **shared 함수·D1 바인딩 재사용** |
| 인증 | **BYOK** — 사용자가 자기 키를 `Authorization: Bearer ask_…` 로 forward |
| P0 툴 | `list_products` · `describe_product` · `preview_product` · `query_product` · `check_quota` |
| P1 | `run_pattern` (서버 실행 계약 확정 후) |
| 스코프 | ✅ **전체 62종 확정.** `verified_bundle` 여부를 `list_products` 가 구분해 노출 (PR #32) |

**정합성**: 제품 data · `_catalog` · support metadata 의 `publication_id` 가 **모두 같을 때만**
응답하고, 하나라도 어긋나면 **503 fail-closed**. MCP 는 503 을 "게시 정합성 일시 불일치 →
잠시 후 재시도"로 처리한다(빈손·실패가 아니다).

**데이터 정책 = `/api/v1` 과 동일 (#88)**: `query_product`·`preview_product` 는 게이트웨이
`handleData` 를 재사용하므로 **재배포 권리 검사를 자동 상속**한다 — 원천이 재배포를 허용하지
않은 제품은 `/api` 와 똑같이 **503(`product_not_ready`) 으로 닫힌다.** 준비도·`public_projection`·
품질 게이트는 `/skill/v1` 전용이며 MCP·`/api` 에는 적용되지 않는다. 권리 503 은 게시 정합성 503 과
달리 **재시도해도 동일**하므로, MCP 는 이를 "권리 사유로 제공 불가"로 구분해 안내한다(재시도 문구 아님).

**커서**는 product·query·publication 에 결합된다 — 다른 publication 의 커서는 409 로 거절.

**키·로그 위생**: 로그·툴 응답·에러에 Bearer·email·원본 필터 값을 넣지 않는다.
`check_quota` 의 이메일 노출은 제거 완료(PR #32).

**요청 로그**: MCP 호출도 §2 의 같은 표에 쌓인다(`route = "mcp"`). intent 는 헤더가 아니라
`query_product` 인자로 받는다(§3-6).

**열린 항목**: 호스트 미정(§8-2 C)이라 **URI 하드코딩 불가** · 필터 값 discovery 는 MCP 에서는
`preview_product` 로 되지만 **`/v1` 일반 표면에는 여전히 없다**.

---

## 10. 폐기된 안

같은 주제를 두 번 논의하지 않기 위해, **왜 안 하기로 했는지**를 남긴다. **지우지 않는다.**

| 안 | 왜 폐기 |
|---|---|
| **Trino 직결 복사** (`load_slo.py`) | 조회 DB 4종이 정본이 된 이상 중간 복사 계층이 불필요. `http://trino:8080` 은 Docker 내부 주소라 Worker 가 닿지도 못한다 |
| **기존 `_request_log` 를 DROP 하고 인수** | transit 워커가 계속 쓴다(#44 확정). 쓰는 쪽이 안 멈추면 DROP 도 못 한다 → 게이트웨이가 비킨다(§2) |
| **`_api_request_log`** (이름 후보) | 그 표는 네 문(`/api`·`/v1`·`/skill`·`/mcp`)이 공유한다. 한 문 이름을 붙이면 나머지 셋이 설명 안 된다 |
| **`_gw_request_log`** (이름 후보) | `gw` 가 바깥에서 안 읽힌다 |
| **`0005` 를 ALTER 물결로** | 새 표를 만드는 김에 완성형 CREATE 가 낫다. ALTER 가 남의 표에 얹히는 사고를 원천 차단 |
| **D1 바인딩 분리 (A-3)** | 설계가 단일 D1 이고 정식 공개 때 prod 이관 예정. 대가는 §8-2 A 에 기록 |
| **콘솔 데모 전용 인스턴스 (B-2)** | 콘솔의 존재 이유가 실측 관측이라 합성 데모는 가치가 반감 |
| **`ip_hash` 일 회전 해시 (B)** | 오너 결정은 (A) 미저장. 실증 후 승격 여지는 남김 |
| **`/24` prefix IP 집계** | IPv6 에서 의미가 흐려지고 공유 NAT 오탐이 크다 |
| **AI 분류 목록 D1 참조표** | 매 요청 조회 비용이 갱신 빈도(월 단위)에 비해 과함. 코드 상수가 정본 |
| **페이지 로그 샘플링** | 넣는 순간 비율 지표가 죽는다. route 별 보관 분리가 먼저 |
| **질문 원문 수집** | `key_hash`↔이메일 1:1 때문에 개인 질의 이력이 생긴다. intent 슬러그로 대체 |
| **intent 어휘를 새로 만들기** | `d1_usage_patterns.pattern_id` 305종이 이미 게시 계약에 있다 |
| **`_ops_slo` 를 4종에서 채우기** | 화면이 이미 4종을 직접 읽으므로 중간 표를 채우면 **정본이 둘**이 된다 |
| **콘솔 `0001` DROP+CREATE 리셋** | "잃을 상태가 없다"는 전제가 팀 D1 실존으로 깨졌다 |
| **과금 게이트를 지금 구체화** | rate limit 이 무료 플랜 D1 로 이미 동작한다(§7). 되돌릴 수 없는 선택을 미리 하지 않는다 |
| **`/v1/*` 표면** | 소비자 전수 0 실측. `/api/v1` 로 흡수 |

---

## 11. 남은 과제와 담당

### 🔴 선행

| # | 항목 | 담당 |
|---|---|---|
| **P-0** | **§8-3 승인 주체를 정한다** — 원격 prod D1 에 표를 처음 만드는 일을 누가 승인하나 | 팀 결정 |
| **P-1** | **PR #50 머지** — 장부 백필이 남의 표를 우리 표로 오인하던 것. §2-5 0단계의 선행 | @yooseongjin527 |
| **P-2** | **§2 표 개명 + 코드 전환** — `0005` 신설 · 게이트웨이 전환 · 콘솔 27곳. **같은 PR**(§2-4) | @yooseongjin527 · @Exisign |
| **P-3** | **§2-5 원격 적용** — P-0·P-1·P-2 전부 이후 | @yooseongjin527 |

### 콘솔 — 읽기 전용, 소유 경계 무영향

| # | 항목 |
|---|---|
| **A-1** | **발행 점검 화면** — `_publication_ledger`(운영 4,587행)가 통째로 미소비. **실패 60 · 열화 439 · 행수 불일치 63건**(traffic 집중) |
| **B-1** | D-7 지표 4개 — 소요 289시간 · 적재 6,162만행 · API 2,033 · 열화 116 |
| **B-2** | `_catalog` 서빙 상태(degraded 2건) · `mcp_projection`(8건) · **`public_gold` 계약 JSON(5종)** 노출 |
| **B-3** | 실행 ↔ 발행 ↔ 제품 연결 고리 (`product_id`·`publication_id`) |
| **C** | `intent × row_count=0` 카드 — `0005` 반영 후 |

→ 상세는 **#38**

### ⚪ 원천이 비어 있다 — 확인 요청

**전부 파이프라인 쪽에 올려 뒀다** — C-1·C-2·C-3 은 [ASAC-DAG#677](https://github.com/ASAC-DE-bigkk/ASAC-DAG/issues/677),
환경 섞임은 [ASAC-DAG#654](https://github.com/ASAC-DE-bigkk/ASAC-DAG/issues/654).

| # | 무엇 | 실측 | 담당 |
|---|---|---|---|
| **C-1** | `log_bundle_key` | 운영 **17,158건 중 0건** — 전 구간 | ASAC-DAG |
| **C-2** | `_ops_daily_metric.environment` | **컬럼 자체가 없음** → 집계 층에서 `Z-7` 을 못 지킴 | ASAC-DAG |
| **C-3** | `_ops_daily_metric` 개발 D1 | 운영 63행인데 **개발 0행** | ASAC-DAG |
| **C-4** | 환경이 반대로 들어감 | 운영에 `dev` 17 · 개발에 `prod` 63. **NULL 은 없음** | 각 도메인 오너 |
| **C-5** | `_catalog.freshness` | **전 행 빈 값** | 도메인 export |
| **C-6** | `_catalog.public_gold` | **5종에 계약 JSON**(traffic 3 · weather 2) · 57종 NULL. 값 규약 정본 확인 필요 | @masondev1024 |
| **C-7** | `_ops_pipeline_expectation` | **9행 / DAG 46개**(commerce 만) — transit 9,764 · citydata 3,825 · traffic 1,849 · weather 1,636 실행이 판정 없이 돔 | 각 도메인 오너 |
| **C-8** | `layer`·행수 미상 | `layer` 미상 citydata **1,350** · 행수 미상 transit **8,318** · weather 1,538 | 각 도메인 오너 |

### 배포 (§8)

**P-0** 승인 주체 · 결정 **C**(호스트)·**D**(문의 창구) · `/legal` 이메일 항목 ·
`culture_serving_export` unpause · **CI 신설(지금 가능)**.

### 제품 계약 (#12~#18, 종료)

| 도메인 | 제품 | 담당 |
|---|---|---|
| Weather | `weather_place_forecast_change_daily` | @masondev1024 |
| Traffic | `traffic_incident_x_weather_current_hourly` | @masondev1024 |
| Citydata | `citydata_purchasing_power_daily` | @kang-gyeongmin |
| Commerce | `commerce_flow_monthly` | @Exisign |
| Culture | `culture_activity_by_dong` | @yooseongjin527 |
| Transit | `transit_parking_full_risk` | @codingpoppy94 |

---

## 갱신 규칙

- 🔴 **이 문서를 고치려면 전체 합의가 필요하다.** 개인이 바꿀 수 없다.
- 바꿀 일이 생기면 **이슈를 열어 관계자 전원의 답을 받고**, 그 결과를 이 문서에 옮긴다.
- 프로젝트별 상세 근거는 각 `docs/decision/` 에 있고, 이 문서는 **두 프로젝트에 걸친 합의**만 담는다.
- **폐기된 안은 §10 으로 옮긴다 — 지우지 않는다.** 지우면 같은 논의가 다시 열린다.
- 코드가 문서와 어긋나면 **문서가 맞다.** 코드를 고친다.
- 범위 밖(#2·#4)은 여기서 추적하지 않는다.
