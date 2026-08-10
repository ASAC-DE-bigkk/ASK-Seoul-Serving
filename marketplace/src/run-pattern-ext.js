// src/run-pattern-ext.js — run_pattern 바인딩 변환: P1(기본값·허용값) + P3(배열 IN)
//
// #217 결정(2026-08-09) 1차 범위의 P1·P3 를 담는 순수 함수다. `handleRunPattern` 의
// 변환부(주석 제거 → SELECT/WITH 확인 → `:이름`→`?` → 값 해석·클램프)를 대체한다.
// 출처: `marketplace/prep/run-pattern-ext.mjs`(PR #232) `convertPattern` — 431패턴 변환
// 스윕 무회귀 검증본. P2(커서)·P4(함수목록)·P5(피벗)·P6(식별자 슬롯)은 **이식하지 않았다**
// (P2 는 2차 = P0-b 와 함께, P6 는 보류 — prep/ 에 그대로 남아 있다).
//
// 메타(defaults/enums/spec)의 정본은 dbt `meta.serving.usage_patterns[]` 선언이고,
// D1 `d1_pattern_params` 로 게시돼 여기로 온다. **파싱은 서버 이 한 곳**이다 — 플레이그라운드가
// `-- :n=10` 주석을 따로 해석하던 관례는 제품 번들 응답(`v1.js`)의 선언값으로 대체된다(#219).
//
// 보안 불변식: 값은 전부 `?` bind(식별자 치환 없음). 기본값은 게시자 선언 상수라 소비자
// 입력이 아니고, 배열 원소도 각각 값 bind 라 인젝션 표면 증가가 0 이다(#192 §1 P1·P3).

const LIMIT_PARAM = /^(n|limit|top_n)$/i;
const ARRAY_HARD_CAP = 100;              // 카티전 팬아웃 상한 — spec.max_len 은 이걸 넘을 수 없다
const problem = (status, title, detail) => ({ ok: false, problem: { status, title, detail } });

