# API 행동 로그 공통 스펙 — v0 초안

> **문서 성격 — 초안 (구속력 없음).** 검토는 **ASK-Seoul-Serving#9** 에서 진행 중이며,
> 합의 전까지 게이트웨이는 아무것도 수집하지 않는다. 확정되면 결정 문서로 승격하고
> 게이트웨이 구현 PR 로 옮긴다. 콘솔의 이용 행동 탭은 이 초안을 소비하도록 선반영되어
> 있다([../decision/0010](../decision/0010-behavior-log-console-first.md)) — 수집이 시작되면
> 콘솔 변경 없이 점등된다.

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

- `ua_class`: `browser` | `ai_agent` | `ai_crawler` | `bot` | `cli` | `unknown`
- `agent_name`: `openai`(GPTBot·ChatGPT-User) · `anthropic`(ClaudeBot·Claude-User) ·
  `perplexity` · `google` · `meta` · … 소문자 정규화, 열린 집합
- `agent_mode`: `crawler`(사전 수집) | `on_demand`(사용자 질문 대행). 자율 실행(autonomous)은
  저장하지 않는 **파생 지표** — MCP·에이전트 툴은 대개 `python-httpx` 같은 `cli` 얼굴로 오므로,
  판정은 여정(llms.txt/openapi.json → 발급 → 호출 사슬)에서 한다.

## 필드 v0 — `_request_log` 추가 컬럼 (전부 nullable · 추가만 · 기존 불변)

| 컬럼 | 값 | 비고 |
|---|---|---|
| `ua_class` | 위 6값 | |
| `agent_name` | 정규화 이름 | AI 아니면 NULL |
| `agent_mode` | crawler / on_demand | |
| `agent_verified` | 1/0/NULL | 검증 수단 없으면 NULL |
| `country` | ISO-3166 alpha-2 | `cf.country` |
| `asn` | INTEGER | IP 없이도 남용·집중 축 |
| `ip_hash` | **결정 필요** | 미저장 / 일 회전 솔트 해시 / prefix (#9 ①) |
| `referer_host` | 호스트만 | 전체 URL 금지 |
| `page_path` | `route='page'` 행만 | 페이지 관측은 `run_worker_first` 확대 필요 (#9 ②) |

- `route` 값 확장: + `page`
- 저장 금지 불변: Authorization · 키 원문 · 이메일 · 쿼리 값 · 원문 UA · 전체 Referer URL
- 보관: 30일 sweep 동일 (샘플링은 #9 ⑤)

## 결정 대기 (전문과 논거는 #9)

① IP 축 ② 페이지 관측 범위 ③ 분류 목록 관리 주체 ④ verified bot 신호 실측
⑤ 보관·샘플링 ⑥ `_issuance_log` 원문 IP 정리
