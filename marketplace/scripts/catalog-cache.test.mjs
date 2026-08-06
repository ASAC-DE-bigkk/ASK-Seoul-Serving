// 카탈로그 엣지 캐시 회귀 테스트.
//
// 카탈로그는 발행할 때만 바뀌는데 방문마다 D1 을 세 번 치고 414KB 를 새로 만들고 있었다
// (실측 2026-08-06: 배포본 1.8s · 정적 경로 0.51s). 캐시가 붙었으니 **두 번째 호출이 D1 을
// 다시 치지 않는다**는 것과, 그래도 **응답 내용은 같다**는 것을 못박는다.
//
// 캐시는 성능이지 계약이 아니다 — Cache API 가 없는 실행기에서도 그대로 동작해야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { catalogCacheKey } from "../src/index.js";

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

    // 캐시 히트도 같은 헤더여야 한다 — 사본은 stale 을 꺼내려고 긴 max-age 를 달고 있는데
    // 그대로 나가면 브라우저가 10분을 들고 있고 내부 표식이 응답에 샌다(실측으로 잡았다).
    const hit = await call(stubDb());
    assert.equal(hit.headers.get("cache-control"), "public, max-age=60");
    assert.equal(hit.headers.get("x-cached-at"), null, "내부 표식이 새면 안 된다");
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

// ── stale-while-revalidate · 병렬 질의 (2026-08-06 2차) ───────────────────────
// 60초 TTL 만으로는 거의 안 들었다: 사람은 띄엄띄엄 들어와서 대부분 콜드를 맞는다
// (실측 — curl 연타 0.014s, 1분 뒤 브라우저 진입 4.5s). 그래서 ①콜드 자체를 낮추고
// (병렬) ②만료돼도 기다리게 하지 않는다(SWR).

const withCaches = async (stub, fn) => {
  const prev = globalThis.caches;
  globalThis.caches = stub;
  try { return await fn(); } finally { globalThis.caches = prev; }
};

/** 캐시에 나이 든 사본을 직접 심는다 — 시계를 돌리지 않고 만료 상태를 만든다. */
function seedAged(stub, ageSeconds, body = { products: [{ product_id: "stale_one" }] }, env = {}) {
  const res = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-cached-at": String(Date.now() - ageSeconds * 1000),
    },
  });
  // 키를 여기 적지 않고 정본에서 가져온다 — 축이 하나 더 섞이면 이 파일이 조용히 어긋난다.
  return stub.default.put(new Request(catalogCacheKey(env)), res);
}

const callWithCtx = (db, ctx) => worker.fetch(
  new Request("https://marketplace.example.test/api/v1/catalog"),
  { DB: db, ASK_ENV: "dev" },
  ctx,
);

test("만료된 사본은 **기다리게 하지 않는다** — 옛것을 즉시 주고 뒤에서 갱신한다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    await seedAged(stub, 120);              // TTL 60 초과, stale 한도 600 이내
    const db = stubDb();
    const pending = [];
    const res = await callWithCtx(db, { waitUntil: (p) => pending.push(p) });

    const body = await res.json();
    assert.equal(body.products[0].product_id, "stale_one", "응답은 옛 사본이어야 한다");
    // waitUntil 은 둘이다 — 카탈로그 갱신 + 요청 로그 기록(라우터가 늘 건다)
    assert.ok(pending.length >= 1, `갱신이 waitUntil 로 예약돼야 한다 (실제 ${pending.length})`);

    await Promise.all(pending);
    assert.equal(catalogReads(db), 1, "예약된 갱신이 실제로 D1 을 읽는다");
  });
});

test("waitUntil 이 없으면 갱신을 띄우지 않는다 — 취소될 약속을 남기지 않는다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    await seedAged(stub, 120);
    const db = stubDb();
    const res = await callWithCtx(db, {});      // ctx 는 있는데 waitUntil 이 없다

    assert.equal((await res.json()).products[0].product_id, "stale_one");
    assert.equal(catalogReads(db), 0, "그래도 응답은 즉시 나간다");
  });
});

