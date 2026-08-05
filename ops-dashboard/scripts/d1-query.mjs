#!/usr/bin/env node
/**
 * d1-query — 로컬·팀 dev·운영 D1 을 **읽기만** 한다.
 *
 * ## 왜 있나
 *
 * "운영 D1 에 그 표가 실제로 있나"를 확인하려면 원격에 붙어야 하는데, 그 확인을
 * `wrangler d1 execute --remote --command "..."` 로 손수 치면 두 가지가 사람 손에 걸린다.
 *
 *   ① **환경 플래그.** `--env production` 을 빠뜨리면 조용히 dev D1 을 본다. 결과가
 *      그럴듯하게 나오기 때문에 틀린 줄도 모른다 — 없는 표를 "없다"고 확인하고 넘어간다.
 *   ② **SQL 자체.** `d1 execute` 는 DELETE 도 DROP 도 그대로 실행한다. 불변 경계는
 *      "팀(원격) D1 에 쓰지 않는다"(decision/0002)인데, 그 경계를 지키는 것이
 *      **치는 사람의 주의력**뿐이었다.
 *
 * 이 스크립트는 둘 다 코드로 옮긴다. 환경은 이름으로 고르고(`local`·`dev`·`prod`),
 * SQL 은 **읽기 문장만** 통과시킨다. 쓰기를 하려면 이 스크립트를 안 쓰면 되지만,
 * 그건 "실수로"가 아니라 **의도적으로** 다른 명령을 치는 것이라 성격이 다르다.
 *
 * ## 사용
 *
 *   npm run d1:local -- "SELECT COUNT(*) FROM _ops_slo"
 *   npm run d1:dev   -- "SELECT COUNT(*) FROM _ops_run_event"
 *   npm run d1:prod  -- "SELECT name FROM sqlite_master WHERE type='table'"
 *   npm run d1:prod  -- --file=scripts/some-read-only.sql      # 파일도 같은 검사를 거친다
 *
 * `--json` 등 나머지 플래그는 wrangler 로 그대로 넘어간다.
 *
 * ## 읽기 전용 판정
 *
 * 화이트리스트다 — "위험한 낱말을 지운다"가 아니라 **허용된 것만 통과**시킨다. 블랙리스트는
 * 언제나 빠뜨린 낱말이 있고(`REPLACE INTO`·`VACUUM`·`ATTACH` …), 빠뜨린 게 곧 사고다.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// 환경 이름 → 어느 D1 을 어떻게 여는가. 사람이 외울 것은 왼쪽 낱말 하나뿐이다.
//
// local 의 --persist-to 는 생략하면 안 된다 — 게이트웨이와 상태를 공유하는 것이
// 로컬의 정의이기 때문이다(decision/0003). 빠뜨리면 콘솔 전용의 **빈 DB** 가 하나 더
// 생기고, "표가 없다"는 결과가 나온다.
const TARGETS = {
  local: { db: "ask-seoul-dev-d1", label: "로컬 (Miniflare)",
           args: ["--local", "--persist-to", "../marketplace/.wrangler/state"] },
  dev:   { db: "ask-seoul-dev-d1", label: "팀 dev D1 (원격)", args: ["--remote"] },
  prod:  { db: "ask-seoul-prod-d1", label: "운영 D1 (원격)", args: ["--remote", "--env", "production"] },
};

// 읽기로 인정하는 시작 낱말. WITH 는 CTE 인데 SQLite 에서는 `WITH ... DELETE` 도 문법상
// 가능하므로, 시작만 보지 않고 아래에서 금지 낱말을 한 번 더 본다.
const READ_STARTS = /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

// 문장 어디에 나와도 읽기가 아닌 것들. READ_STARTS 를 통과한 뒤의 2차 검사다 —
// `WITH x AS (SELECT 1) DELETE FROM t` 같은 것을 잡는다.
const WRITE_WORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|VACUUM|ATTACH|DETACH|REINDEX|GRANT|BEGIN|COMMIT|ROLLBACK)\b/i;

// PRAGMA 는 읽기도 쓰기도 된다(`PRAGMA journal_mode=WAL`). `=` 가 붙으면 설정이다.
const PRAGMA_WRITE = /^PRAGMA\b[^;]*=/i;

const die = (msg) => { console.error("d1-query: " + msg); process.exit(1); };

/**
 * 주석과 문자열 리터럴을 지운 뒤 검사한다. 안 지우면 `SELECT '삭제' AS x` 가
 * 금지 낱말에 걸려 멀쩡한 조회가 막히고, 반대로 `-- \n DELETE ...` 를 놓친다.
 */
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")          // 한 줄 주석
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // 블록 주석
    .replace(/'(?:[^']|'')*'/g, "''")   // 작은따옴표 문자열
    .replace(/"(?:[^"]|"")*"/g, '""');  // 식별자 인용(값이 아니어도 검사에선 무해)
}

