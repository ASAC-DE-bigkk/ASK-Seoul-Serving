#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSkillDemo } from "../public/skill-demo.js";

export async function runLiveSmoke({ apiKey, baseUrl, fetchImpl = fetch }) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("skill demo base URL must be an HTTPS origin");
  }
  return runSkillDemo({
    apiKey,
    fetchImpl: (path, options) => fetchImpl(new URL(path, origin).toString(), options),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const apiKey = process.env.MARKETPLACE_API_KEY?.trim();
  const baseUrl = process.env.ASK_SEOUL_SKILL_API_BASE_URL?.trim() || "https://ask-seoul.kr";
  if (!apiKey) {
    console.error("MARKETPLACE_API_KEY is required; load it from a local secret environment.");
    process.exitCode = 2;
  } else {
    try {
      const result = await runLiveSmoke({ apiKey, baseUrl });
      console.log(JSON.stringify({
        status: "passed",
        publication_id: result.publicationId,
        row_count: result.rowCount,
        request_ids: result.requestIds,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        status: "failed",
        code: error?.code ?? "smoke_error",
        detail: error?.message ?? String(error),
        request_id: error?.details?.requestId ?? null,
      }));
      process.exitCode = 1;
    }
  }
}
