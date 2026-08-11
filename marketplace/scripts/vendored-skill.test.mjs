import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalTextSha256 } from "./verify-vendored-skill.mjs";

const ROOT = new URL("../../", import.meta.url);
const SKILL = new URL("../../skills/seoul-weather-risk/", import.meta.url);
const PROVENANCE = new URL("provenance.json", SKILL);

test("vendored artifact is pinned to the reviewed organization-fork commit", async () => {
  const provenance = JSON.parse(await readFile(PROVENANCE, "utf8"));
  assert.equal(provenance.source.repository, "https://github.com/ASAC-DE-bigkk/k-skill");
  assert.equal(provenance.source.commit, "131abc37ed43bac7362ed64ceffa16adcd6fe674");
  assert.match(provenance.source.ref, /^feat\//);
});

test("every exported file matches its recorded sha256", async () => {
  const provenance = JSON.parse(await readFile(PROVENANCE, "utf8"));
  assert.equal(provenance.hash_normalization, "lf");
  for (const [path, expected] of Object.entries(provenance.files)) {
    const content = await readFile(new URL(path, SKILL));
    assert.equal(canonicalTextSha256(content), expected, path);
  }
});

test("artifact hashes are identical on LF and CRLF checkouts", () => {
  assert.equal(canonicalTextSha256("line 1\nline 2\n"), canonicalTextSha256("line 1\r\nline 2\r\n"));
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

test("standalone helper exposes the data-only fast query contract", async () => {
  const helper = await readFile(new URL("scripts/seoul_weather_risk.py", SKILL), "utf8");
  assert.match(helper, /query\.add_argument\(["']--fast["']/);
  assert.match(helper, /invalid_fast_query/);
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
