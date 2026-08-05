// 재배포 권리 게이트(#88 §1-2 B) 회귀 테스트.
//
// 이 게이트는 "원천이 재배포를 허용했는가"만 본다 — 준비도·품질은 문마다 다르지만
// 권리는 소비자와 무관해서 /api·/mcp·/skill 어디로도 못 뚫려야 한다.
//
// 판정 함수를 직접 검사한다. handleData 를 통째로 태우려면 카탈로그·키·쿼터 스텁이
// 다 필요한데, 그 경로는 skill-v1.test.mjs 가 이미 덮고 있고 여기서 확인할 것은
// **세 갈래 입력(null / [] / [...])이 단계별로 어떻게 갈리는가** 하나다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RIGHTS_GATE_STAGE,
  redistributionBlockers,
  rightsBlockedProblem,
} from "../src/shared.js";

const allowed = (id = "a") => ({ source_id: id, redistribution: "allowed_with_attribution" });
const denied = (id = "b", value = "prohibited") => ({ source_id: id, redistribution: value });

test("현재 단계는 1 — 백필 전이라 누락은 막지 않는다", () => {
  assert.equal(RIGHTS_GATE_STAGE, 1);
});

test("표가 없으면(null) 1단계는 통과시킨다 — 파이프라인 미게시가 서빙을 닫으면 안 된다", () => {
  assert.deepEqual(redistributionBlockers(null, 1), []);
});

test("표는 있고 이 제품 행이 0이어도([]) 1단계는 통과시킨다", () => {
  assert.deepEqual(redistributionBlockers([], 1), []);
});

test("2단계에서는 null·빈 배열 모두 증거 누락으로 막는다", () => {
  assert.deepEqual(redistributionBlockers(null, 2), ["missing_source_rights_evidence"]);
  assert.deepEqual(redistributionBlockers([], 2), ["missing_source_rights_evidence"]);
});

test("전 원천이 허용이면 통과 — 단계와 무관", () => {
  const sources = [allowed("kopis"), allowed("seoul_oa")];
  assert.deepEqual(redistributionBlockers(sources, 1), []);
  assert.deepEqual(redistributionBlockers(sources, 2), []);
});

test("명시적 거부는 1단계부터 막는다", () => {
  assert.deepEqual(
    redistributionBlockers([denied("seoul_oa")], 1),
    ["source_redistribution_not_allowed"],
  );
});

// 이 제품에서 실제로 걸린 경우다 — 원천 둘 중 하나만 unknown 인데 제품 전체가 막힌다.
// 컬럼 단위 출처 표시가 없어 허용된 원천만 골라 낼 방법이 없기 때문이다.
test("원천이 섞여 있으면 하나만 미허용이어도 제품 전체를 막는다", () => {
  assert.deepEqual(
    redistributionBlockers([allowed("mixed_a"), denied("mixed_b", "unknown")], 1),
    ["source_redistribution_not_allowed"],
  );
});

test("unknown 도 허용이 아니다 — allowed_with_attribution 만 통과", () => {
  for (const value of ["unknown", "prohibited", "", null, "allowed"]) {
    assert.deepEqual(
      redistributionBlockers([denied("x", value)], 1),
      ["source_redistribution_not_allowed"],
      `redistribution=${JSON.stringify(value)} 는 막혀야 한다`,
    );
  }
});

test("차단 응답은 /skill 과 같은 형태다 — 503 · product_not_ready · blockers", async () => {
  const res = rightsBlockedProblem("culture_event_schedule", "pub-1",
    ["source_redistribution_not_allowed"]);
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type"), /^application\/problem\+json/);
  const body = await res.json();
  assert.equal(body.code, "product_not_ready");
  assert.equal(body.product_id, "culture_event_schedule");
  assert.equal(body.publication_id, "pub-1");
  assert.deepEqual(body.blockers, ["source_redistribution_not_allowed"]);
});

test("publication_id 가 없어도 응답이 깨지지 않는다 — null 로 싣는다", async () => {
  const body = await rightsBlockedProblem("x", undefined, ["missing_source_rights_evidence"]).json();
  assert.equal(body.publication_id, null);
});