test("stale 한도를 넘긴 사본은 쓰지 않는다 — 새로 만든다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    await seedAged(stub, 7200);             // 2시간 — stale 한도 600 초과
    const db = stubDb();
    const res = await callWithCtx(db, { waitUntil() {} });

    assert.equal(catalogReads(db), 1, "새로 만들어야 한다");
    assert.equal((await res.json()).products[0].product_id, "culture_activity_by_dong");
  });
});

test("다섯 질의를 **동시에** 띄운다 — 줄세우면 D1 왕복이 그대로 더해진다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    const issued = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const db = {
      calls: [],
      prepare(sql) {
        db.calls.push(sql);
        issued.push(sql);
        const rows = sql.includes("FROM _catalog") ? [CATALOG_ROW] : [];
        // 모든 질의가 같은 게이트에서 대기한다 — 순차라면 첫 질의가 안 풀려 두 번째가 안 뜬다
        const all = async () => { await gate; return { results: rows }; };
        return { all, first: async () => rows[0] ?? null, run: async () => ({}) };
      },
    };
    const p = callWithCtx(db, { waitUntil() {} });
    await new Promise((r) => setImmediate(r));

    assert.equal(issued.length, 5, `다섯 질의가 모두 떠 있어야 한다 (실제 ${issued.length})`);
    release();
    assert.equal((await p).status, 200);
  });
});

test("만료돼도 응답은 갱신을 **기다리지 않는다** — 갱신이 매달려 있어도 즉시 나간다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    await seedAged(stub, 120);
    let release;
    const gate = new Promise((r) => { release = r; });
    const db = {
      calls: [],
      prepare(sql) {
        db.calls.push(sql);
        const rows = sql.includes("FROM _catalog") ? [CATALOG_ROW] : [];
        return { all: async () => { await gate; return { results: rows }; },
                 first: async () => rows[0] ?? null, run: async () => ({}) };
      },
    };
    const pending = [];
    // 갱신 질의를 **풀어 주지 않은 채** 응답을 기다린다 — 블로킹이면 여기서 멈춘다
    const res = await callWithCtx(db, { waitUntil: (p) => pending.push(p) });

    assert.equal((await res.json()).products[0].product_id, "stale_one");
    assert.ok(pending.length >= 1);
    release();
    await Promise.all(pending);
  });
});

// ── 정책 전환이 캐시에 갇히지 않는다 (#110 ②) ────────────────────────────────
//
// 🐛 실측으로 걸린 버그다(2026-08-06). 응답 본문에 `key_issuance` 가 들어 있는데 캐시 키에는
// 발급 방식이 안 섞여 있어서, Google 발급을 켠 직후에도 캐시가 옛 값("email")을 최대 10분간
// 줬다. 그 사이 화면은 이메일 폼을 띄우고 제출은 403 을 받는다 — **엣지 캐시는 배포를 넘어
// 살아남으므로 prod 에서 그대로 재현될 문제였다.**
//
// 고친 방식은 캐시를 지우는 게 아니라 **키를 가르는 것**이다. 이 테스트가 지키는 건
// "정책이 다르면 다른 칸을 본다" 하나다.
test("발급 방식이 바뀌면 캐시 칸도 바뀐다 — 정책 전환이 캐시에 갇히지 않는다", () => {
  const email = catalogCacheKey({});
  const oauth = catalogCacheKey({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
  assert.notEqual(email, oauth);
  // 반쪽 설정은 미설정과 같은 칸이다 — isConfigured 가 둘 다 요구한다
  assert.equal(catalogCacheKey({ GOOGLE_CLIENT_ID: "id" }), email);
});

test("옛 방식으로 캐시된 사본을 새 방식이 이어받지 않는다", async () => {
  const stub = stubCaches();
  await withCaches(stub, async () => {
    // 이메일 발급 시절의 신선한 사본을 심는다
    await seedAged(stub, 1, { products: [{ product_id: "before_oauth" }] }, {});
    const db = stubDb();
    const oauthEnv = { DB: db, ASK_ENV: "dev", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    const res = await worker.fetch(
      new Request("https://marketplace.example.test/api/v1/catalog"), oauthEnv,
      { waitUntil: () => {} });
    const body = await res.json();
    // 옛 사본을 물었다면 before_oauth 가 나오고 key_issuance 도 email 이었을 것이다
    assert.notEqual(body.products?.[0]?.product_id, "before_oauth");
    assert.equal(body.key_issuance.method, "google_oauth");
  });
});
