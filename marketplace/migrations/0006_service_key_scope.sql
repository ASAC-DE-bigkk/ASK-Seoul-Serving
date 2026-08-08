-- K-Skill proxy 같은 비인간 service key의 최소 권한 계약 (#194).
-- 기존 `_keys` 는 이메일 소유권·셀프 폐기 수명주기를 보존한다. service key를 그 표에
-- ALTER로 섞으면 부분 적용이 사용자 전체 인증 장애가 될 수 있어 별도 표로 분리한다.
CREATE TABLE IF NOT EXISTS _service_keys (
  key_hash     TEXT PRIMARY KEY,
  key_prefix   TEXT NOT NULL,
  service_name TEXT NOT NULL,
  scopes_json  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  daily_quota  INTEGER NOT NULL DEFAULT 1000,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- 하나의 서비스에는 key rotation 중 짧게 두 active key가 공존할 수 있다.
-- service_name 자체를 UNIQUE로 묶지 않고, 운영 절차가 새 key smoke 뒤 이전 key를
-- revoke한다. 이 index는 해당 절차의 active key 조회만 좁힌다.
CREATE INDEX IF NOT EXISTS idx_service_keys_name_status
  ON _service_keys (service_name, status);
