const BUNDLE_PATH = "/skill/v1/bundles/seoul-weather-risk";
const PRODUCT_PATH = "/skill/v1/products/weather_place_risk_window";
const DATA_PATH = "/skill/v1/products/weather_place_risk_window/data?limit=1";

const STATUS_CODES = new Map([
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "unknown_product"],
  [429, "rate_limited"],
  [503, "product_not_ready"],
]);

export class SkillDemoError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SkillDemoError";
    this.code = code;
    this.details = details;
  }
}

async function requestJson({ path, apiKey, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(path, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (cause) {
    throw new SkillDemoError("network_error", "ASK 서울 API에 연결하지 못했습니다.", { cause });
  }

  const requestId = response.headers.get("x-request-id");
  const retryAfter = response.headers.get("retry-after");
  let body = {};
  try {
    body = await response.json();
  } catch {
    throw new SkillDemoError("malformed_response", "API 응답을 JSON으로 읽지 못했습니다.", {
      status: response.status,
      requestId,
    });
  }

  if (!response.ok) {
    const code = typeof body.code === "string"
      ? body.code
      : STATUS_CODES.get(response.status) ?? "api_error";
    throw new SkillDemoError(code, body.detail || body.title || `HTTP ${response.status}`, {
      status: response.status,
      blockers: Array.isArray(body.blockers) ? body.blockers : [],
      requestId,
      retryAfter,
    });
  }
  return { body, requestId };
}

export async function runSkillDemo({ apiKey, fetchImpl = fetch }) {
  const normalizedKey = String(apiKey ?? "").trim();
  if (!normalizedKey) {
    throw new SkillDemoError("unauthorized", "Marketplace API Key를 입력해 주세요.");
  }

  const bundle = await requestJson({ path: BUNDLE_PATH, apiKey: normalizedKey, fetchImpl });
  const products = Array.isArray(bundle.body.products) ? bundle.body.products : [];
  const member = products.find(({ product_id: productId }) => productId === "weather_place_risk_window");
  if (bundle.body.registration_ready !== true || member?.registration_ready !== true) {
    throw new SkillDemoError("product_not_ready", "기상 위험 제품이 아직 시연 가능한 상태가 아닙니다.", {
      blockers: Array.isArray(member?.blockers) ? member.blockers : [],
      requestId: bundle.requestId,
    });
  }

  const product = await requestJson({ path: PRODUCT_PATH, apiKey: normalizedKey, fetchImpl });
  if (product.body.registration_ready !== true) {
    throw new SkillDemoError("product_not_ready", "제품 상세 준비도 검사를 통과하지 못했습니다.", {
      blockers: Array.isArray(product.body.blockers) ? product.body.blockers : [],
      requestId: product.requestId,
    });
  }

  const data = await requestJson({ path: DATA_PATH, apiKey: normalizedKey, fetchImpl });
  const rows = Array.isArray(data.body.rows) ? data.body.rows : [];
  if (data.body.row_count === 0 || rows.length === 0) {
    throw new SkillDemoError("zero_rows", "현재 publication에서 시연할 행을 찾지 못했습니다.", {
      requestId: data.requestId,
      publicationId: data.body.publication_id ?? null,
    });
  }

  return {
    publicationId: data.body.publication_id,
    rowCount: data.body.row_count,
    sample: rows[0],
    requestIds: {
      bundle: bundle.requestId,
      product: product.requestId,
      data: data.requestId,
    },
  };
}

const RECOVERY = {
  unauthorized: "키를 다시 확인하거나 Marketplace에서 새 키를 발급받아 주세요.",
  forbidden: "폐기된 키이거나 K-Skill 조회 권한이 없습니다. 새 키를 사용해 주세요.",
  unknown_product: "현재 배포본에 seoul-weather-risk 경로가 없습니다. 배포 상태를 확인해 주세요.",
  rate_limited: "요청 한도를 초과했습니다. Retry-After 이후 다시 시도해 주세요.",
  product_not_ready: "freshness·coverage·권리 blocker가 해소되기 전에는 live 단계로 진행할 수 없습니다.",
  network_error: "네트워크와 ask-seoul.kr 연결 상태를 확인한 뒤 다시 시도해 주세요.",
  zero_rows: "빈 결과는 성공 답변이 아닙니다. 다음 publication 이후 다시 확인해 주세요.",
  malformed_response: "배포된 API 계약과 페이지 버전이 일치하는지 확인해 주세요.",
  api_error: "요청 ID와 함께 운영 담당자에게 문의해 주세요.",
};

function formatError(error) {
  const known = error instanceof SkillDemoError ? error : new SkillDemoError("api_error", String(error));
  const parts = [known.message, RECOVERY[known.code] ?? RECOVERY.api_error];
  if (known.details.blockers?.length) parts.push(`blockers: ${known.details.blockers.join(", ")}`);
  if (known.details.retryAfter) parts.push(`Retry-After: ${known.details.retryAfter}초`);
  if (known.details.requestId) parts.push(`request_id: ${known.details.requestId}`);
  return parts.join(" ");
}

function init() {
  const byId = (id) => document.getElementById(id);
  const keyInput = byId("skillApiKey");
  const verifyButton = byId("verifySkill");
  const resetButton = byId("resetSkillKey");
  const status = byId("skillStatus");
  const result = byId("skillResult");
  const liveHandoff = byId("liveHandoff");
  let sessionApiKey = "";

  keyInput.addEventListener("input", () => {
    sessionApiKey = keyInput.value;
    status.textContent = sessionApiKey ? "키는 이 탭의 메모리에서만 사용됩니다." : "API Key를 입력해 주세요.";
  });

  resetButton.addEventListener("click", () => {
    sessionApiKey = "";
    keyInput.value = "";
    result.hidden = true;
    liveHandoff.hidden = true;
    status.textContent = "키와 검증 결과를 초기화했습니다.";
    keyInput.focus();
  });

  verifyButton.addEventListener("click", async () => {
    if (!sessionApiKey.trim()) {
      status.textContent = formatError(new SkillDemoError("unauthorized", "Marketplace API Key를 입력해 주세요."));
      keyInput.focus();
      return;
    }
    verifyButton.disabled = true;
    result.hidden = true;
    liveHandoff.hidden = true;
    status.textContent = "bundle → product → data 준비도를 확인하고 있습니다.";
    try {
      const verified = await runSkillDemo({ apiKey: sessionApiKey });
      byId("resultPublication").textContent = verified.publicationId || "없음";
      byId("resultRows").textContent = String(verified.rowCount);
      byId("resultRequest").textContent = verified.requestIds.data || "헤더 없음";
      byId("resultSample").textContent = JSON.stringify(verified.sample, null, 2);
      status.textContent = "운영 K-Skill API 실호출을 통과했습니다.";
      result.hidden = false;
      liveHandoff.hidden = false;
      result.focus();
    } catch (error) {
      status.textContent = formatError(error);
      if (error instanceof SkillDemoError && error.code === "unauthorized") keyInput.focus();
    } finally {
      verifyButton.disabled = false;
    }
  });

  document.querySelectorAll("[data-copy-source]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = byId(button.dataset.copySource);
      const text = source?.textContent ?? "";
      await navigator.clipboard.writeText(text);
      button.textContent = "복사됨";
      window.setTimeout(() => { button.textContent = "복사"; }, 1200);
    });
  });

  window.addEventListener("beforeunload", () => {
    sessionApiKey = "";
    keyInput.value = "";
  });
}

if (typeof document !== "undefined") init();
