# mcp-cors.candidate — `/mcp` 응답에 CORS 헤더 추가 후보 (#192 특이사항 ① · 결정 대기)

> 🔴 **적용하지 않음.** 이건 게이트웨이 **근간 변경**이라 결정자(마켓 담당) 판단이 먼저다.
> 여기엔 결정이 서면 바로 낼 수 있게 **최소 변경 후보**만 적어 둔다.

## 문제 (실측 2026-08-08)

- `/api/v1/*` 응답에는 `Access-Control-Allow-Origin: *` 가 있다(`shared.js` `json()`·`problem()`).
- **`/mcp` 응답에는 없다** — `mcp.js` `rpcJson()` 이 `content-type` 만 단다. 전역 `OPTIONS` 핸들러
  (`index.js`)는 프리플라이트에 ACAO 를 주지만, **실제 POST 응답에는 안 붙는다.**
- 결과: 브라우저가 **교차 출처로 `/mcp` 를 못 읽는다**. (CLI·서버-투-서버는 CORS 무관 → 영향 없음.)
- 영향받는 것: claude.ai 웹 커넥터 등 **브라우저 기반 원격 MCP 클라이언트**, 콘솔 qa-lab 의 교차 출처 MCP.

## 후보 A — 목표 지점 한 곳(권장)

`src/index.js` `export default { fetch }` 에서 응답을 마무리하는 자리(`x-request-id` 를 붙이는 곳)
바로 옆에, **MCP 경로일 때만** ACAO 를 얹는다. 이미 `OPTIONS` 는 ACAO 를 주므로 대칭이 맞는다.

```js
res = new Response(res.body, res);
res.headers.set("x-request-id", trace.requestId);
// ▼ 후보(결정 시): /mcp 도 /api/v1 처럼 교차 출처에서 읽히게. OPTIONS 가 이미 허용한 것과 대칭.
if (trace.route && trace.route.startsWith("mcp")) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-expose-headers", "x-request-id");
}
```

- **장점**: `mcp.js` 를 안 건드린다(‘`TOOLS`·핸들러 읽기 전용’ 결정 0006 과 충돌 없음). 한 곳.
- `trace.route` 는 `mcp`·`mcp_<tool>` 를 포함하므로 initialize·tools/list·tools/call 전부 덮인다.

## 후보 B — `rpcJson()` 에서(대안)

`mcp.js` `rpcJson` 이 `access-control-allow-origin: *` 를 함께 달게 한다. 단 `mcp.js` 수정이라
0006 의 "MCP 어댑터는 건드리지 않는다" 선과 가까워, **후보 A 를 권장**한다.

## 검증(적용 시)

```
curl -s -D - -o /dev/null -X POST https://ask-seoul.kr/mcp \
  -H 'content-type: application/json' -H 'origin: https://example.com' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i access-control
# → access-control-allow-origin: * 가 떠야 한다
```

## 재검토

- 무인증 읽기 표면을 넓히는 것은 아니다(`/mcp` 는 이미 무인증으로 initialize/tools/list 를 준다).
  데이터 대면(`tools/call`)은 여전히 Bearer 필수라 ACAO 추가가 권한 경계를 넓히지 않는다.
- `run_pattern` 의 REST 개방(#192 특이사항 ②)과는 **별개 결정**이다.
