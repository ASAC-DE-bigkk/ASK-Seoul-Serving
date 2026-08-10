# run-pattern-rest.candidate — `run_pattern` 을 REST 로도 여는 후보 (#192 특이사항 ② · 결정 대기)

> 🔴 **적용하지 않음.** 표현력 확장·문 개방은 **라우팅 결정**이라 마켓 담당 판단이 먼저다.

## 현재

`handleRunPattern` 은 **`/mcp` 의 `deps.handleRunPattern`** 으로만 연결돼 있다. `/api/v1/*` 라우터에
대응 경로가 없어 **신설형은 MCP 로만 실행**된다. (콘솔 route 계약 0014 에는 이미 사람용 문
`run_pattern` 값이 있다 — Serving PR#175 로 route 는 갈려 있으나 REST 라우트 자체는 없다.)

## 후보 (결정 시)

`src/index.js` 라우터에 GET(또는 POST) 경로 하나. 인증·버스트·쿼터는 다른 서빙 경로와 같은 층을 탄다.

```js
// 예: GET /api/v1/patterns/<product_id>/<pattern_id>?<params>  (Bearer)
const patMatch = path.match(/^\/api\/v1\/patterns\/([^/]+)\/([^/]+)$/);
if (patMatch) {
  trace.route = "run_pattern";                       // 0014 에 이미 있는 값
  const { keyRow, error } = await authenticate(env, request);
  if (error) return error;
  trace.keyHash = keyRow.key_hash;
  const burst = await checkBurst(env, "k:" + keyRow.key_hash);
  if (burst.exceeded) return burstProblem(burst.retryAfter);
  const params = Object.fromEntries(url.searchParams.entries());
  return handleRunPattern(env, decodeURIComponent(patMatch[1]), decodeURIComponent(patMatch[2]), params, keyRow, trace);
}
```

- `trace.route = "run_pattern"` 는 콘솔이 이미 SERVE 로 세는 값이라 **콘솔 변경 불필요**(0014 §2).
- **P0(테이블 스코프)** 이식이 선행이면 이 문에도 그대로 적용된다(같은 `handleRunPattern` 을 통과).

## 열림 판단 근거 (참고)

- MCP 는 클라이언트가 필터를 못 바꾸는 반면, REST 문은 사람이 `params` 를 직접 쥔다 — 그래도
  `run_pattern` 은 **저장·검증된 SQL 만** 돌리므로(질의를 '짓지' 못함) 표현 위험은 안 는다.
- **CORS(특이사항 ①)와는 별개 결정** — REST 는 `/api/v1` 이라 이미 ACAO 가 있다.
