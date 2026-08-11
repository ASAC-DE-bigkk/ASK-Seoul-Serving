// `route="page"` 배선 계약 (#285 · #177 · agreement §3-1-1).
//
// 이 배선의 핵심은 **두 집합이 다르다**는 것이다:
//   워커 통과 4경로  `/llms.txt` · `/robots.txt` · `/openapi.json` · `/skill-openapi.json`
//   관측 3경로       `/llms.txt` ·               `/openapi.json` · `/skill-openapi.json`
//
// `robots.txt` 가 워커를 지나는 건 charset 사고(#237) 때문이지 관측 의도가 아니다. 통과
// 사유와 적재 사유를 섞으면 나중에 "왜 이건 세고 저건 안 세나"를 못 답한다. 그래서 그 차이를
// 코드가 아니라 **테스트가 지킨다** — 누가 `LOGGED_PAGES` 에 robots 를 더하면 여기서 걸린다.
//
// 🔴 그리고 `serveAsset` 이 `.json` 에 `text/plain` 을 씌우면 **문서가 통째로 깨진다.**
//    charset 교정은 텍스트 둘에만 걸려야 한다 — 그게 이 파일의 두 번째 이유다.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ASSET_BODY = {
  "/llms.txt": "# ASK SEOUL\n한글이 있는 문서",
  "/robots.txt": "User-agent: *\nAllow: /",
  "/openapi.json": '{"openapi":"3.1.0"}',
  "/skill-openapi.json": '{"openapi":"3.1.0","x-skill":true}',
};

// Assets 스텁 — CF 가 `.txt` 에 euc-kr 을 붙이던 실사고를 흉내 낸다(그래야 교정이 검증된다).
function stubEnv(logs) {
  return {
    ASK_ENV: "prod",
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const type = path.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=euc-kr";
        return new Response(ASSET_BODY[path] ?? "", {
          headers: { "content-type": type, "x-content-type-options": "nosniff" },
        });
      },
    },
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return { async run() { logs.push({ sql, binds }); return { success: true }; } };
          },
          async run() { logs.push({ sql, binds: [] }); return { success: true }; },
        };
      },
    },
  };
}

async function get(path, logs) {
  const ctx = { waitUntil: (p) => p };
  return worker.fetch(new Request("https://ask-seoul.kr" + path), stubEnv(logs), ctx);
}

function logged(logs) {
  return logs.filter((l) => l.sql.includes("INSERT INTO _gateway_request_log"));
}

test("기계 문서 3종은 route=page 로 세고, page_path 에 경로 원문이 실린다", async () => {
  for (const path of ["/llms.txt", "/openapi.json", "/skill-openapi.json"]) {
    const logs = [];
    const res = await get(path, logs);
    assert.equal(res.status, 200, path);

    const rows = logged(logs);
    assert.equal(rows.length, 1, `${path} 이 로그를 한 행 남겨야 한다`);
    const { sql, binds } = rows[0];
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
    const at = (name) => binds[cols.indexOf(name)];
    assert.equal(at("route"), "page", path);
    assert.equal(at("page_path"), path, "정규화하지 않고 그대로");
    // 콘솔 `AXIS_BUCKET` 이 no_product 갈래로 넣는 근거(#177 §3)
    assert.equal(at("product_id"), null);
    assert.equal(at("table_name"), null);
  }
});

test("🔴 robots.txt 는 워커를 지나지만 세지 않는다 — 통과 사유와 적재 사유는 다르다", async () => {
  const logs = [];
  const res = await get("/robots.txt", logs);
  assert.equal(res.status, 200);
  assert.equal(logged(logs).length, 0,
    "robots.txt 는 charset 때문에 통과할 뿐이다 — 세면 기계 문서 신호가 크롤러 잡음에 묻힌다");
});

test("🔴 JSON 문서에 text/plain 을 씌우지 않는다 — 씌우면 문서가 깨진다", async () => {
  for (const path of ["/openapi.json", "/skill-openapi.json"]) {
    const res = await get(path, []);
    assert.match(res.headers.get("content-type"), /application\/json/, path);
    assert.equal(await res.text(), ASSET_BODY[path], "본문이 원본 그대로여야 한다");
  }
});

test("텍스트 둘은 charset 이 utf-8 로 교정된다 (#237 회귀)", async () => {
  for (const path of ["/llms.txt", "/robots.txt"]) {
    const res = await get(path, []);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff",
      "_headers 의 보안 헤더가 살아 있어야 한다");
  }
});

test("사람 페이지는 page_path 대상이 아니다 — 부팅 API 로 이미 세어진다", async () => {
  // `/` 와 `/catalog` 는 run_worker_first 밖이라 워커에 닿지도 않는다. 여기서는 "워커가
  // 그 경로를 page 로 세지 않는다"만 못박는다(닿더라도 세면 같은 방문을 두 번 센다).
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url), "utf8");
  const set = src.slice(src.indexOf("const LOGGED_PAGES"), src.indexOf("const WORKER_SERVED_ASSETS"));
  for (const p of ['"/"', '"/catalog"', '"/docs"', '"/robots.txt"'])
    assert.ok(!set.includes(p), `LOGGED_PAGES 에 ${p} 가 있으면 안 된다`);
});
