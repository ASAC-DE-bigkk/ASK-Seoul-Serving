#!/usr/bin/env node
/**
 * preflight-d1 — 원격 D1 에 마이그레이션을 적용해도 되는지 **먼저 본다.**
 *
 * ## 왜 있나
 *
 * `wrangler d1 migrations apply` 는 되돌리기가 어렵다. 특히 원격 prod D1 은 62개 제품이
 * 사는 파이프라인의 DB 이고, **D1 Time Travel 은 테이블 단위가 아니라 DB 전체를 덮어쓴다**
 * — 제품 publish 하나를 되돌리면 발급된 키·쿼터·요청 로그가 같이 과거로 간다(ASAC-DAG#476).
 * 그래서 "일단 돌려 보고 안 되면 되돌린다"가 성립하지 않는다.
 *
 * 그리고 우리는 이미 한 번 당했다 — `0004_request_id.sql` 의 조건 없는 `ALTER` 가
 * **남의 표에 얹혔다**(dev D1 실측). `CREATE TABLE IF NOT EXISTS` 는 이름이 같으면
 * **모양이 달라도 조용히 넘어가기** 때문이다.
 *
 * ## 무엇을 보나 — 이름이 아니라 **모양**
 *
 * 표가 "있나"만 보면 위 사고를 못 잡는다. 이름은 같은데 컬럼이 다른 표가 실제로 있었다.
 * 그래서 **컬럼 이름 집합**까지 비교한다.
 *
 * | 판정 | 뜻 | 배포 |
 * |---|---|---|
 * | 없음      | 표가 없다 — apply 가 새로 만든다            | 진행 |
 * | 일치      | 있고 모양이 같다                            | 진행 |
 * | 모양 다름 | 있는데 컬럼이 다르다                        | **중단** |
 * | 남의 표   | 우리 소유가 아니다. 다른 게 정상이다        | 감시만 |
 * | **오염**  | 남의 표에 **우리 컬럼이 얹혔다**            | **중단** |
 * | 인수됨    | 남의 표가 우리 모양이 됐다 — 이름을 뺏었다  | **중단** |
 *
 * '오염'이 없으면 이 검사는 **이미 일어난 사고를 통과시킨다.** `0004` 가 dev 의 남의 표에
 * 붙인 `request_id` 는 우리 스키마 **전부**가 아니라서 '인수됨'에 안 걸린다. 그래서
 * 남의 표마다 `baseline`(원래 모양)을 함께 두고 `우리 컬럼 ∩ 실제 − baseline` 을 본다.
 *
 * ## 기대 모양은 어디서 오나 — **마이그레이션 파일 자체**
 *
 * 하드코딩하면 마이그레이션이 늘 때마다 어긋난다. 그래서 `migrations/*.sql` 을
 * **인메모리 sqlite 에 그대로 적용**하고 그 결과 스키마를 기대값으로 쓴다. 정의가 하나뿐이라
 * 드리프트가 원천적으로 안 생긴다. (원격·로컬 D1 을 전혀 건드리지 않는다.)
 *
 * ## 사용
 *
 *   npm run preflight -- <DB이름>
 *   npm run preflight -- <DB이름> --env production
 *   npm run preflight -- <DB이름> --env dev --require-applied
 *   npm run preflight -- <DB이름> --env production --json
 *
 * 종료 코드: 0 진행 가능 · 1 **중단**(모양 다름·오염·인수됨) · 2 검사 자체 실패(권한·네트워크 등)
 *
 * 중단된 뒤에는 **사람이 정한다.** 정하고 나서 진행할 때만 사유를 남겨 통과시킨다:
 *
 *   npm run preflight -- <DB이름> --env production --ack "#52 합의: transit 소유라 그대로 둔다"
 *
 * `--ack` 는 **판정을 없던 일로 만들지 않는다** — 그대로 출력하고, 사유를 함께 찍고,
 * 종료 코드만 0 으로 바꾼다. 기록이 남아야 다음 사람이 "왜 통과시켰나"를 안다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");

// ── 남의 표 ────────────────────────────────────────────────────────────────────
// 우리 마이그레이션이 만들지만 **원격에서는 다른 주체가 이미 쓰고 있는** 이름.
// 모양이 다른 게 정상이고, 우리가 손대면 사고다. 실측(2026-08-04): transit 워커가
// (ts, path, query, token) 4컬럼으로 쓰고 있다 — ASK-Seoul-Serving#44 §2.
//
// 여기 이름을 올린다고 안전해지는 게 아니다. **우리 코드가 그 이름을 안 쓰는 것**이
// 안전의 근거이고(→ _gateway_request_log 개명), 이 목록은 그 상태를 감시하는 장치다.
//
// `baseline` 은 **남의 표의 원래 모양**이다(실측 사본). 이게 있어야 "우리가 얹은 컬럼"을
// 골라낼 수 있다 — 단순 교집합으로는 못 가린다. `ts` 는 우리 스키마에도 남의 표에도 있어서
// 교집합만 보면 멀쩡한 prod 도 오염으로 잡힌다. `우리 컬럼 ∩ 실제 − baseline` 이 정확하다.
const FOREIGN = new Map([
  ["_request_log", {
    why: "transit 워커 소유 (#44 §2). 우리는 _gateway_request_log 를 쓴다",
    baseline: ["ts", "path", "query", "token"],   // 실측 2026-08-04 prod (읽기만)
  }],
]);

// ── 기대 스키마 = 마이그레이션을 실제로 적용한 결과 ────────────────────────────
async function expectedSchema() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return null; }   // Node 22.5 미만 — 호출부가 여기서 멈춘다

  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    // 마이그레이션은 여러 문장이라 exec 로 통째 실행한다. 여기서 죽으면 파일이 깨진 것이라
    // 원격에 돌리기 전에 아는 편이 낫다 — 그것 자체가 이 검사의 값어치다.
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  const out = new Map();
  for (const { name } of db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((r) => r.name);
    out.set(name, new Set(cols));
  }
  db.close();
  return out;
}

// ── 원격 D1 실측 ──────────────────────────────────────────────────────────────
// 읽기만 한다(sqlite_master · pragma). 쓰기 문장을 이 파일에서 만들지 않는다.
// 한 문장에 넣을 표 개수. D1 원격 query 는 compound SELECT 가 6항이 되면
// `too many terms in compound SELECT` 로 거절한다(2026-08-05 dev 실측). 길이가 짧아도
// 항 개수 제한에 먼저 걸리므로 최대 5개씩 조각낸다.
const CHUNK = 5;

function columnSchemaQueries(names) {
  const queries = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    queries.push(names.slice(i, i + CHUNK)
      .map((n) => `SELECT '${n}' AS tbl, name AS col FROM pragma_table_info('${n}')`)
      .join(" UNION ALL "));
  }
  return queries;
}

function remoteSchema(dbName, envFlag, interesting) {
  // ⚠️ D1 은 `pragma_table_info(m.name)` 처럼 **인자가 리터럴이 아닌** pragma 함수를 막는다
  //    (`SQLITE_AUTH [7500]`, 실측). 그래서 한 방에 못 뽑고 두 번에 나눈다:
  //      ① sqlite_master 에서 표 이름을 받고
  //      ② 그 이름들을 **리터럴로 박은** UNION ALL 문장으로 컬럼을 받는다
  //    ②의 이름은 사용자 입력이 아니라 ①의 결과지만, 그래도 화이트리스트로 한 번 거른다 —
  //    입력을 SQL 식별자로 쓰는 자리는 예외 없이 같은 규율을 지킨다(게이트웨이 규약과 동일).
  const all = queryD1(dbName, envFlag,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map((r) => r.name).filter((n) => /^[A-Za-z0-9_]+$/.test(n));

  // **우리가 관심 있는 표만 묻는다.** 실측 dev D1 에는 표가 89개인데(제품 표 62종 포함)
  // 전부 물으면 문장이 길어져 API 가 거절한다. 그리고 남의 제품 표 스키마는 우리 관심사도 아니다.
  const names = all.filter((n) => interesting.has(n));

  const out = new Map();
  for (const sql of columnSchemaQueries(names)) {
    for (const r of queryD1(dbName, envFlag, sql)) {
      if (!out.has(r.tbl)) out.set(r.tbl, new Set());
      out.get(r.tbl).add(r.col);
    }
  }
  // 이름은 있는데 컬럼이 안 온 표도 빈 집합으로 남겨 '없음'과 구분한다
  for (const n of names) if (!out.has(n)) out.set(n, new Set());
  return out;
}

function queryD1(dbName, envFlag, sql) {
  const args = ["d1", "execute", dbName, "--remote", "--json", "--command", sql];
  if (envFlag) args.push("--env", envFlag);

  // 주의: `npx wrangler …` 로 부르지 않는다. Windows 에서 npx·wrangler 는 .cmd 래퍼라
  // Node 20+ 가 execFileSync 로 실행하는 것을 막는다(CVE-2024-27980 대응, EINVAL).
  // shell:true 로 우회하면 이번엔 **SQL 의 따옴표가 셸마다 다르게 깨진다.**
  // 그래서 wrangler 의 JS 진입점을 현재 node 로 직접 돌린다 — 셸을 아예 안 거치므로
  // 인자가 그대로 전달되고, 플랫폼 차이도 사라진다.
  const cli = join(HERE, "..", "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(cli)) {
    throw new Error(`wrangler 를 찾지 못했다 — npm install 을 먼저 하십시오\n  찾은 곳: ${cli}`);
  }

  let raw;
  try {
    raw = execFileSync(process.execPath, [cli, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // wrangler 는 실패해도 stdout 에 `{"error": …}` 를 남긴다. Windows 에서는 그 뒤에
    // libuv 어서션(UV_HANDLE_CLOSING)으로 죽어 종료 코드가 쓰레기가 되므로,
    // **종료 코드가 아니라 남긴 내용**을 먼저 본다.
    raw = (e.stdout || "").toString();
    const said = (() => {
      try { return JSON.parse(raw).error?.text || ""; } catch { return ""; }
    })();

    if (/CLOUDFLARE_API_TOKEN/.test(said)) {
      throw new Error(
        "자격증명이 없습니다 — 이 디렉터리에서 원격 D1 을 못 읽습니다.\n\n" +
        "  wrangler 는 비대화 환경에서 CLOUDFLARE_API_TOKEN 을 요구합니다.\n" +
        "  실측(2026-08-04): 자격증명이 ops-dashboard/.env 에만 있고 marketplace/ 에는 없습니다.\n\n" +
        "  할 일 — marketplace/.env 를 만들고 아래 둘을 넣으십시오(.env.example 참고):\n" +
        "    CLOUDFLARE_API_TOKEN=...\n" +
        "    CLOUDFLARE_ACCOUNT_ID=...\n\n" +
        "  읽기 검사만 하려면 토큰 권한은 D1:Read 로 충분합니다.\n" +
        "  .env 는 커밋하지 않습니다(.gitignore 에 이미 있음)."
      );
    }
    const detail = (said || e.stderr || raw || e.message || "").toString()
      .trim().split("\n").slice(-6).join("\n");
    throw new Error(`원격 조회 실패 — DB 이름·권한·네트워크를 확인할 것\n${detail}`);
  }
  // wrangler 가 JSON 앞뒤에 안내 문구를 섞는 경우가 있어 배열 부분만 떼어낸다
  const at = raw.indexOf("[");
  if (at < 0) throw new Error(`응답에서 JSON 을 찾지 못했다:\n${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw.slice(at));
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results || []);
}

// ── 판정 ──────────────────────────────────────────────────────────────────────
function judge(expected, remote, { requireApplied = false } = {}) {
  const findings = [];

  for (const [tbl, want] of expected) {
    const have = remote.get(tbl);
    const foreign = FOREIGN.get(tbl);

    if (foreign) {
      // 남의 표 — 모양이 다른 게 정상이다. 이상 신호는 둘이다.
      //   ① 인수됨   : 우리 스키마를 **전부** 갖췄다 = 이름을 통째로 차지했다
      //   ② 오염     : 우리 컬럼이 **하나라도** 얹혔다 = 우리 마이그레이션이 남의 표를 건드렸다
      //
      // ②가 없으면 이 검사는 **이미 일어난 사고를 통과시킨다.** dev 의 `_request_log` 가
      // 그 상태다 — `0004` 의 조건 없는 ALTER 가 `request_id` 를 붙였는데, 우리 스키마를
      // 전부 갖춘 건 아니라서 ①에 안 걸린다. 이 스크립트를 만든 이유가 그 사고인데
      // 그 사고가 난 DB 를 정상으로 판정하던 자리다.
      const baseline = new Set(foreign.baseline || []);
      const ours = have ? [...want].filter((c) => have.has(c) && !baseline.has(c)) : [];
      const taken = Boolean(have) && [...want].every((c) => have.has(c));
      const verdict = !have ? "없음" : taken ? "인수됨" : ours.length ? "오염" : "남의 표";
      const note =
        verdict === "인수됨" ? `우리 스키마가 이 이름을 차지했다 — ${foreign.why}` :
        verdict === "오염" ? `우리 컬럼이 얹혀 있다: ${ours.join(", ")} — 원래 모양은 ` +
          `${[...baseline].join(", ")} (${foreign.why})` :
        foreign.why;
      findings.push({
        table: tbl, verdict, blocking: taken || verdict === "오염", note,
        expected: [...want], actual: have ? [...have] : null,
        baseline: [...baseline], contaminated: ours,
      });
      continue;
    }

    if (!have) {
      findings.push({ table: tbl, verdict: "없음", blocking: requireApplied,
        note: requireApplied ? "배포 전에 migrations apply 가 필요하다" : "apply 가 새로 만든다",
        expected: [...want], actual: null, requiredForDeploy: requireApplied });
      continue;
    }

    // **모양 비교** — 있으면 그만이 아니다. 없는 컬럼이 하나라도 있으면 중단.
    const missing = [...want].filter((c) => !have.has(c));
    const extra = [...have].filter((c) => !want.has(c));
    if (missing.length) {
      findings.push({ table: tbl, verdict: "모양 다름", blocking: true,
        note: `필요한 컬럼이 없다: ${missing.join(", ")}` +
              (extra.length ? ` · 모르는 컬럼: ${extra.join(", ")}` : ""),
        expected: [...want], actual: [...have] });
    } else if (extra.length) {
      // 컬럼이 더 있는 건 막지 않는다 — 증분 규약이 "추가만"이라 앞선 배포가 더 갔을 수 있다.
      findings.push({ table: tbl, verdict: "일치+", blocking: false,
        note: `모르는 컬럼 ${extra.length}개: ${extra.join(", ")} — 증분 규약상 추가는 허용`,
        expected: [...want], actual: [...have] });
    } else {
      findings.push({ table: tbl, verdict: "일치", blocking: false, note: "",
        expected: [...want], actual: [...have] });
    }
  }
  return findings;
}

// ── 출력 ──────────────────────────────────────────────────────────────────────
// 판정을 늘리면 여기도 늘린다 — 빠지면 표에 `undefined` 가 찍힌다(실제로 겪었다).
const MARK = { "없음": "· ", "일치": "OK", "일치+": "OK", "모양 다름": "!!", "남의 표": "~ ", "오염": "!!", "인수됨": "!!" };

function report(findings, { db, env, ack, requireApplied }) {
  const w = Math.max(...findings.map((f) => f.table.length), 12);
  console.log(`\n원격 D1 배포 전 검사 — ${db}${env ? ` (--env ${env})` : ""}\n`);
  console.log(`  ${"표".padEnd(w)}  판정        비고`);
  console.log(`  ${"-".repeat(w)}  ----------  ${"-".repeat(52)}`);
  for (const f of findings) {
    console.log(`  ${f.table.padEnd(w)}  ${MARK[f.verdict]} ${f.verdict.padEnd(7)}  ${f.note}`);
  }

  const blocked = findings.filter((f) => f.blocking);
  console.log("");
  if (!blocked.length) {
    console.log(requireApplied
      ? "[OK] 배포 가능 — 필수 Gateway 테이블이 모두 적용돼 있다"
      : "[OK] 진행 가능 — 다음은 장부 백필, 그다음 migrations apply");
    console.log("     절차: docs/deploy-runbook.md §0·§1\n");
    return 0;
  }

  const unapplied = blocked.filter((f) => f.requiredForDeploy);
  if (unapplied.length) {
    console.log("[중단] Gateway 마이그레이션이 끝나지 않았습니다 — route 배포 전에 §1을 실행하십시오.\n");
  }

  // 오염은 "이대로 가면 생길 일"이 아니라 **이미 일어난 일**이라, 안내가 달라야 한다.
  const contaminated = blocked.filter((f) => f.verdict === "오염");
  console.log(contaminated.length
    ? "[중단] 남의 표에 우리 컬럼이 얹혀 있습니다 — **이미 일어난 일**입니다. 배포보다 이것부터 정리합니다.\n"
    : "[중단] 표의 모양이 기대와 다릅니다. 배포를 진행하지 마십시오.\n");
  for (const f of blocked) {
    console.log(`  [${f.table}] ${f.note}`);
    console.log(`     기대: ${f.expected.join(", ")}`);
    console.log(`     실제: ${f.actual ? f.actual.join(", ") : "(없음)"}\n`);
  }
  if (requireApplied) {
    console.log("다음에 할 일: docs/deploy-runbook.md §1의 장부 백필 → migrations apply → 사후 검사를 실행한다.");
    console.log("  --require-applied 는 --ack 로 우회할 수 없습니다.\n");
    return 1;
  }
  if (contaminated.length) {
    console.log("어떻게 생겼나: 장부(d1_migrations)가 빈 D1 에 apply 를 돌리면 0001 부터 재실행되고,");
    console.log("  조건을 달 수 없는 0004(ALTER … ADD COLUMN)가 그 이름의 표에 컬럼을 붙입니다.");
    console.log("  지금은 백필(scripts/backfill-migrations-ledger.sql)이 route 컬럼 유무로 우리 표인지를");
    console.log("  가려 재발을 막습니다(PR #50) — 남아 있는 컬럼은 그 이전에 붙은 것입니다.\n");
    console.log("정리 방향: 우리가 만든 컬럼이므로 **소유자(#52 §5)와 합의해 우리가 걷어냅니다.**");
    console.log("  다만 DROP COLUMN 은 남의 표를 고치는 일이라 쓰는 쪽 합의가 먼저이고, NULL 만 든");
    console.log("  컬럼이라 **그대로 두는 것도 선택지**입니다. 어느 쪽이든 결정을 #52 에 적고");
    console.log("  --ack 로 통과시킵니다 — 그래야 다음 사람이 '왜 통과시켰나'를 압니다.\n");
  }
  // 아래 안내는 **'모양 다름'용**이다. 오염만 걸린 경우까지 같이 찍으면 "이대로 apply 하면
  // 남의 표에 컬럼이 얹힙니다"를 이미 얹힌 상태에서 읽게 되고, 위 설명과 앞뒤가 안 맞는다.
  if (blocked.some((f) => f.verdict !== "오염")) {
    console.log("이대로 apply 하면:");
    console.log("  · CREATE TABLE IF NOT EXISTS 가 조용히 넘어가고, 게이트웨이 INSERT 가");
    console.log("    ctx.waitUntil 안에서 실패해 **요청 로그가 전량 버려집니다**.");
    console.log("  · 조건 없는 ALTER 가 있으면 **남의 표에 컬럼이 얹힙니다** (dev D1 에서 실제로 일어남).\n");
    console.log("다음에 할 일:");
    console.log("  1. 위 표가 누구 것인지 확인한다 (ASK-Seoul-Serving#52 §5 소유 경계)");
    console.log("  2. 이름을 비킬지 / 스키마를 맞출지 **사람이 정한다**");
    console.log("  3. 정하고 나면 그 결정을 문서(#52)에 적고, 사유를 달아 다시 돌린다:");
  }
  console.log(`정하고 나서 진행할 때: npm run preflight -- ${db}${env ? ` --env ${env}` : ""} --ack "<결정과 근거>"\n`);

  if (ack && !requireApplied) {
    console.log("[통과] --ack 로 통과시킵니다 — 위 판정은 없던 일이 되지 않습니다.");
    console.log(`       사유: ${ack}\n`);
    return 0;
  }
  return 1;
}

// ── 진입 ──────────────────────────────────────────────────────────────────────
async function main(argv) {
  const args = argv.slice(2);
  const db = args.find((a) => !a.startsWith("--"));
  const env = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;
  const ack = args.includes("--ack") ? args[args.indexOf("--ack") + 1] : null;
  const asJson = args.includes("--json");
  const requireApplied = args.includes("--require-applied");

  if (!db) {
    console.error('사용: npm run preflight -- <DB이름> [--env production] [--require-applied] [--ack "사유"] [--json]');
    return 2;
  }
  if (requireApplied && ack) {
    console.error("[중단] --require-applied 는 --ack 로 우회할 수 없습니다. 마이그레이션을 먼저 적용하십시오.");
    return 2;
  }

  const expected = await expectedSchema();
  if (!expected) {
    console.error("[중단] node:sqlite 가 없습니다 (Node 22.5+ 필요).");
    console.error("       기대 스키마를 마이그레이션에서 뽑을 수 없어 **모양 검사를 할 수 없습니다.**");
    console.error("       이름만 보고 넘어가면 이 스크립트가 막으려는 사고를 그대로 통과시키므로,");
    console.error("       여기서 멈춥니다. Node 를 올리고 다시 돌리십시오.");
    return 2;
  }

  let remote;
  try { remote = remoteSchema(db, env, new Set(expected.keys())); }
  catch (e) { console.error(`[실패] ${e.message}`); return 2; }

  const findings = judge(expected, remote, { requireApplied });
  if (asJson) {
    const blocked = findings.some((f) => f.blocking);
    const ok = !blocked || (!requireApplied && Boolean(ack));
    console.log(JSON.stringify({ db, env, mode: requireApplied ? "deploy" : "migrate", ok, ack, findings }, null, 2));
    return ok ? 0 : 1;
  }
  return report(findings, { db, env, ack, requireApplied });
}

// 테스트에서 판정 로직만 따로 부르기 위해 내보낸다 — 원격을 타지 않는 부분이다.
export { judge, expectedSchema, FOREIGN, columnSchemaQueries };

if (process.argv[1] && process.argv[1].endsWith("preflight-d1.mjs")) {
  process.exit(await main(process.argv));
}
