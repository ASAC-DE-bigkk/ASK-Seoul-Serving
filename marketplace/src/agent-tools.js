// AI 소비자 공용 층 — **MCP 와 채팅이 같은 도구를 같은 모양으로 보게 한다** (#159 ②).
//
// 왜 따로 있나: `TOOLS`(도구 계약)와 **응답 성형**은 소비자가 MCP 든 채팅이든 같아야 하는데,
// 지금은 둘 다 `mcp.js` 의 `callTool` 안에 있다. 채팅이 그걸 복사하면 **두 벌이 갈리고**,
// 그건 MCP 담당이 재사용을 승인하며 명시적으로 경계한 것이다(#159 kang 코멘트).
//
// 경계는 이렇게 긋는다.
//
// ```
// mcp.js        TOOLS 정의(계약 정본) · JSON-RPC 봉투 · trace 규약   ← MCP 담당 소유
// agent-tools   TOOLS 를 **읽어** LLM 형식으로 · AI 를 위한 응답 성형 ← 여기(공용)
// chat.js       Workers AI 왕복 · 대화 상태                          ← 다음 단계
// ```
//
// 🔴 **`TOOLS` 를 고치지 않는다.** 이름·스키마·설명은 MCP 계약의 정본이고 PlayMCP·외부
//    클라이언트가 이미 그 문구에 묶여 있다. 바꿀 일이 생기면 직접 수정이 아니라 MCP 담당에게
//    요청한다 — 이 파일은 **읽기만** 한다(테스트가 원본 불변을 단언한다).
// ⚠️ **`mcp.js` 를 import 하지 않는다.** `mcp.js` 가 이 파일의 성형 함수를 쓰므로 서로
//    가져오면 순환이 된다. 그래서 `TOOLS` 는 **인자로 받는다** — 덤으로 "이 파일은 계약을
//    읽기만 한다"가 구조로 드러난다(이 파일에는 계약에 닿을 경로 자체가 없다).
import { ATTRIBUTION } from "./shared.js";

/**
 * `TOOLS` → OpenAI 호환 function-calling 스펙.
 *
 * Workers AI 를 포함해 대부분의 제공자가 이 모양을 받는다(`decision/0006` 채택 모델
 * `@cf/qwen/qwen3-30b-a3b-fp8` 실측). 원본을 **복사해서** 만든다 — 반환값을 부르는 쪽이
 * 만지더라도 `TOOLS` 가 안 바뀌게 하기 위해서다.
 */
export function agentToolSpecs(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      // 스키마도 **참조를 넘기지 않는다.** 얕게 넘기면 프롬프트 조립 중 한 번의 변형이
      // MCP 계약을 조용히 바꾼다.
      parameters: JSON.parse(JSON.stringify(t.inputSchema)),
    },
  }));
}

/**
 * 제품 목록을 **고르기 위한 크기**로 줄인다.
 *
 * 🔴 카탈로그 본문을 그대로 흘리면 57종의 질의 패턴과 컬럼 전량이 함께 나가 **510KB** 가
 * 된다(실측 2026-08-08: usage_patterns 75.5% · columns 17.2% = 93%). AI 가 **가장 먼저**
 * 부르는 도구라 한 번의 호출로 컨텍스트가 무너진다 — 전수 평가에서 AI 가 이 응답을 파일로
 * 저장한 뒤 grep 으로 뒤지는 이상행동을 했다.
 *
 * 🔴 그렇다고 **전부 빼면 안 된다.** 패턴의 `question_ko` 는 소비자가 제품을 고르는
 * **검색 신호**다 — 대표질문 57개로는 흐릿한 것이 패턴 질문까지 있으면 정확히 걸린다.
 * 그 신호는 27KB 뿐이고, 버리는 200KB 는 목록 단계에서 쓰이지 않는 것들이다:
 * `sql`(AI 는 SQL 을 직접 실행하지 않는다 — `run_pattern` 이 `pattern_id` 로 돌린다) ·
 * `insight_sample_ko`(실행 응답에 온다) · `requires`·`axes`(상세와 400 안내가 말한다).
 *
 * ⚠️ `/api/v1/catalog`(REST)는 건드리지 않는다 — 웹 카탈로그 화면이 상세를 쓴다.
 * 이 성형은 **AI 소비자에게만** 적용된다.
 */
