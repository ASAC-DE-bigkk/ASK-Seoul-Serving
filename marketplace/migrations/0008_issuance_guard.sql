-- 재발급 상한을 **키 행 밖으로** 옮긴다 (#320).
--
-- 🔴 왜: 상한(하루 5회)은 `_keys.rotated_day/rotated_count` 에 얹혀 있었는데,
--    완전삭제(`DELETE /api/v1/keys?purge=true`)가 그 행을 지운다. 그래서
--
--        남용 → 완전삭제 → 재로그인 → **신규 발급**(회전이 아니라) → 반복
--
--    이 되어 **상한이 막으려던 바로 그 행동으로 상한이 사라졌다.** 남는 제동은
--    발급 IP 시간당 5회뿐이고 IP 는 바꾸기 쉽다.
--
-- 그래서 카운터를 **이메일의 해시**를 키로 하는 별도 표에 둔다. 완전삭제는 이 표를
-- 건드리지 않으므로 상한이 살아남는다.
--
-- 🔑 **개인정보는 늘지 않고 줄어든다.** 지금 `_keys.email` 은 원문이고 보유 기간이
--    "이용자의 삭제 요청 시까지" = 사실상 무기한이다. 이 표는 **해시 + 30일**이다.
--    ⚠️ 다만 이메일은 값 공간이 좁아 해시가 **익명이 아니라 가명**이다 — 비밀값을
--    아는 서비스는 후보를 대조할 수 있다. 그래서 보유 기간을 30일로 못 박고
--    처리방침 제3조에 그대로 적는다(발급 IP 해시에 대해 이미 쓰는 방식과 같다).
--
-- ⚠️ `_keys.rotated_day/rotated_count` 는 **지우지 않는다** — 마이그레이션은 증분이고
--    (CLAUDE.md §2), 적용 전에 발급된 계정의 오늘치를 읽을 자리로 한동안 더 쓴다
--    (`src/index.js` 의 seed 주석 참조). 새로 쓰지는 않는다.
CREATE TABLE IF NOT EXISTS _issuance_guard (
  -- sha256("guard|" || ISSUANCE_SALT || "|" || email). 날짜를 섞지 않는다 —
  -- 날짜를 섞으면 매일 값이 달라져 "어제 다 썼는지"를 못 본다.
  email_hash TEXT PRIMARY KEY,
  day        TEXT NOT NULL,          -- KST 날짜(YYYY-MM-DD). 다른 날이면 0부터 다시 센다
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL           -- 30일 보존의 기준. 쓸 때마다 갱신한다
);

-- 청소는 쓰는 김에 같이 한다(`_issuance_log` 와 같은 방식) — 별도 스케줄러를 두면
-- 그것이 안 도는 것을 아무도 모른다.
CREATE INDEX IF NOT EXISTS idx_issuance_guard_updated ON _issuance_guard(updated_at);
