#!/usr/bin/env node
/**
 * d1 — 운영 D1 에 SQL 을 친다. **쓰기는 열려 있고, 스키마는 잠겨 있다.**
 *
 * ## 왜 있나
 *
 * D1 이 운영 하나뿐이 되면서(decision/0015) `wrangler d1 execute` 를 손수 치는 것과
 * 운영 DB 를 만지는 것이 같은 일이 됐다. 팀이 **데이터 쓰기는 열기로** 정했으므로
 * INSERT·UPDATE·DELETE 는 막지 않는다 — 막으면 결정을 코드가 뒤집는 것이다.
 *
 * 대신 **스키마는 막는다.** 그건 별개의 약속이고, 아직 살아 있다:
 *
 *   ① **마켓플레이스 소유 표의 스키마는 절대 바꾸지 않는다.** `_keys`·`_usage`·`_burst`·
 *      `_gateway_request_log` 의 정본은 `../marketplace/migrations/` 다(CLAUDE.md §6).
 *      여기서 ALTER 하면 저쪽 정본과 갈라지고, 갈라진 순간 양쪽 다 못 믿는다.
 *   ② **파이프라인 소유 표(`_ops_run_event` 외 3종)도 마찬가지다.** 정본은 ASAC-DAG.
 *   ③ **DDL 은 마이그레이션으로만 한다.** 손으로 친 CREATE 는 장부에 안 남아서,
 *      다음 사람이 `migrate` 를 돌렸을 때 "이미 있음"과 "적용됨"이 어긋난다(0007 증분 규약).
 *
 * 즉 이 스크립트가 지키는 것은 "쓰지 마라"가 아니라 **"남의 표 모양을 바꾸지 마라"** 다.
 *
 * ## 사용
 *
 *   npm run d1 -- "SELECT COUNT(*) FROM _ops_run_event"
 *   npm run d1 -- "UPDATE _keys SET daily_quota = 500 WHERE key_hash = '...'"
 *   npm run d1 -- --file=scripts/some.sql
 *   npm run d1 -- --json "SELECT ..."        # 나머지 플래그는 wrangler 로 그대로 넘어간다
 *
 * 스키마를 정말 바꿔야 하면 `migrations/` 에 파일을 더하고 `npm run migrate` 를 쓴다.
 * 남의 표라면 그 소유자에게 요청한다 — 우회로는 두지 않는다.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const DB = "ask-seoul-prod-d1";

// 스키마를 바꾸는 문장. 하나라도 걸리면 통과시키지 않는다 — 대상 표가 무엇이든,
// DDL 은 마이그레이션 장부를 거쳐야 하기 때문이다(③).
const DDL = /\b(CREATE|ALTER|DROP|TRUNCATE|REINDEX|VACUUM|ATTACH|DETACH)\b/i;

// 남의 표. DDL 이 아니어도 이름이 보이면 한 번 더 경고한다(데이터 쓰기는 허용).
const FOREIGN = {
  "마켓플레이스": ["_keys", "_usage", "_burst", "_gateway_request_log"],
  "파이프라인(ASAC-DAG)": ["_ops_run_event", "_ops_daily_metric",
                           "_ops_pipeline_state", "_ops_pipeline_expectation"],
  "도메인 export(dbt)": ["_catalog", "_publication_ledger"],
};

const die = (msg) => { console.error("d1: " + msg); process.exit(1); };

/** 주석·문자열 리터럴을 지운다 — 안 지우면 `SELECT 'DROP' AS x` 가 DDL 로 잡힌다. */
function strip(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ");
}

const argv = process.argv.slice(2);
if (!argv.length) die('SQL 이 없다. 예: npm run d1 -- "SELECT 1"');

// --file= 이면 파일 내용을, 아니면 첫 비플래그 인자를 검사 대상으로 삼는다.
const fileArg = argv.find((a) => a.startsWith("--file="));
const inline = argv.find((a) => !a.startsWith("-"));
let sql;
if (fileArg) {
  const p = resolve(ROOT, fileArg.slice("--file=".length));
  try { sql = readFileSync(p, "utf8"); } catch { die("파일을 못 읽는다: " + p); }
} else if (inline) {
  sql = inline;
} else {
  die("SQL 도 --file= 도 없다");
}

const bare = strip(sql);

const ddl = bare.match(DDL);
if (ddl) {
  die(
    `스키마 변경(${ddl[1].toUpperCase()})은 이 경로로 하지 않는다.\n` +
    "  · 콘솔 소유 표  → migrations/ 에 파일을 더하고 `npm run migrate`\n" +
    "  · 남의 표        → 소유자에게 요청한다 (marketplace/ · ASAC-DAG)\n" +
    "  근거: CLAUDE.md §4·§6 · decision/0007(증분) · decision/0015"
  );
}

// 데이터 쓰기 자체는 허용이지만, 남의 표를 만지는 건 눈에 보이게 한다.
const writes = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(bare);
if (writes) {
  for (const [owner, tables] of Object.entries(FOREIGN)) {
    const hit = tables.filter((t) => new RegExp("\\b" + t + "\\b", "i").test(bare));
    if (hit.length) {
      console.error(`d1: ⚠️  ${owner} 소유 표에 쓴다 — ${hit.join(" · ")}`);
      console.error("d1:    데이터 쓰기는 허용되지만 정본은 저쪽이다. 스키마는 못 바꾼다.");
    }
  }
  console.error("d1: ⚠️  운영 D1 에 쓰는 중이다. 되돌릴 수 없는 문장인지 확인할 것.");
}

// 인라인 SQL 은 `--command` 로 감싼다 — 맨 인자로 넘기면 wrangler 가 "Unknown arguments"
// 로 거절한다. `--file=` 이면 그대로 흘려보낸다(이미 플래그 형태다).
const passthru = fileArg ? argv : argv.filter((a) => a !== inline);
const sqlArgs = fileArg ? [] : ["--command", inline];

// wrangler 의 bin 을 **node 로 직접** 부른다. `npx` + `shell:true` 를 쓰면 Windows 에서
// 인자가 한 줄로 이어 붙으면서 공백 있는 SQL 이 토막 난다("--command 가 없다"로 실패).
// 셸을 거치지 않으면 인자가 배열 그대로 전달돼 따옴표 문제가 생기지 않는다.
const BIN = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
const args = [BIN, "d1", "execute", DB, "--remote", ...sqlArgs, ...passthru];
console.error(`d1: ${DB} (운영 · 원격)`);
const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
