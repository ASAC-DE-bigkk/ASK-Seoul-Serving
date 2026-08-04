// MCP Tool Selection 평가(#26 완료기준 "6도메인 질문에 기대 Tool·인자 선택")의 두 층.
//
// ① 구조 검증(이 파일, npm test 자동) — 평가 정본(mcp-eval.json)이 실제 툴 계약과
//    어긋나지 않는지: 기대 tool 존재, 인자가 inputSchema 에 맞는지, 6도메인 전부인지.
//    계약이 바뀌면(툴 개명·인자 변경) 여기가 먼저 깨져 평가 정본의 부패를 막는다.
// ② LLM 실측(수동) — MCP 클라이언트(claude 등)에 서버를 연결하고 각 case 의 question 을
//    그대로 물은 뒤, 호출된 tool·인자가 expect 와 일치하는지 기록한다. 첫 호출은
//    acceptable_first_tools 안이면 정상(발견 단계). PlayMCP 심사 전 1회 이상 수행.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/mcp.js";
import { SKILL_PRODUCT_IDS } from "../src/skill.js";

const EVAL = JSON.parse(readFileSync(new URL("./mcp-eval.json", import.meta.url), "utf8"));
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
const positives = EVAL.cases.filter((c) => c.expect.tool);

test("평가 정본 — 기대 tool 이 실제 TOOLS 에 존재", () => {
  for (const c of positives)
    assert.ok(toolByName.has(c.expect.tool), `${c.id}: 없는 tool '${c.expect.tool}'`);
  for (const c of positives)
    for (const t of c.acceptable_first_tools || [])
      assert.ok(toolByName.has(t), `${c.id}: 없는 first tool '${t}'`);
});

test("평가 정본 — 기대 인자가 tool inputSchema 계약에 맞음", () => {
  for (const c of positives) {
    const schema = toolByName.get(c.expect.tool).inputSchema;
    const args = c.expect.args || {};
    for (const req of schema.required || [])
      assert.ok(req in args, `${c.id}: 필수 인자 '${req}' 누락`);
    if (schema.additionalProperties === false)
      for (const k of Object.keys(args))
        assert.ok(k in schema.properties, `${c.id}: 계약에 없는 인자 '${k}'`);
  }
});

test("평가 정본 — 6도메인이 정확히 한 번씩, 대상은 검증 번들 제품", () => {
  const domains = positives.map((c) => c.id).sort();
  assert.deepEqual(domains, ["citydata", "commerce", "culture", "traffic", "transit", "weather"]);
  const bundle = new Set(SKILL_PRODUCT_IDS);
  for (const c of positives)
    assert.ok(bundle.has(c.expect.args.product_id), `${c.id}: '${c.expect.args.product_id}' 는 검증 번들(#4) 밖`);
});

test("평가 정본 — 음성 케이스(없는 제품·빈 결과)가 행동 계약을 가짐", () => {
  const negatives = EVAL.cases.filter((c) => !c.expect.tool);
  assert.equal(negatives.length, 2);
  for (const c of negatives) assert.ok(c.expect.behavior, `${c.id}: behavior 누락`);
});