export function slimProductList(body) {
  if (!body || !Array.isArray(body.products)) return body;
  const slimPattern = (u) => ({ pattern_id: u.pattern_id, question_ko: u.question_ko });
  const slimColumn = (c) => c.name ?? c.column_name ?? null;
  return {
    ...body,
    products: body.products.map(({ usage_patterns, columns, ...rest }) => ({
      ...rest,
      // 개수를 함께 두는 이유: 0 이면 "아직 메타가 게시되지 않은 제품"이라는 신호라
      // 고르는 판단에 쓰인다. **목록이 비었다는 것과 필드가 없다는 것은 다른 뜻이다.**
      column_count: Array.isArray(columns) ? columns.length : 0,
      column_names: Array.isArray(columns) ? columns.map(slimColumn).filter(Boolean) : [],
      pattern_count: Array.isArray(usage_patterns) ? usage_patterns.length : 0,
      usage_patterns: Array.isArray(usage_patterns) ? usage_patterns.map(slimPattern) : [],
    })),
    detail_hint:
      "목록에는 질의 패턴의 질문·id 와 컬럼 이름만 싣습니다. 컬럼 설명·필요 파라미터·" +
      "실행 가능 여부(runnable)는 describe_product(product_id) 로 확인하세요.",
  };
}

/**
 * 답변 가드레일 — 데이터에 **언제 기준·어디 출처·무엇을 조심**을 동봉한다.
 *
 * AI 가 이걸 답변에 실을 수 있어야 **오래된 데이터를 현재로 단언하는 환각**이 준다.
 * `freshness` 는 이 게시본의 원천 기준 시각이지 "지금"이 아니다 — 그 구분이 이 객체의 존재
 * 이유다. 메타는 호출부가 같은 행에서 이미 읽은 것을 넘겨받는다(핫패스에 D1 왕복을 안 늘린다).
 */
export function buildDataContext(meta) {
  if (!meta) return null;
  return {
    freshness: meta.freshness ?? null,
    serving_status: meta.serving_status ?? null,
    ...(meta.serving_status && meta.serving_status !== "published"
      ? { warning: `serving_status='${meta.serving_status}' — 원천 수집 지연 등으로 최신성이 보장되지 않는다` }
      : {}),
    attribution: ATTRIBUTION,          // 정본 한 벌(shared) — /legal 개정 때 한쪽만 고쳐지지 않게
    caution: meta.description ?? null, // 제품 주의사항("공식 특보 아님" 등)
  };
}

/**
 * 질문 하나로 **57종을 가로질러** 맞는 제품을 고른다 — 목록을 다 읽히지 않기 위한 도구.
 *
 * 왜 필요한가(실측 2026-08-08): `list_products` 가 142KB(약 4만 토큰)라 AI 가 다 읽지 못하고
 * **없는 제품 이름을 9분 안에 13번 지어냈다**(`citydata_ppltn_age`·`_demo`·`_demography` …).
 * 목록을 더 줄이면 고르는 근거가 사라지므로, 줄이는 대신 **서버가 골라 준다.**
 *
 * 무엇으로 맞추나 — 가장 구체적인 신호는 **질의 패턴의 질문 431건**이다. 대표질문 57개는
 * 제품 하나를 한 줄로 요약하지만, 패턴 질문은 "그 제품으로 답할 수 있는 진짜 질문"이라
 * 사용자 문장과 직접 겹친다. 그래서 패턴에서 맞으면 가중치를 준다.
 *
 * 🔴 **LLM 을 쓰지 않는다.** 낱말 겹침이면 충분하고(chat.js `matchPatterns` 와 같은 계열),
 * 무엇보다 이 도구는 **고르기 전 단계**라 과금·지연이 붙으면 존재 이유가 없다.
 * 정확도의 한계는 응답이 스스로 말한다(`matched_terms`) — 왜 걸렸는지 보이면 AI 가 틀린
 * 후보를 스스로 버린다.
 */
