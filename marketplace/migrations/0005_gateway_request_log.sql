-- 게이트웨이 요청 로그 — 이름을 비켜 새로 세운다 (agreement §2 · ASK-Seoul-Serving#44)
--
-- ## 왜 새 표인가
--
-- `_request_log` 라는 이름은 **원격에서 이미 남이 쓰고 있다**(transit 워커, 4컬럼
-- `ts·path·query·token`). 쓰는 쪽이 계속 쓰기로 해서 DROP 이 불가능하고, 그러면
-- 게이트웨이가 비키는 수밖에 없다.
--
-- 이름을 공유하면 무슨 일이 나는지는 이미 겪었다 — `0004` 의 조건 없는 ALTER 가
-- **남의 표에 우리 컬럼을 붙였다**(dev D1 실측). `CREATE TABLE IF NOT EXISTS` 가
-- 이름만 보고 조용히 넘어가기 때문이다. 여기서 컬럼 13종을 더 얹었다면 같은 일이
-- 열세 번 더 일어날 수 있었다.
--
-- ## 왜 `_api_request_log` 가 아니라 `_gateway_request_log` 인가
--
-- 이 표에는 **네 표면이 전부 들어온다** — `/api/v1`(catalog·preview·data·me·keys) ·
-- `/v1`(폐기 예정, decision/0004 D-2) · `/skill/v1`(skill_*) · `/mcp`(route="mcp").
-- 로깅이 워커 하나의 깔때기라서다. 한 문의 이름을 붙이면 나머지가 설명되지 않는다.
-- `gateway` 는 이 워커의 자기 이름이다(`wrangler.toml` 의 `name = "ask-seoul-gateway"`).
--
-- ## 왜 ALTER 를 안 쓰고 완성형으로 만드나
--
-- 표를 새로 세우는 김에 합의된 축 13종을 처음부터 넣는다. ALTER 를 나눠 치면 그때마다
-- "어느 표에 붙었나"가 배포 순서에 좌우되고, 로컬·dev·prod 의 모양이 갈린다.
-- **전부 nullable** 이고, 앞으로도 **추가만** 한다(삭제·개명 금지 — ASK-Seoul#78 `D-3`).
--
-- ⚠️ 배선 전까지 `intent`·`pattern_id`·`publication_id`·행동 로그 8종은 **전량 NULL** 이다.
--    NULL 은 "재지 않았다"이지 0 이 아니다 — 화면이 0 으로 그리면 관측 공백이
--    "이상 없음"으로 위장된다(#78 `F-3`).
--
-- 기존 `_request_log` 는 **손대지 않는다.** DROP 도, ALTER 도 없다. 두 표가 공존한다.

CREATE TABLE IF NOT EXISTS _gateway_request_log (
  -- 0002 + 0004 에서 오는 9종 — 뜻과 제약을 그대로 승계한다
  ts         TEXT    NOT NULL,  -- ISO8601 UTC
  route      TEXT    NOT NULL,  -- catalog | preview | data | me | keys | skill_* | v1_* | mcp
  table_name TEXT,              -- 조회한 **물리** 표 이름 (해당 없으면 NULL)
  status     INTEGER NOT NULL,
  key_hash   TEXT,              -- 인증 요청만. 익명 미리보기는 NULL
  filters    TEXT,              -- 사용한 필터 **컬럼명** CSV — 값은 저장하지 않는다
  row_count  INTEGER,           -- 응답 행수 (0행이 반복되면 그 자체가 신호)
  ms         INTEGER,
  request_id TEXT,              -- 응답 헤더 X-Request-Id — 지원 문의에서 그 요청을 특정한다

  -- 공개 식별자 (decision/0003). `table_name` 은 물리명이라 D1 표명 통일이 오면
  -- 과거 로그가 아무것도 못 가리킨다. 그리고 intent 어휘로 쓰는
  -- `d1_usage_patterns` 의 키도 `product_id` 다 — 집계 축은 이쪽이어야 한다.
  product_id TEXT,

  -- 행동 로그 8종 (#9) — 배선 대기
  ua_class       TEXT,     -- browser | ai_agent | ai_crawler | bot | cli | unknown
  agent_name     TEXT,     -- 에이전트 이름(코드 상수). 원문 UA 는 저장하지 않는다
  agent_mode     TEXT,     -- crawler | on_demand
  agent_verified INTEGER,  -- **NULL 로 시작** — 검증 수단 없음 ≠ 검증 실패
  country        TEXT,     -- 남용 판정 축 (원문 IP 대신)
  asn            TEXT,
  referer_host   TEXT,     -- 호스트만. 전체 Referer 아님
  page_path      TEXT,     -- 핵심 페이지 + 기계 문서 3종만 (§3-4)

  -- 의도·패턴·환경
  intent         TEXT,     -- X-ASK-Intent 슬러그. **질문 원문 아님** (§3-6)
  pattern_id     TEXT,     -- 패턴 실행 API 로깅 키 (ASAC-DAG#642)
  publication_id TEXT,
  env            TEXT      -- local | prod — 지표가 조용히 섞이는 것을 막는다 (§6-2)
);

-- 리포트가 "최근 N일"·"표별"·"제품별"로 조회한다. 인덱스 이름도 표를 따라 비킨다 —
-- `CREATE INDEX IF NOT EXISTS` 역시 이름이 같으면 조용히 넘어가기 때문이다.
CREATE INDEX IF NOT EXISTS idx_gw_request_log_ts      ON _gateway_request_log (ts);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_table   ON _gateway_request_log (table_name, ts);
CREATE INDEX IF NOT EXISTS idx_gw_request_log_product ON _gateway_request_log (product_id, ts);
