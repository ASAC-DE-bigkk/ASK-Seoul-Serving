// service key 발급기(#203)의 위험 지점을 고정한다.
//
// 이 스크립트가 틀리면 두 가지로 나타난다: ① **원문이 새거나** ② 서버가 안 받는 **죽은 키**가
// 나온다. 둘 다 조용히 실패한다 — ①은 아무 신호가 없고, ②는 "인증은 되는데 전부 403"이라
// 원인이 D1 에도 로그에도 안 보인다. 그래서 테스트가 유일한 신호다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  KEY_RE, SCOPE_RE, newServiceKey, buildInsert, parseArgs, validate,
} from "./issue-service-key.mjs";
import { SKILL_SERVICE_SCOPE } from "../src/skill.js";

const SCRIPT = fileURLToPath(new URL("./issue-service-key.mjs", import.meta.url));
const OK_ARGS = ["--service-name", "k-skill-proxy:seoul-weather-risk", "--scope", SKILL_SERVICE_SCOPE];

test("키 모양이 서버가 받는 것과 같다 — ask_ + 32 hex", () => {
  for (let i = 0; i < 20; i++) {
    const { key, hash, prefix } = newServiceKey();
    // 서버 Bearer 정규식과 같은 모양이 아니면 인증 단계에서 401 이라 키가 아예 안 산다.
    assert.match(key, KEY_RE);
    assert.equal(hash, createHash("sha256").update(key, "utf8").digest("hex"));
    assert.equal(prefix, key.slice(0, 8));   // index.js 와 같은 규약
  }
});

test("같은 키가 두 번 나오지 않는다", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newServiceKey().key);
  assert.equal(seen.size, 200);
});

test("scope 정규식이 서버(shared.js serviceKeyScopes)와 같다", () => {
  // 여기서 통과한 값이 서버에서 막히면 fail-closed 되어 죽은 키가 된다. 두 정규식이
  // 갈리는 순간이 그 사고의 시작이므로 대표값으로 고정한다.
  for (const ok of ["skill:seoul-weather-risk:read", "a", "a-b_c.d:e"]) assert.match(ok, SCOPE_RE);
  for (const bad of ["", "A", ":x", "-x", "x y", "x/y", "x".repeat(129)]) assert.doesNotMatch(bad, SCOPE_RE);
});

test("서버가 안 쓰는 scope 는 발급을 막는다 — 죽은 키가 더 비싸다", () => {
  const args = parseArgs(["--service-name", "svc", "--scope", "skill:something:else"]);
  const errs = validate(args, [SKILL_SERVICE_SCOPE]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /요구하지 않는 scope/);
  // 미리 발급해야 할 사정이 있으면 명시적으로 열 수 있다 — 기본값이 닫힘인 게 요점이다.
  assert.deepEqual(validate({ ...args, allowUnknownScope: true }, [SKILL_SERVICE_SCOPE]), []);
});

test("scope 가 없으면 발급하지 않는다 — 모든 route 에서 403 인 키가 된다", () => {
  const errs = validate(parseArgs(["--service-name", "svc"]), [SKILL_SERVICE_SCOPE]);
  assert.ok(errs.some((e) => /--scope 가 최소 하나/.test(e)));
});

test("quota 는 양의 정수만", () => {
  for (const q of ["0", "-1", "1.5", "abc"]) {
    const errs = validate(parseArgs([...OK_ARGS, "--quota", q]), [SKILL_SERVICE_SCOPE]);
    assert.ok(errs.some((e) => /--quota/.test(e)), `허용되면 안 됨: ${q}`);
  }
});

test("INSERT 는 해시만 싣는다 — 원문이 들어갈 자리가 없다", () => {
  const { key, hash, prefix } = newServiceKey();
  const sql = buildInsert({
    hash, prefix, serviceName: "svc", scopes: ["skill:x:read"], quota: 1000,
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.ok(sql.includes(hash));
  assert.ok(!sql.includes(key), "SQL 에 원문이 들어갔다");
  assert.ok(sql.startsWith("INSERT INTO _service_keys "));
  assert.ok(sql.includes("'active'"));
});

// 🔴 2026-08-08 실사고의 회귀 방지. `'["skill:…:read"]'` 를 리터럴로 박았더니 PowerShell 이
// 큰따옴표를 먹어 `[skill:…:read]`(json_valid=0)로 등록됐고, 인증은 되는데 모든 경로가 403 인
// 죽은 키가 됐다. **SQL 에 큰따옴표가 한 글자도 없으면** 셸이 먹을 것이 없다.
test("SQL 에 큰따옴표가 없다 — 셸이 먹을 것이 없어야 한다", () => {
  const sql = buildInsert({
    hash: "h", prefix: "p", scopes: ["skill:seoul-weather-risk:read", "skill:other:read"],
    serviceName: "k-skill-proxy:seoul-weather-risk", quota: 1000, createdAt: "t",
  });
  assert.ok(!sql.includes('"'), `SQL 에 큰따옴표가 있다: ${sql}`);
  // scope 는 SQLite 가 JSON 으로 만든다 — 저장 결과는 ["a","b"] 이고 json_valid=1 이다.
  assert.match(sql, /json_array\('skill:seoul-weather-risk:read', 'skill:other:read'\)/);
});

test("홑따옴표가 SQL 을 깨지 않는다", () => {
  const sql = buildInsert({
    hash: "h", prefix: "p", serviceName: "it's", scopes: ["a"], quota: 1,
    createdAt: "t",
  });
  assert.ok(sql.includes("'it''s'"));
});

// ── 🔴 가장 중요한 계약: 원문은 stdout 으로 안 나간다 ──────────────────────────
// `issue-service-key.mjs > insert.sql` 은 지극히 자연스러운 사용법이다. 원문이 stdout 에
// 실리면 그 한 줄이 곧 유출이고, 아무 신호도 없다.
test("원문은 stderr 로만 나온다 — stdout 을 파일로 받아도 안 담긴다", () => {
  const stdout = execFileSync(process.execPath, [SCRIPT, ...OK_ARGS], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assert.doesNotMatch(stdout, /ask_[0-9a-f]{32}/, "stdout 에 원문이 실렸다");
  assert.match(stdout, /^INSERT INTO _service_keys /);
  assert.match(stdout, /[0-9a-f]{64}/);            // 해시는 있어야 한다
});

test("검증 실패면 stdout 이 비고 종료코드가 0이 아니다 — 반쪽 SQL 이 안 나간다", () => {
  let status = 0, stdout = "";
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, "--service-name", "svc"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status; stdout = e.stdout ?? "";
  }
  assert.notEqual(status, 0);
  assert.equal(stdout.trim(), "");
});