// sql + 소비자 값 + 게시 메타 → { ok, converted, values, declared, defaulted } | { ok:false, problem }
//   opts.defaults: { name: scalar }            — P1 미전달 시 이 상수로 bind
//   opts.enums:    { name: [scalar, …] }       — P1 허용값 밖이면 400(센티널 오타의 조용한 0행 제거)
//   opts.spec:     { name: {type, item, max_len} } — P3 타입 선언(array 는 ?,?,? 전개)
//   opts.maxLimit: 행수 파라미터(n/limit/top_n) 클램프 상한 — index.js MAX_LIMIT 을 그대로 받는다
export function convertPattern(sql, supplied, opts = {}) {
  supplied = supplied && typeof supplied === "object" ? supplied : {};
  let defaults = opts.defaults && typeof opts.defaults === "object" ? opts.defaults : {};
  let enums = opts.enums && typeof opts.enums === "object" ? opts.enums : {};
  let spec = opts.spec && typeof opts.spec === "object" ? opts.spec : {};
  const maxLimit = Number.isFinite(opts.maxLimit) ? opts.maxLimit : 5000;

  // 주석을 먼저 벗긴다: 패턴 SQL 은 주석에 예시값(-- :n=10)을 적는 관례라, 안 벗기면
  // 주석 속 :이름까지 자리로 세어 바인딩 개수가 어긋난다.
  const sqlBody = String(sql || "").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!/^(select|with)\b/i.test(sqlBody)) return problem(400, "pattern not runnable", "SELECT/WITH 패턴만 실행한다");

  const occur = [];
  sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, (_, nm) => { occur.push(nm); return _; });
  const declared = [...new Set(occur)];
  const extra = Object.keys(supplied).filter((k) => !declared.includes(k));
  if (extra.length)
    return problem(400, "unknown parameter", `선언되지 않은 파라미터: ${extra.join(", ")} — 이 패턴의 파라미터는 [${declared.join(", ")}] 뿐이다`);
  // 🔴 게시 메타(defaults/enums/spec)가 SQL 과 어긋나도(파라미터 개명 후 메타 지연 등)
  //    **패턴을 막지 않는다.** d1_pattern_params 는 DBT/DAGS 병행 게시라 SQL 보다 늦을 수 있고,
  //    그 지연이 **잘 돌던 패턴을 죽이면 안 된다**(#217 불변식 — 리뷰 확증). 선언 밖 키는 조용히
  //    버린다: 그 키가 가리키는 파라미터가 SQL 에 없으니 버려도 답이 달라지지 않는다(값은 ? bind).
  const only = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => declared.includes(k)));
  defaults = only(defaults); enums = only(enums); spec = only(spec);

  const optional = declared.filter((nm) => Object.prototype.hasOwnProperty.call(defaults, nm));
  const resolved = {};
  const defaulted = [];
  for (const nm of declared) {
    const has = Object.prototype.hasOwnProperty.call(supplied, nm) && supplied[nm] !== undefined && supplied[nm] !== null;
    let v = has ? supplied[nm] : (Object.prototype.hasOwnProperty.call(defaults, nm) ? defaults[nm] : undefined);
    if (!has && v !== undefined) defaulted.push(nm);
    if (v === undefined || v === null)
      return problem(400, "missing parameter", `파라미터 :${nm} 값이 필요하다 — 이 패턴의 파라미터: [${declared.join(", ")}]`
        + (optional.length ? ` (기본값이 있어 생략 가능: [${optional.join(", ")}])` : ""));

    const sp = spec[nm];
    const declaredArray = !!(sp && sp.type === "array");

    if (Array.isArray(v)) {                                   // P3 — 배열은 **선언된 경우만** 전개
      // 🔴 배열은 게시 메타가 params.type=array 로 선언한 파라미터에만 허용한다. 미선언 배열을
      //    전개하면 (a) `json_each(:x)` 관용구가 깨지고 (b) `LIMIT :n` 클램프가 뚫린다(리뷰 확증).
      //    미선언이면 옛 계약 그대로 무과금 400 — 메타 없는(=흔한) 경로에서 스칼라만 받는다.
      if (!declaredArray)
        return problem(400, "invalid parameter", `:${nm} 은 배열을 받지 않는다 — 배열이 필요하면 게시 메타에 params.type=array 로 선언할 것`);
      if (LIMIT_PARAM.test(nm))                               // 행수 상한 파라미터는 스칼라여야 클램프가 상한이다
        return problem(400, "invalid parameter", `:${nm} 은 행수 상한 파라미터라 배열일 수 없다`);
      const cap = Math.min(Number(sp && sp.max_len) || ARRAY_HARD_CAP, ARRAY_HARD_CAP);
      if (v.length === 0) return problem(400, "empty array parameter", `:${nm} 배열이 비었다 — 최소 1개 값이 필요하다`);
      if (v.length > cap) return problem(400, "array too large", `:${nm} 는 최대 ${cap}개까지다(카티전 상한)`);
      const items = [];
      for (const el of v) {
        if (typeof el !== "string" && typeof el !== "number")
          return problem(400, "invalid parameter", `:${nm} 배열 원소는 문자열/숫자만 받는다`);
        if (sp && sp.item === "number") {
          const num = Number(el);
          if (!Number.isFinite(num)) return problem(400, "invalid parameter", `:${nm} 배열 원소는 숫자여야 한다`);
          items.push(num);
        } else items.push(sp && sp.item === "string" ? String(el) : el);
      }
      resolved[nm] = { isArray: true, values: items };
    } else {
      if (declaredArray)
        return problem(400, "invalid parameter", `:${nm} 은 배열이어야 한다 — 원소를 JSON 배열로 보낼 것(예: ["a","b"])`);
      if (typeof v !== "string" && typeof v !== "number")
        return problem(400, "invalid parameter", `:${nm} 은 문자열/숫자만 받는다`);
      if (sp && sp.type === "number") {
        const num = Number(v);
        if (!Number.isFinite(num)) return problem(400, "invalid parameter", `:${nm} 은 숫자여야 한다`);
        v = num;
      }
      // 행수 파라미터는 서빙 상한을 넘지 못한다 — 문자열 "999999" 도 SQLite LIMIT 이 받으므로
      // 타입과 무관하게 숫자로 강제한 뒤 누른다(#132 사후 리뷰 ②).
      if (LIMIT_PARAM.test(nm)) {
        const num = Number(v);
        if (!Number.isFinite(num)) return problem(400, "invalid parameter", `:${nm} 은 숫자여야 한다`);
        v = Math.min(num, maxLimit);
      }
      resolved[nm] = { isArray: false, value: v };
    }

    // P1 허용값 — 기본값이 채운 값에도 건다(기본값이 enum 밖이면 그건 게시 메타 버그다).
    const allow = enums[nm];
    if (Array.isArray(allow) && allow.length) {
      const vals = resolved[nm].isArray ? resolved[nm].values : [resolved[nm].value];
      for (const one of vals)
        if (!allow.some((a) => String(a) === String(one)))
          return problem(400, "invalid parameter", `:${nm}='${one}' 는 허용값 [${allow.join(", ")}] 밖이다`);
    }
  }

  const values = [];
  const converted = sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, (_, nm) => {
    const r = resolved[nm];
    if (r.isArray) { for (const x of r.values) values.push(x); return r.values.map(() => "?").join(","); }
    values.push(r.value); return "?";
  });
  return { ok: true, converted, values, declared, defaulted };
}

// REST 진입용 — 쿼리스트링은 문자열뿐이라, **선언이 array 인 파라미터만** JSON 배열 문자열을
// 실배열로 해석한다. 선언 없는 파라미터는 그대로 문자열 스칼라다 — 기존 `json_each(:gus)`
// 관용구(JSON 문자열을 통째로 bind)와의 하위 호환이 이 조건에 걸려 있다. MCP 는 typed JSON
// 이라 이 변환이 필요 없다(배열이 배열로 온다).
export function parseRestArrayParams(supplied, spec) {
  if (!spec || typeof spec !== "object") return supplied;
  const out = { ...supplied };
  for (const [nm, sp] of Object.entries(spec)) {
    if (!sp || sp.type !== "array") continue;
    const v = out[nm];
    if (typeof v !== "string" || !v.trim().startsWith("[")) continue;
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) out[nm] = arr;
    } catch { /* 파싱 실패 — convertPattern 의 "배열이어야 한다" 400 이 원인을 말해 준다 */ }
  }
  return out;
}