const HAY_WEIGHT = { pattern: 3, question: 2, text: 1 };

// 한국어는 조사가 붙어 낱말이 어긋난다("장소가" vs "장소"). 형태소 분석기를 넣을 자리는
// 아니므로 **꼬리 한 글자를 떼어 본다** — 조사 대부분이 1음절이라 이것만으로 크게 는다.
const forms = (tok) => (tok.length >= 3 ? [tok, tok.slice(0, -1)] : [tok]);

const tokenize = (s) => String(s || "").toLowerCase()
  .split(/[^0-9a-z가-힣]+/).filter((w) => w.length >= 2);

// 🔴 **고를 수 있는 패턴만 신호로 쓴다.** 검증 스탬프가 없는 초안까지 매칭에 넣으면,
// AI 가 추천받은 `pattern_id` 로 `run_pattern` 을 불렀다가 **409 pattern not verified** 를
// 맞는다 — 이 도구가 없애려던 "지어내고 404" 왕복이 "추천받고 409" 왕복으로 바뀔 뿐이다.
// 채팅의 후보 추천이 같은 이유로 이미 거른다(`chat.js` `productGivenMessages`).
// 지금 카탈로그는 640패턴 전부 검증돼 있어 무해하지만, ASAC-DBT#489 가 초안 230건을
// 내보내는 순간 **조용히 회귀**하는 구조다(Exisign 리뷰, #256). 그때 고치면 늦다.
const runnablePatterns = (p) =>
  (Array.isArray(p.usage_patterns) ? p.usage_patterns : []).filter((u) => u.verified_at || u.runnable);

// 제품 하나가 가진 말뭉치 — 어디서 걸렸는지에 따라 무게가 다르다.
function haystacks(p) {
  const patterns = runnablePatterns(p);
  return {
    patterns,
    question: String(p.product_question || "").toLowerCase(),
    text: [p.display?.title, p.display?.summary, p.description,
      String(p.product_id || "").replace(/_/g, " ")].join(" ").toLowerCase(),
  };
}

const hitsIn = (tok, hay) => forms(tok).some((f) => hay.includes(f));

/**
 * 🔴 **흔한 낱말은 값이 없다.** 첫 판은 겹친 낱말 수만 셌더니 *"서울에서 요즘 전시 많이
 * 열리는 동네가 어디야?"* 의 1등이 `commerce_dong_category_matrix` 였다 — `동네가`·`어디야`·
 * `많이` 세 개가 걸려서, 정작 결정적인 `전시` 하나만 가진 `culture_activity_by_dong` 을
 * 눌렀다(운영 실측 2026-08-10). 질문마다 붙는 `서울에서`·`어디야` 는 57종 거의 전부에
 * 있으므로 **정보가 0에 가깝다.**
 *
 * 그래서 낱말마다 **몇 개 제품에 나타나는지(df)** 를 세어 흔할수록 무게를 깎는다(idf).
 * 불용어 목록을 손으로 들지 않는 이유는 그 목록이 늘 실물보다 늦기 때문이다 — 카탈로그가
 * 바뀌면 무엇이 흔한지도 같이 바뀌고, df 는 그걸 저절로 따라간다.
 */
