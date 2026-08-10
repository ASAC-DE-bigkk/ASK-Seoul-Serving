# ops-dashboard/prep — TO-BE 이행 **콘솔(OPS) 준비물** (미배선 · 이식 후보)

이슈 [#192](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/issues/192) TO-BE 이행에서 콘솔이 맡을
**관측·지표** 부분을, **현재 시스템에 적용하지 않은 채** 미리 만들어 둔 폴더다.

## 🔴 성격 — 근간 무수정 · 미배선 · 폴더 삭제로 소거

- **어디에도 `import` 되지 않는다.** `src/index.js`·`public/index.html`·`ui.*` 중 무엇도 이 폴더를
  참조하지 않으므로 운영에서 실행되지 않는다.
- `check:hidden` 등 기존 검사는 `index.html` 정적 id 만 보므로 무영향.
- **소거**: `rm -rf ops-dashboard/prep`.

## 파일과 이식 지점

| 파일 | 무엇 | 이식 지점(적용 시) |
|---|---|---|
| `pattern-telemetry.mjs` | 검증 커버리지(d1_usage_patterns) · run_pattern 사용·오류·**드리프트(500)** · AS-IS↔TO-BE 대비 SQL + 순수 집계기 | `src/index.js` 서빙 절에 카드 하나. `safeRows(env, sql, since)` 로 실행 → `shape*` 로 가공 |
| `route-ko-additions.mjs` | 채팅(#159) 등 **다음 route 값**의 `ROUTE_KO`·`SERVE_ROUTES` 후보 | 게이트웨이가 `chat_*` 를 emit 하면 `public/index.html` `ROUTE_KO` + decision/0014 §1 에 **같은 커밋에서** 병합 |
| `pattern-telemetry.test.mjs` | 검증 | 이식 시 통합 |

## 규약 준수 (이식 시 지켜야 하는 것)

- **환경 스코프**: 서빙 로그 질의는 `gwWhere(env)` 결과를 `envClause` 로 넘긴다(#64 — local/dev 혼입 차단).
- **"모른다 ≠ 0"**(agreement §4): 미검증 패턴은 `verified=0` 이 아니라 **분모에 남겨** 커버리지로 보인다.
- **route 계약**: `run_pattern`·`mcp_run_pattern` 은 이미 `ROUTE_KO`·`SERVE` 에 있다(0014). 새 값만 추가.
- **드리프트**: 게이트웨이가 '패턴이 게시본과 어긋남'을 `status=500` 으로 돌려준다(`handleRunPattern`) —
  그 신호를 `drift` 로 집계한다.

## 테스트 (지금 바로)

```bash
node --test ops-dashboard/prep/*.test.mjs     # 6건
```

## 이 지표가 왜 임계 경로인가

TO-BE 의 답변 커버리지 = **검증 패턴 커버리지**다. 이 카드가 도메인별 `verified/total` 을 상설로
보여줘야 "commerce 같은 구멍"이 눈에 남고, 드리프트율이 재검증 필요를 알린다(#217 §C 반복 비용).

관련: #192 · #217 · decision/0014(route 계약) · #159/0006(채팅)
