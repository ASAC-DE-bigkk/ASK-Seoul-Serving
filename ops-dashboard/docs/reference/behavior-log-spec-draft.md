# API 행동 로그 공통 스펙 — v0

> **문서 성격 — 확정 결정의 요약 (정본 반영 대기).** 결정 6건(①~⑥)은 **ASK-Seoul-Serving#9**
> 에서 확정됐다(2026-08-03, 게이트웨이 @yooseongjin527 · 콘솔 @Exisign). **스키마 정본은
> marketplace 마이그레이션**(공통 계약 C-9)이며, `migrations/0005` 가 반영되기 전까지
> 게이트웨이는 아무것도 수집하지 않는다. 콘솔의 이용 행동 탭은 이 스펙을 소비하도록
> 선반영되어 있다([../decision/0010](../decision/0010-behavior-log-console-first.md)) —
> 수집이 시작되면 콘솔 변경 없이 점등된다. 선작업(분류 함수·발급 IP 해시·유실 검증)은
> marketplace PR#19.

## 목적

서빙의 "누가·무엇이·어떻게 쓰나"를 HTTP 신호로 관측한다 — 어떤 키가 어떤 호출을,
어떤 IP(망)가 어떤 페이지에, 어떤 AI 가 어떤 요청으로 어떤 실행을 했는지.
파이프라인 쪽 대응물은 운영 기록(#78, [ops-records-log-patterns](ops-records-log-patterns.md))이다.

## 얻을 수 있는 신호 (Workers 기준)

- 헤더: `User-Agent` · `Referer` · `Sec-Fetch-*` · `Signature-Agent`(Web Bot Auth)
- `request.cf`: `country` · `colo` · `asn` · `asOrganization` (+ 플랜 종속 verified bot 신호)
- `CF-Connecting-IP` (저장 여부는 결정 사항)
- 로컬 `wrangler dev` 에서는 cf 필드가 비거나 더미 — **모른다는 NULL** (F-3 원칙 재사용)

## 클라이언트 분류 (원문 UA 는 저장하지 않는다 — 분류 결과만)

- `ua_class`: `browser` | `ai_agent` | `ai_crawler` | `bot` | `cli` | `no_ua` | `unknown`
  - **`no_ua` 와 `unknown` 은 다르다**(#112 — 2026-08-06 반영). `no_ua` 는 UA 헤더가 아예
    없는 것이고(Node 18+ 의 global `fetch` 가 대표적), `unknown` 은 UA 는 왔는데 목록에
    없어 못 알아본 것이다. **원문 UA 를 저장하지 않으므로 수집 시점에 안 가르면 영구히
    사라진다.** 같은 원칙을 `intent` 축이 이미 쓰고 있었다(안 보냄 = NULL / 못 알아봄 = `other`).
  - 과거에 쌓인 `unknown` 은 **소급하지 않는다** — 원문이 없어 되돌릴 수 없고, 지어내면
    §4-3 "모른다 ≠ 0" 을 스스로 어긴다.
- `agent_name`: `openai`(GPTBot·ChatGPT-User) · `anthropic`(ClaudeBot·Claude-User) ·
  `perplexity` · `google` · `meta` · … 소문자 정규화, 열린 집합
- `agent_mode`: `crawler`(사전 수집) | `on_demand`(사용자 질문 대행). 자율 실행(autonomous)은
  저장하지 않는 **파생 지표** — MCP·에이전트 툴은 대개 `python-httpx` 같은 `cli` 얼굴로 오므로,
  판정은 여정(llms.txt/openapi.json → 발급 → 호출 사슬)에서 한다.

## 필드 v0 확정 — `_gateway_request_log` 컬럼 8종 + intent (전부 nullable · 추가만 · 기존 불변)

| 컬럼 | 값 | 비고 |
|---|---|---|
| `ua_class` | 위 7값 | `no_ua` 는 2026-08-06 추가(#112) — 마이그레이션 없음(TEXT 값 집합만 확장) |
| `agent_name` | 정규화 이름 | AI 아니면 NULL |
| `agent_mode` | crawler / on_demand | |
| `agent_verified` | 1/0/NULL | ④ **재결정 완료(2026-08-06, #111)** — 아래 참조. 배선됨 |
| `country` | ISO-3166 alpha-2 | `cf.country` |
| `asn` | INTEGER | IP 없이도 남용·집중 축 — ① 의 갈음 축 |
| `referer_host` | 호스트만 | 전체 URL 금지 |
| `page_path` | `route='page'` 행만 | ② 확정: **핵심 페이지 + 기계 문서만** — `/` · `/docs` · `/legal` · `/llms.txt` · `/openapi.json` · `/column-docs.json` (AI 여정의 출발점 포함) |
| `intent` | 옵트인 슬러그 | #3 편입: `X-ASK-Intent` 헤더 — 질문 원문이 아니라 의도 코드만 (같은 "축만" 철학) |

- **④ `agent_verified` 재결정 완료 (2026-08-06, #111).** "로컬 cf 가 더미라 실측 불가"가
  미룬 이유였는데, `ask-seoul.kr` 배포로 조건이 충족돼 **배포본의 `request.cf` 를 읽기
  전용으로 실측**했다(`wrangler tail --env production --format json` — 코드 변경·배포 없음).

  ```
  ✅ verifiedBotCategory   온다. UA 자기 신고가 아니라 **CF 가 확인한 값**이다
                           (잰 요청이 curl 이라 값은 "")
  ❌ botManagement         score · verifiedBot · ja3Hash 없음 (Enterprise 전용)
  🟡 TLS 지문 3종           tlsClientHelloLength · CiphersSha1 · ExtensionsSha1 은 있다
  ```

  **매핑은 셋이다.** `"" → 0` 으로 접으면 브라우저·curl 이 전부 "검증 실패"가 되는데 그들은
  애초에 검증 대상이 아니다(§4-3 · #78 F-3).

  ```
  AI 에이전트 + 카테고리 있음  →  1     CF 가 확인했다
  AI 에이전트 + ""             →  0     자칭인데 CF 가 확인 못 했다 = 진짜 검증 실패
  AI 에이전트가 아님            →  NULL  검증할 것이 없다
  ```

  필드 자체가 없을 때(`cf` 를 못 받는 환경)도 NULL 이다 — **"봤는데 아니다"(`""`)와
  "못 물어봤다"(부재)는 다른 사실**이다.

  ⚠️ **아직 확정되지 않은 것**: 잰 요청이 curl 이라 `""` 였고, **진짜 검증된 크롤러가 왔을 때
  1 로 찍히는지는 확인하지 못했다.** 검증된 봇을 흉내낼 수 없다는 게 이 필드의 존재 이유라,
  실제 크롤러 도착 전엔 확정되지 않는다(#111 을 그래서 닫지 않았다).

- **`ip_hash` 는 미채택** (① 확정: **(A) 미저장** — 빈 컬럼을 만들지 않는다). "asn 으로 못 잡는
  남용"이 실측되면 일 회전 해시로 승격(증분 규약상 ALTER 한 줄).
- `route` 값 확장: + `page`
- ③ 확정: AI 분류 목록은 **코드 상수**(marketplace 담당, 갱신 = PR — PR#19 의 `classifyClient`).
- ⑤ 확정: 보관 30일 유지, 샘플링 보류(페이지 범위 축소로 폭증 위험 낮음).
- ⑥ 확정: `_issuance_log` 는 **일 회전 솔트 해시 + 24h sweep** (PR#19) — ① 과 합쳐
  원문 IP 가 어디에도 남지 않는다.
- 저장 금지 불변: Authorization · 키 원문 · 이메일 · 쿼리 값 · 질문 원문 · 원문 UA · 전체 Referer URL

## 남은 것

- `migrations/0005` (컬럼 9종 + `logRequest` 배선 — 갈라지면 조용한 유실이라 한 PR 로 묶는다, C-10)
- `run_worker_first` 에 ② 의 페이지 목록 추가 (같은 PR)
- 콘솔 후속: `intent × row_count=0`(빈 응답 의도) 카드 — 0005 반영 후
