#!/usr/bin/env node
/**
 * service key 발급기 (#203) — **원문을 흘리지 않고** `_service_keys` 등록 SQL 을 만든다.
 *
 * ## 왜 스크립트인가
 *
 * `_service_keys`(0006)에 INSERT 하는 코드가 서버 어디에도 없다 — 관리 엔드포인트도, 스크립트도
 * 없었다. 그래서 손으로 하면 흐름이 이렇게 된다: 어딘가에서 원문 만들기 → 해시 계산 →
 * `wrangler … --command "INSERT …"`. 해시는 명령행에 있어도 되지만 **원문이 셸 히스토리·임시
 * 파일에 남기 쉬운 구조**다. 요청자(#203 ③)가 막아 달라고 한 것이 정확히 그것이다.
 *
 * ## 원문이 새지 않게 하는 장치 둘
 *
 * ① **원문은 stderr, SQL 은 stdout.** `issue-service-key.mjs > insert.sql` 로 리다이렉트하면
 *    파일에는 **해시만 담긴 SQL** 이 들어가고 원문은 터미널에만 뜬다. 반대로 되어 있으면
 *    "SQL 을 파일로 받는다"는 지극히 자연스러운 동작이 곧 유출이 된다.
 * ② **어떤 경로로도 파일에 쓰지 않는다.** 이 스크립트에 파일 쓰기가 없다.
 *
 * ## 죽은 키를 만들지 않는다
 *
 * 발급은 비공개 채널 전달까지 한 묶음이라, 잘못 만들면 그 왕복을 통째로 다시 해야 한다.
 * 그래서 서버가 **실제로 받아 줄 값인지**를 여기서 먼저 본다:
 *
 *   - scope 문자열이 서버 정규식(`shared.js serviceKeyScopes`)과 다르면 그 함수가 `null` 을
 *     돌려 **fail-closed** 된다 → 인증은 되는데 모든 route 가 403 인 키가 나온다.
 *   - 서버가 어느 route 에서도 요구하지 않는 scope 를 넣어도 결과는 같다. 지금 실제로
 *     요구되는 값은 `skill.js` 의 `SKILL_SERVICE_SCOPE` 하나뿐이다.
 *
 * ## 사용
 *
 *   npm run issue:service-key -- --service-name "k-skill-proxy:seoul-weather-risk" \
 *                                --scope "skill:seoul-weather-risk:read"
 *
 * 출력된 SQL 을 운영 D1 에 친다(해시만 들어 있어 명령행에 남아도 된다):
 *
 *   npx wrangler d1 execute ask-seoul-prod-d1 --remote --command "<SQL>"
 *
 * 🔴 원문은 화면에 **한 번만** 뜬다. 스크롤백을 지우기 전에 비공개 채널로 옮긴다.
 *    잃어버렸으면 복구 경로가 없다 — 새로 발급하고 이전 행을 `revoked` 로 바꾼다.
 */
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SKILL_SERVICE_SCOPE } from "../src/skill.js";

// 서버가 받아 주는 모양 그대로다. `shared.js authenticate` 의 Bearer 정규식이
// `ask_[0-9a-f]{32}` 이고, 사용자 키 발급(`index.js newKey`)도 16바이트를 hex 로 편다.
// 여기가 어긋나면 인증 단계에서 401 이라 키가 아예 안 산다.
export const KEY_RE = /^ask_[0-9a-f]{32}$/;
// `shared.js serviceKeyScopes` 와 **같은 정규식**이다. 다르면 여기서 통과한 값이 서버에서
// fail-closed 되어, 원인이 D1 에도 로그에도 안 보이는 죽은 키가 된다.
export const SCOPE_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
// principal 이름. 로그·운영 조회에 그대로 쓰이므로 공백·따옴표를 받지 않는다.
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

export function newServiceKey() {
  const key = "ask_" + randomBytes(16).toString("hex");
  return {
    key,
    hash: createHash("sha256").update(key, "utf8").digest("hex"),
    prefix: key.slice(0, 8),   // `index.js` 와 같은 규약 — 표시용 8자
  };
}

