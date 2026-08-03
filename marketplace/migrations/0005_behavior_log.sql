-- 행동 로그 축 (#9 스펙 v0, §7 결정 코멘트 기준 + #3 intent 축 편입)
-- 전부 nullable — NULL = 컬럼이 생기기 전 기록 또는 모른다 (#78 F-3, 공통 계약 C-7).
-- ip_hash 는 §7-① (A: 미저장) 결정으로 만들지 않는다 — 안 모으기로 한 축의 빈 컬럼을 두지 않는다.
-- agent_verified 는 §7-④ 결정대로 당분간 전부 NULL (로컬 cf 더미 — 공개 배포 시 실측 후 재결정).
-- page_path 는 §7-② (핵심 페이지 관측) 합의 대기 — 컬럼만 준비하고 배선은 합의 후.
-- ALTER 에는 IF NOT EXISTS 가 없다 — seed 체인에서 이 파일은 || 로 감싼다 (C-8, 0004 전례).
ALTER TABLE _request_log ADD COLUMN ua_class TEXT;       -- browser|ai_agent|ai_crawler|bot|cli|unknown
ALTER TABLE _request_log ADD COLUMN agent_name TEXT;     -- openai|anthropic|… 소문자, AI 아니면 NULL
ALTER TABLE _request_log ADD COLUMN agent_mode TEXT;     -- crawler|on_demand
ALTER TABLE _request_log ADD COLUMN agent_verified INTEGER;
ALTER TABLE _request_log ADD COLUMN country TEXT;        -- ISO-3166 alpha-2 (cf.country)
ALTER TABLE _request_log ADD COLUMN asn INTEGER;         -- 망 번호 (cf.asn)
ALTER TABLE _request_log ADD COLUMN referer_host TEXT;   -- 호스트만 — 전체 URL 금지 (C-6)
ALTER TABLE _request_log ADD COLUMN page_path TEXT;      -- route='page' 행만 (② 합의 후 배선)
ALTER TABLE _request_log ADD COLUMN intent TEXT;         -- X-ASK-Intent 옵트인 슬러그 (#3)
