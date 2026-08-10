#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_COMMIT = "a9e1c7e4b372da670908737b752bf708af160112";
const REQUIRED_FILES = new Set([
  "SKILL.md",
  "NOTICE",
  "scripts/seoul_weather_risk.py",
  "references/admin-dong-place-map.json",
]);

export function canonicalTextSha256(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

export async function verifyVendoredSkill(provenancePath) {
  const absoluteProvenance = resolve(provenancePath);
  const skillRoot = dirname(absoluteProvenance);
  const provenance = JSON.parse(await readFile(absoluteProvenance, "utf8"));

  if (provenance?.source?.repository !== "https://github.com/ASAC-DE-bigkk/k-skill") {
    throw new Error("unexpected source repository");
  }
  if (provenance?.source?.commit !== EXPECTED_COMMIT) {
    throw new Error("unexpected source commit");
  }
  if (provenance?.hash_normalization !== "lf") {
    throw new Error("unsupported provenance hash normalization");
  }

  const entries = Object.entries(provenance.files ?? {});
  if (entries.length !== REQUIRED_FILES.size || entries.some(([path]) => !REQUIRED_FILES.has(path))) {
    throw new Error("provenance file set does not match the standalone artifact contract");
  }

  for (const [relativePath, expectedHash] of entries) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error(`unsafe provenance path: ${relativePath}`);
    }
    const absolutePath = resolve(skillRoot, relativePath);
    if (!absolutePath.startsWith(`${skillRoot}${sep}`)) {
      throw new Error(`provenance path escapes artifact root: ${relativePath}`);
    }
    const content = await readFile(absolutePath);
    const actualHash = canonicalTextSha256(content);
    if (actualHash !== expectedHash) {
      throw new Error(`sha256 mismatch: ${relativePath}`);
    }
  }

  const instructions = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  if (/\bnpx\b|@nomadamas\/k-skill/.test(instructions)) {
    throw new Error("standalone artifact contains an unpublished runtime dependency");
  }
  return provenance;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const provenancePath = process.argv[2];
  if (!provenancePath) {
    console.error("usage: node verify-vendored-skill.mjs <provenance.json>");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyVendoredSkill(provenancePath);
      console.log(`vendored skill verified: ${result.source.commit}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