// SQL 리터럴. 값이 전부 위 정규식을 통과한 것이거나 우리가 만든 JSON 이라 홑따옴표가
// 들어올 자리는 없지만, **"들어올 리 없다"에 기대지 않는다** — 이 문자열이 운영 D1 로 간다.
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// 🔴 **SQL 에 큰따옴표를 한 글자도 넣지 않는다.** `JSON.stringify(scopes)` 를 리터럴로 박으면
//    `'["skill:…:read"]'` 가 되는데, **PowerShell 5.1 이 네이티브 실행 파일로 인자를 넘길 때
//    큰따옴표를 먹는다.** 2026-08-08 실사고: 그렇게 등록된 행이 `[skill:…:read]`(len 31,
//    `json_valid=0`)로 들어가 `serviceKeyScopes()` 가 fail-closed 됐고, **인증은 되는데 모든
//    경로가 403 인 죽은 키**가 됐다. 원인이 D1 에도 로그에도 안 보였다.
//    `json_array()` 는 SQLite 안에서 JSON 을 만들므로 셸이 먹을 큰따옴표가 없다.
//    (아래 테스트가 "SQL 에 `\"` 가 없다"를 고정한다 — 이 성질이 곧 방어다.)
export function buildInsert({ hash, prefix, serviceName, scopes, quota, createdAt }) {
  const scopesJson = "json_array(" + scopes.map(lit).join(", ") + ")";
  return "INSERT INTO _service_keys " +
    "(key_hash, key_prefix, service_name, scopes_json, status, daily_quota, created_at) VALUES (" +
    [lit(hash), lit(prefix), lit(serviceName), scopesJson, lit("active"),
     String(quota), lit(createdAt)].join(", ") + ");";
}

export function parseArgs(argv) {
  const out = { scopes: [], quota: 1000, serviceName: null, allowUnknownScope: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--service-name") out.serviceName = argv[++i];
    else if (a === "--scope") out.scopes.push(argv[++i]);
    else if (a === "--quota") out.quota = Number(argv[++i]);
    else if (a === "--allow-unknown-scope") out.allowUnknownScope = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return out;
}

/** 서버가 받아 줄 값인지 본다. 통과 못 하면 발급하지 않는다 — 죽은 키가 더 비싸다. */
export function validate({ serviceName, scopes, quota, allowUnknownScope }, knownScopes) {
  const errs = [];
  if (!serviceName) errs.push("--service-name 이 필요하다");
  else if (!SERVICE_NAME_RE.test(serviceName)) errs.push(`service_name 형식이 아니다: ${serviceName}`);
  if (!scopes.length) errs.push("--scope 가 최소 하나 필요하다 — scope 없는 service key 는 모든 route 에서 403 이다");
  for (const s of scopes) {
    if (!SCOPE_RE.test(s)) errs.push(`scope 형식이 서버 정규식과 다르다: ${s}`);
    else if (!allowUnknownScope && !knownScopes.includes(s))
      errs.push(`서버가 어느 route 에서도 요구하지 않는 scope 다: ${s} ` +
        `(요구되는 값: ${knownScopes.join(" · ")}) — 정말 미리 발급하려면 --allow-unknown-scope`);
  }
  if (!Number.isInteger(quota) || quota <= 0) errs.push(`--quota 는 양의 정수여야 한다: ${quota}`);
  return errs;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const knownScopes = [SKILL_SERVICE_SCOPE];
  const errs = validate(args, knownScopes);
  if (errs.length) {
    process.stderr.write("발급하지 않았다:\n" + errs.map((e) => `  - ${e}\n`).join(""));
    return 2;
  }

  const { key, hash, prefix } = newServiceKey();
  const sql = buildInsert({
    hash, prefix, serviceName: args.serviceName, scopes: args.scopes,
    quota: args.quota, createdAt: new Date().toISOString(),
  });

  // 🔴 원문은 **stderr 로만**. stdout 을 파일로 받아도 여기 안 담긴다.
  process.stderr.write(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    " 🔑 service key 원문 — 이 화면에만 한 번 뜬다\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    `   ${key}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    ` principal : ${args.serviceName}\n` +
    ` scope     : ${args.scopes.join(" · ")}\n` +
    ` prefix    : ${prefix}  (운영 조회·폐기에 쓰는 표시값)\n` +
    ` quota     : ${args.quota}/일\n\n` +
    " 다음 순서로 한다:\n" +
    "   1. 위 원문을 합의된 비공개 채널로 옮긴다 (이슈·PR·로그에 남기지 않는다)\n" +
    "   2. 아래 SQL 을 운영 D1 에 친다 — 해시만 들어 있어 명령행에 남아도 된다\n" +
    "        npx wrangler d1 execute ask-seoul-prod-d1 --remote --command \"<아래 SQL>\"\n" +
    "   3. 터미널 스크롤백을 지운다\n" +
    " 원문을 잃으면 복구 경로가 없다 — 새로 발급하고 이전 행을 revoked 로 바꾼다.\n\n");

  process.stdout.write(sql + "\n");
  return 0;
}

// 테스트가 import 할 수 있게 CLI 는 직접 실행일 때만 돈다.
// `pathToFileURL` 을 쓰는 이유: Windows 경로(`C:\…`)를 손으로 `file://` 에 붙이면 안 맞아
// **테스트가 import 하는 순간 CLI 가 도는** 사고가 난다(사용자 환경이 Windows 다).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
