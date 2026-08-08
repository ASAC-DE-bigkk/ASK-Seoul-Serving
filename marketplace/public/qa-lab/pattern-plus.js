/* pattern-plus.js — run_pattern 바인딩의 **승격 후보 로직** (게이트웨이 규약 그대로).
 *
 * 🎯 목적: 이슈 #192 의 P1(선택 파라미터+기본값)·P3(배열 파라미터)을, 현재
 *    `src/index.js` 의 `handleRunPattern` 이 쓰는 바인딩 규약과 **같은 형태**로 구현한다.
 *    검증이 끝나면 이 순수 함수를 그대로 `src/` 로 옮겨 현행 핸들러의 변환부를 대체할 수 있다
 *    — 이 랩은 버리는 POC 가 아니라, 실제 교체 후보를 담아 두는 **스테이징**이다.
 *
 * ⚠️ 이 파일은 이 실험 폴더(marketplace/public/qa-lab/) 안에서만 산다. 삭제하면 사라진다.
 *    브라우저에서는 **순수 변환·검증**(SQL → converted + binds)만 미리 보여 준다 —
 *    실제 D1 실행은 게이트웨이(run_pattern)가 하고, 여기서 재현하지 않는다(값-최소화·권한 경계).
 *
 * 대체 대상(현행): src/index.js `handleRunPattern` 의 611~639 —
 *   ① 주석 제거 → ② SELECT/WITH 확인 → ③ `:이름` → `?` 치환·수집 →
 *   ④ 선언 밖 파라미터 400 → ⑤ 값 해석(누락·타입 400, n/limit/top_n 은 MAX_LIMIT 클램프).
 * 이 모듈은 위 다섯을 **동일 규약**으로 재현하고, ④⑤ 사이에 P1·P3 만 얹는다.
 */
(function (root) {
  "use strict";

  var MAX_LIMIT = 5000; // src/index.js 와 같은 값 하나여야 상한이 상한이다

  // 게이트웨이 problem() 과 같은 봉투 모양 — 옮길 때 problem(status,title,detail) 로 1:1 매핑
  function problem(status, title, detail) { return { ok: false, problem: { status: status, title: title, detail: detail } }; }

  var LIMIT_PARAM = /^(n|limit|top_n)$/;

  /**
   * convert — 저장된 패턴 SQL + 소비자 params → { ok, converted, values } | { ok:false, problem }
   *
   * @param {string} sql         d1_usage_patterns.sql (참조 구현 SQL)
   * @param {object} supplied    소비자가 준 파라미터 {이름: 값 | 값[]}
   * @param {object} opts        { defaults?: {이름: 값} }  ← #192 P1
   */
  function convert(sql, supplied, opts) {
    supplied = supplied && typeof supplied === "object" ? supplied : {};
    opts = opts || {};
    var defaults = opts.defaults && typeof opts.defaults === "object" ? opts.defaults : {};

    // ① 주석 제거 — 패턴 SQL 은 주석에 예시값(-- :n=10)을 적는 관례라, 안 벗기면 :이름을 잘못 센다
    var sqlBody = String(sql || "").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    // ② 읽기 전용만
    if (!/^(select|with)\b/i.test(sqlBody)) return problem(400, "pattern not runnable", "SELECT/WITH 패턴만 실행한다");

    // ③ `:이름` 자리를 등장 순서대로 수집(치환은 아래서 값 개수를 알아야 하므로 2패스)
    var occur = [];
    sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, function (_, nm) { occur.push(nm); return _; });
    var declared = occur.filter(function (v, i) { return occur.indexOf(v) === i; });

    // ④ 선언 밖 파라미터 400 (기본값 키도 선언 안이어야 한다 — 없는 자리에 기본값을 주지 않는다)
    var extra = Object.keys(supplied).filter(function (k) { return declared.indexOf(k) === -1; });
    if (extra.length) return problem(400, "unknown parameter", "선언되지 않은 파라미터: " + extra.join(", ") + " — 이 패턴의 파라미터는 [" + declared.join(", ") + "] 뿐이다");
    var badDefault = Object.keys(defaults).filter(function (k) { return declared.indexOf(k) === -1; });
    if (badDefault.length) return problem(400, "unknown default", "선언되지 않은 파라미터의 기본값: " + badDefault.join(", "));

    // ⑤ 각 이름의 최종 값을 정한다: supplied → (없으면) P1 기본값 → (그래도 없으면) 400
    var resolved = {};   // 이름 → {isArray, value|values}
    for (var i = 0; i < declared.length; i++) {
      var nm = declared[i];
      var has = Object.prototype.hasOwnProperty.call(supplied, nm) && supplied[nm] !== undefined && supplied[nm] !== null;
      var v = has ? supplied[nm] : (Object.prototype.hasOwnProperty.call(defaults, nm) ? defaults[nm] : undefined);
      if (v === undefined || v === null)
        return problem(400, "missing parameter", "파라미터 :" + nm + " 값이 필요하다 — 이 패턴의 파라미터: [" + declared.join(", ") + "]");

      // ── #192 P3: 배열 파라미터 ── 각 원소는 식별자가 아니라 값이라 여전히 ? bind(인젝션 불가)
      if (Array.isArray(v)) {
        if (v.length === 0) return problem(400, "empty array parameter", ":" + nm + " 배열이 비었다 — 최소 1개 값이 필요하다");
        if (v.length > 100) return problem(400, "array too large", ":" + nm + " 는 최대 100개까지다(카티전 상한)");
        for (var j = 0; j < v.length; j++) if (typeof v[j] !== "string" && typeof v[j] !== "number") return problem(400, "invalid parameter", ":" + nm + " 배열 원소는 문자열/숫자만 받는다");
        resolved[nm] = { isArray: true, values: v.slice() };
        continue;
      }
      if (typeof v !== "string" && typeof v !== "number") return problem(400, "invalid parameter", ":" + nm + " 은 문자열/숫자만 받는다");
      // 행수 파라미터는 서빙 상한을 넘지 못한다 — 타입 무관 숫자 강제 후 클램프(현행과 동일)
      if (LIMIT_PARAM.test(nm)) {
        var num = Number(v);
        if (!isFinite(num)) return problem(400, "invalid parameter", ":" + nm + " 은 숫자여야 한다");
        v = Math.min(num, MAX_LIMIT);
      }
      resolved[nm] = { isArray: false, value: v };
    }

    // ③' 이제 값 개수를 알므로 치환한다 — 스칼라는 `?`, 배열은 `?,?,?`(원소 수만큼)
    var values = [];
    var converted = sqlBody.replace(/:([a-z_][a-z0-9_]*)/gi, function (_, nm) {
      var r = resolved[nm];
      if (r.isArray) { for (var k = 0; k < r.values.length; k++) values.push(r.values[k]); return r.values.map(function () { return "?"; }).join(","); }
      values.push(r.value); return "?";
    });

    return { ok: true, converted: converted, values: values, declared: declared };
  }

  var api = { convert: convert, MAX_LIMIT: MAX_LIMIT };
  if (root) root.PatternPlus = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
