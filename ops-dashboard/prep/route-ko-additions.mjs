// prep/route-ko-additions.mjs — 콘솔 route 계약 확장 후보 (#192 OPS · 이식 후보, 미배선)
//
// decision/0014 규약: **route 값 자체는 게이트웨이 소유**, 콘솔은 이미 내보내진 값을 소비만 한다.
// 값이 늘면 `public/index.html` 의 `ROUTE_KO` 와 0014 §1 표를 **같은 커밋에서** 따라간다.
// 이 파일은 "게이트웨이가 다음에 낼 값"에 대한 콘솔측 매핑을 **미리** 준비해 둔 것이다.
// 🔴 게이트웨이가 아직 안 내보내는 값이다 — 배선하지 않는다. 폴더 삭제로 소거.
//
// 대상: 마켓플레이스 채팅(#159 · decision/0006). 채팅 툴은 자기 route(`chat_*`)를 남기기로 했다
//       (0006 「관측 — 채팅 route 를 MCP 와 섞지 않는다」). 값이 실제로 들어오면 아래를 ROUTE_KO 에 병합.

// ROUTE_KO 에 추가할 후보 (게이트웨이 emit 확인 후 배선).
export const ROUTE_KO_ADDITIONS = {
  chat: "채팅 연결",              // 채팅 세션 준비(있다면)
  chat_list_products: "채팅 목록 조회",
  chat_describe_product: "채팅 제품 안내",
  chat_preview_product: "채팅 미리보기",
  chat_query_product: "채팅 데이터 조회",   // SERVE
  chat_run_pattern: "채팅 패턴 조회",       // SERVE
  chat_check_quota: "채팅 사용량 조회",
};

// SERVE_ROUTES 에 추가할 후보 — "데이터 행을 실제로 돌려줬나" 기준(0014 §2).
export const SERVE_ROUTES_ADDITIONS = ["chat_query_product", "chat_run_pattern"];

// 병합 헬퍼(이식 시): 기존 맵/배열에 겹치지 않게 더한다.
export function mergeRouteKo(existing) { return { ...existing, ...ROUTE_KO_ADDITIONS }; }
export function mergeServeRoutes(existing) {
  const set = new Set(existing || []);
  for (const r of SERVE_ROUTES_ADDITIONS) set.add(r);
  return [...set];
}