function idfOf(tokens, products) {
  const N = Math.max(products.length, 1);
  const hays = products.map(haystacks);
  const idf = new Map();
  for (const tok of tokens) {
    const df = hays.filter((h) =>
      hitsIn(tok, h.question) || hitsIn(tok, h.text) ||
      h.patterns.some((pat) => hitsIn(tok, String(pat.question_ko || "").toLowerCase()))).length;
    // df=N(전부에 있음) → 작아지고 · df=1(한 제품에만) → 커진다.
    // 🔴 `log((N+1)/(df+1))` 이 아니라 `log(1 + N/df)` 를 쓴다 — 전자는 **모든 제품에 있는
    //    낱말을 정확히 0 으로** 만들어, 제품이 적을 때(테스트·소규모 카탈로그) 걸린 낱말이
    //    통째로 사라진다. 흔한 말을 **누르는 것**이 목적이지 지우는 것이 아니다.
    idf.set(tok, Math.log(1 + N / Math.max(df, 1)));
  }
  return idf;
}

export function searchProducts(body, query, limit = 5) {
  const products = Array.isArray(body?.products) ? body.products : [];
  const tokens = [...new Set(tokenize(query))];
  const idf = idfOf(tokens, products);

  const scored = products.map((p) => {
    const h = haystacks(p);
    const hits = new Set();
    let score = 0;
    const matchedPatterns = [];
    for (const pat of h.patterns) {
      const q = String(pat.question_ko || "").toLowerCase();
      const on = tokens.filter((t) => hitsIn(t, q));
      if (on.length) {
        matchedPatterns.push({
          pattern_id: pat.pattern_id, question_ko: pat.question_ko,
          weight: on.reduce((s, t) => s + (idf.get(t) || 0), 0),
        });
      }
    }
    // 한 낱말이 여러 곳에서 걸려도 **한 번만** 센다 — 패턴 22개짜리 제품이 이기는 것을 막는다.
    for (const t of tokens) {
      const w = idf.get(t) || 0;
      if (w <= 0) continue;
      const where = h.patterns.some((pat) => hitsIn(t, String(pat.question_ko || "").toLowerCase()))
        ? HAY_WEIGHT.pattern
        : hitsIn(t, h.question) ? HAY_WEIGHT.question
        : hitsIn(t, h.text) ? HAY_WEIGHT.text : 0;
      if (where) { score += where * w; hits.add(t); }
    }
    matchedPatterns.sort((a, b) => b.weight - a.weight);
    return { p, score, hits, matchedPatterns };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.p.product_id).localeCompare(String(b.p.product_id)))
    .slice(0, limit);

  return {
    query: String(query || ""),
    total_products: products.length,
    matched: scored.length,
    products: scored.map(({ p, hits, matchedPatterns }) => ({
      product_id: p.product_id,
      title: p.display?.title ?? p.name ?? p.product_id,
      product_question: p.product_question ?? null,
      freshness: p.freshness ?? null,
      // 두 수를 따로 싣는다 — 전체는 "메타가 게시됐나", runnable 은 "지금 고를 수 있나"라
      // 뜻이 다르다. 하나로 합치면 초안만 있는 제품이 "메타 없음"으로 오독된다.
      pattern_count: Array.isArray(p.usage_patterns) ? p.usage_patterns.length : 0,
      runnable_pattern_count: runnablePatterns(p).length,
      // 왜 걸렸는지 보여 준다 — 근거가 없으면 AI 가 틀린 후보를 못 버린다
      matched_terms: [...hits],
      matched_patterns: matchedPatterns.slice(0, 3).map(({ pattern_id, question_ko }) => ({ pattern_id, question_ko })),
    })),
    hint: scored.length
      ? "고른 제품은 describe_product 로 컬럼·파라미터를 확인하고, matched_patterns 의 pattern_id 는 run_pattern 으로 바로 실행할 수 있습니다."
      : "맞는 제품을 못 찾았습니다 — 낱말을 바꿔 다시 부르거나 list_products 로 전체를 확인하세요. 제품 이름을 지어내지 마세요.",
  };
}
