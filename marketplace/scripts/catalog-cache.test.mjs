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

// D1 스텁 — 어떤 표를 몇 번 읽었는지 센다. 캐시 판정의 근거가 그 횟수다.
function stubDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      const rows = sql.includes("FROM _catalog") ? [CATALOG_ROW] : [];
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
