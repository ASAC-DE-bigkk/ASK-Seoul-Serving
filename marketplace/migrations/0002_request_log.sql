-- 요청 로그 — "무엇이 실제로 쓰이나"를 재기 위한 최소 스키마 (ASK-Seoul#58)
--
-- 설계 원칙 3가지:
--  1. 값이 아니라 축만 남긴다 — 필터는 **컬럼명만** 저장하고 값은 버린다.
--     우리가 알고 싶은 건 "어떤 축으로 자르나"이지 "누가 뭘 찾았나"가 아니다.
--  2. 식별자는 이미 해시인 것만 — key_hash 만 남기고 이메일·IP 는 넣지 않는다.
--     익명 미리보기는 key_hash 가 NULL 이라 사람 단위 집계가 불가능한데, 그게 의도다.
--  3. 무한 증식 금지 — D1 은 DB당 10GB 라 보존 기간을 코드가 강제한다(30일, Worker 가 정리).
--
-- ⚠️ **`IF NOT EXISTS` 는 이름 충돌을 숨긴다.** 다른 주체가 같은 이름을 선점하고 있으면
--    이 문장은 조용히 넘어가고, 게이트웨이가 없는 컬럼에 INSERT 하다 실패하는데 그 INSERT 는
--    `ctx.waitUntil` 안이라 응답에 영향을 주지 않는다 — **요청 로그가 전량 버려진다**(#23 실사고).
--
--    실제로 겪었다: 운영·개발 D1 에 `(ts, path, query, token)` 4컬럼 표가 선점돼 있었고
--    (2026-07-21~), 이 파일은 그 위를 그냥 지나갔다. 조사 결과 **transit 워커 소유**로
--    확인돼, **게이트웨이가 이름을 비켰다** — `0005_gateway_request_log.sql` 이 정본이다.
--    이 표는 **손대지 않는다**(DROP 도 ALTER 도). 결정은 ../../docs/agreement.md §2-2.
--
--    그래서 **적용 전에 반드시 배포 전 검사를 돌린다** — 런북 §0 의 `npm run preflight`.
--    마이그레이션만 믿으면 이 사실이 안 보인다. 적용 **뒤** 확인은 런북 §1 의
--    `scripts/check-request-log-schema.sql` 이 "우리가 남의 표를 건드렸는가"로 한 번 더 본다.

CREATE TABLE IF NOT EXISTS _request_log (
  ts         TEXT    NOT NULL,  -- ISO8601 UTC
  route      TEXT    NOT NULL,  -- catalog | preview | data | me | keys
  table_name TEXT,              -- 조회 대상 (해당 없으면 NULL)
  status     INTEGER NOT NULL,
  key_hash   TEXT,              -- 인증 요청만. 익명은 NULL
  filters    TEXT,              -- 사용한 필터 컬럼명 CSV — 값은 저장하지 않는다
  row_count  INTEGER,           -- 응답 행수 (0행이 반복되면 그 자체가 신호)
  ms         INTEGER            -- 처리 시간
);

-- 리포트가 "최근 N일"과 "테이블별"로만 조회하므로 인덱스는 이 둘이면 충분하다
CREATE INDEX IF NOT EXISTS idx_request_log_ts ON _request_log (ts);
CREATE INDEX IF NOT EXISTS idx_request_log_table ON _request_log (table_name, ts);
