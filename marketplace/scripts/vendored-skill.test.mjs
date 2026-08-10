import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const SKILL = new URL("../../skills/seoul-weather-risk/", import.meta.url);
const PROVENANCE = new URL("provenance.json", SKILL);

test("vendored artifact is pinned to the reviewed organization-fork commit", async () => {
  const provenance = JSON.parse(await readFile(PROVENANCE, "utf8"));
  assert.equal(provenance.source.repository, "https://github.com/ASAC-DE-bigkk/k-skill");
  assert.equal(provenance.source.commit, "a9e1c7e4b372da670908737b752bf708af160112");
  assert.match(provenance.source.ref, /^feat\//);
});

test("every exported file matches its recorded sha256", async () => {
  const provenance = JSON.parse(await readFile(PROVENANCE, "utf8"));
  for (const [path, expected] of Object.entries(provenance.files)) {
    const content = await readFile(new URL(path, SKILL));
    assert.equal(createHash("sha256").update(content).digest("hex"), expected, path);
  }
});

test("standalone skill never calls the unpublished npm skill at runtime", async () => {
  const skill = await readFile(new URL("SKILL.md", SKILL), "utf8");
  assert.doesNotMatch(skill, /@nomadamas\/k-skill|\bnpx\b/);
  assert.match(skill, /python(?:3)? scripts\/seoul_weather_risk\.py/);
});

test("success response request id is preserved by the standalone helper", async () => {
  const helper = await readFile(new URL("scripts/seoul_weather_risk.py", SKILL), "utf8");
  assert.match(helper, /headers\.get\(["']X-Request-Id["']\)/i);
  assert.match(helper, /payload\[["']request_id["']\]/);
});

test("verification CLI accepts the checked-in provenance", () => {
  const script = new URL("marketplace/scripts/verify-vendored-skill.mjs", ROOT);
  const result = spawnSync(process.execPath, [fileURLToPath(script), fileURLToPath(PROVENANCE)], {
    cwd: new URL("marketplace/", ROOT),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /vendored skill verified/i);
});
