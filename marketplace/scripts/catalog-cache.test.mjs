// 카탈로그 엣지 캐시 회귀 테스트.
//
// 카탈로그는 발행할 때만 바뀌는데 방문마다 D1 을 세 번 치고 414KB 를 새로 만들고 있었다
// (실측 2026-08-06: 배포본 1.8s · 정적 경로 0.51s). 캐시가 붙었으니 **두 번째 호출이 D1 을
// 다시 치지 않는다**는 것과, 그래도 **응답 내용은 같다**는 것을 못박는다.
//
// 캐시는 성능이지 계약이 아니다 — Cache API 가 없는 실행기에서도 그대로 동작해야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const CATALOG_ROW = {
  name: "gold_culture_activity_by_dong",
  product_id: "culture_activity_by_dong",
  external: 1,
  description: "행정동별 문화 활동",
  product_question: "어느 동네에 문화 활동이 몰리나?",
  time_axis: "event_date",
  columns: JSON.stringify([{ name: "admin_dong_code", type: "varchar" }]),
  row_count: 100,
  freshness: null,
  exported_at: "2026-08-06T01:21:00Z",
};

// 표시 메타(ASAC-DAG#706) — 손 사본을 대신하는 게시본. 두 번째 제품은 **미선언**이라
// display 가 null 로 나가야 한다(빈 문자열로 채우면 화면이 제목이 있는 척한다).
let DISPLAY_ROWS = [{
  product_id: "culture_activity_by_dong", title: "행정동별 일자 문화활동량",
  summary: "하루 단위 집계입니다.", caveat: "좌표 없는 활동은 빠집니다.",
  use_cases: '["생활권 문화 인프라 격차 분석","동 단위 문화 히트맵"]',
}];
let EXT_ROWS = [{ product_id: "culture_activity_by_dong", grain: "행정동마다 한 행" }];

// D1 스텁 — 어떤 표를 몇 번 읽었는지 센다. 캐시 판정의 근거가 그 횟수다.
function stubDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      let rows = [];
      if (sql.includes("FROM _catalog")) rows = [CATALOG_ROW];
      else if (sql.includes("FROM d1_catalog_display")) rows = DISPLAY_ROWS;
      else if (sql.includes("FROM d1_catalog_ext")) rows = EXT_ROWS;
      return { bind: () => ({ all: async () => ({ results: rows }), first: async () => rows[0] ?? null,
                              run: async () => ({}) }),
               all: async () => ({ results: rows }),
               first: async () => rows[0] ?? null,
               run: async () => ({}) };
    },
  };
}

// Cache API 최소 구현 — 실제 워커 런타임과 같은 계약(match/put)만 흉내낸다.
function stubCaches() {
  const store = new Map();
  return {
    default: {
      async match(req) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) { store.set(req.url, res.clone()); },
    },
    _size: () => store.size,
  };
}

const call = (db) => worker.fetch(
  new Request("https://marketplace.example.test/api/v1/catalog"),
  { DB: db, ASK_ENV: "dev" },
  { waitUntil() {} },
);

const catalogReads = (db) => db.calls.filter((s) => s.includes("FROM _catalog")).length;

test("두 번째 호출은 D1 을 다시 치지 않는다", async () => {
  const prev = globalThis.caches;
  globalThis.caches = stubCaches();
  try {
    const db = stubDb();
    const a = await call(db);
    assert.equal(a.status, 200);
    const readsAfterFirst = catalogReads(db);
    assert.equal(readsAfterFirst, 1, "첫 호출은 D1 을 읽는다");

    const b = await call(db);
    assert.equal(b.status, 200);
    assert.equal(catalogReads(db), readsAfterFirst, "두 번째 호출은 캐시에서 온다");

    // 내용이 같아야 캐시가 의미가 있다 — 빨라졌는데 다른 걸 주면 그건 버그다
    assert.deepEqual(await b.json(), await a.json());
  } finally { globalThis.caches = prev; }
});

test("응답이 스스로 수명을 밝힌다 — 브라우저·엣지가 같은 기준을 쓴다", async () => {
  const prev = globalThis.caches;
  globalThis.caches = stubCaches();
  try {
    const res = await call(stubDb());
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  } finally { globalThis.caches = prev; }
});

test("Cache API 가 없어도 그대로 동작한다 — 캐시는 성능이지 계약이 아니다", async () => {
  const prev = globalThis.caches;
  globalThis.caches = undefined;
  try {
    const db = stubDb();
    const a = await call(db);
    const b = await call(db);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(catalogReads(db), 2, "캐시가 없으면 매번 읽는다 — 실패가 아니라 정상 경로다");
    assert.deepEqual(await b.json(), await a.json());
  } finally { globalThis.caches = prev; }
});

test("카탈로그가 표시 메타와 그레인을 게시본에서 실어 온다", async () => {
  const prev = globalThis.caches;
  globalThis.caches = stubCaches();
  try {
    const body = await (await call(stubDb())).json();
    const p = body.products[0];
    assert.equal(p.display.title, "행정동별 일자 문화활동량");
    assert.equal(p.display.summary, "하루 단위 집계입니다.");
    assert.deepEqual(p.display.use_cases, ["생활권 문화 인프라 격차 분석", "동 단위 문화 히트맵"]);
    assert.equal(p.grain, "행정동마다 한 행");
  } finally { globalThis.caches = prev; }
});

test("미선언 제품은 display 가 null — 빈 값으로 꾸미지 않는다", async () => {
  const prev = globalThis.caches, rows = DISPLAY_ROWS;
  globalThis.caches = stubCaches();
  DISPLAY_ROWS = [];
  try {
    const body = await (await call(stubDb())).json();
    assert.equal(body.products[0].display, null);
  } finally { globalThis.caches = prev; DISPLAY_ROWS = rows; }
});

test("표가 아직 없어도 카탈로그는 그대로 나간다 — 관측 부재가 서빙을 막지 않는다", async () => {
  const prev = globalThis.caches;
  globalThis.caches = stubCaches();
  const db = stubDb();
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("d1_catalog_display")) {
      return { all: async () => { throw new Error("no such table"); } };
    }
    return orig(sql);
  };
  try {
    const res = await call(db);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].display, null);
  } finally { globalThis.caches = prev; }
});