function assertReadOnly(sql, where) {
  const clean = stripNoise(sql).trim();
  if (!clean) die(`${where}: 실행할 SQL 이 없다`);

  // 여러 문장을 한 번에 보내면 앞은 SELECT 이고 뒤가 DELETE 일 수 있다. 끝의 세미콜론
  // 하나는 습관이라 허용하고, 그 앞에 문장이 더 있으면 거절한다.
  const statements = clean.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    die(`${where}: 한 번에 한 문장만 — 세미콜론으로 이어 붙인 ${statements.length}개는 거절한다`);
  }

  const stmt = statements[0];
  if (!READ_STARTS.test(stmt)) {
    die(`${where}: 읽기 문장이 아니다 (SELECT·WITH·PRAGMA·EXPLAIN 만 허용).\n` +
        `  이 스크립트는 원격 D1 에 쓰지 않기 위한 빗장이다 — decision/0013`);
  }
  if (PRAGMA_WRITE.test(stmt)) die(`${where}: 값을 설정하는 PRAGMA 는 읽기가 아니다`);

  // 시작이 SELECT 여도 뒤에 쓰기가 붙을 수 있다. PRAGMA/EXPLAIN 은 이 검사에서 뺀다 —
  // `PRAGMA table_info(...)` 처럼 표 이름에 금지 낱말이 들어갈 수 있기 때문이다.
  if (/^(SELECT|WITH)\b/i.test(stmt) && WRITE_WORDS.test(stmt)) {
    const hit = stmt.match(WRITE_WORDS)[0];
    die(`${where}: 읽기 문장 안에 '${hit}' 가 있다 — 거절한다`);
  }
}

const [, , envName, ...rest] = process.argv;
const target = TARGETS[envName];
if (!target) {
  die(`환경을 골라야 한다: ${Object.keys(TARGETS).join(" | ")}\n` +
      `  예) npm run d1:prod -- "SELECT COUNT(*) FROM _catalog"`);
}
if (!rest.length) die("실행할 SQL 이 없다 — 따옴표로 감싼 질의나 --file=<경로> 를 준다");

// SQL 은 --command 로 오거나(따옴표 인자), --file 로 온다. 어느 쪽이든 같은 검사를 거친다 —
// 파일이면 안전하다고 볼 이유가 없다(오히려 길어서 사람이 안 읽는다).
const passthrough = [];
let sql = null;
let sqlFile = null;

for (const arg of rest) {
  if (arg.startsWith("--file=")) { sqlFile = arg.slice(7); continue; }
  if (arg.startsWith("--command=")) { sql = arg.slice(10); continue; }
  if (arg.startsWith("-")) { passthrough.push(arg); continue; }
  if (sql === null) { sql = arg; continue; }
  die(`SQL 을 두 번 줬다: ${JSON.stringify(arg)}`);
}

if (sqlFile) {
  const path = resolve(ROOT, sqlFile);
  let text;
  try { text = readFileSync(path, "utf8"); } catch { die(`파일을 못 읽는다: ${path}`); }
  // 파일은 여러 문장이 정상이므로 문장별로 본다.
  const stmts = stripNoise(text).split(";").map((s) => s.trim()).filter(Boolean);
  if (!stmts.length) die(`${sqlFile}: 실행할 SQL 이 없다`);
  stmts.forEach((s, i) => assertReadOnly(s, `${sqlFile} 문장 ${i + 1}`));
} else if (sql) {
  assertReadOnly(sql, "질의");
} else {
  die("실행할 SQL 이 없다");
}

// 무엇을 어디에 물어보는지 **먼저 말한다.** 결과만 나오면 어느 D1 을 본 건지 화면에
// 남지 않아, 나중에 그 출력을 옮겨 적을 때 환경이 섞인다.
console.error(`d1-query → ${target.label} · ${target.db} · 읽기 전용`);

const wrangler = resolve(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const args = ["d1", "execute", target.db, ...target.args, ...passthrough];
if (sqlFile) args.push(`--file=${sqlFile}`);
else args.push("--command", sql);

// 셸을 거치지 않는다 — SQL 에 든 따옴표가 OS 마다 다르게 깨지는 것을 피한다(Windows 실측).
const r = spawnSync(process.execPath, [wrangler, ...args], { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
