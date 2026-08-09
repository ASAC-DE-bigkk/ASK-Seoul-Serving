# marketplace/prep — TO-BE 이행 **게이트웨이(GW) 준비물** (미배선 · 이식 후보)

이슈 [#192](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/issues/192) TO-BE 이행에서 게이트웨이가
맡을 부분을, **현재 시스템에 적용하지 않은 채** 미리 만들어 둔 폴더다. 결정(#217)이 서면 각 파일을
`src/` 로 이식한다.

## 🔴 성격 — 근간 무수정 · 미배선 · 폴더 삭제로 소거

- **어디에도 `import` 되지 않는다.** `src/index.js`(`main`)·`public/`(assets)·`wrangler.toml` 중
  무엇도 이 폴더를 참조하지 않으므로 **운영에서 절대 실행되지 않는다.**
- 기존 검사 무영향: `npm test`(= `scripts/*.test.mjs` + partials 체크)는 `prep/` 를 안 본다.
- **소거**: `rm -rf marketplace/prep` — 참조가 없어 그 외 작업 불필요.

## 파일과 이식 지점

| 파일 | #192 항목 | 이식 지점(적용 시) |
|---|---|---|
| `pattern-audit.mjs` | **P0** 테이블 스코프 검사 | `handleRunPattern` 의 `env.DB.prepare(converted).bind(...).all()` **직전** — `scopeGate(converted, allowedTables)` 위반 시 400 `pattern out of scope` |
| `run-pattern-ext.mjs` | **P1**(기본값)·**P2**(커서)·**P3**(배열)·**P4**(함수 허용목록)·**P5**(피벗)·**P6**(식별자 슬롯) | `convertPattern` 은 `handleRunPattern` 의 **변환부**(주석제거→SELECT/WITH 확인→`:이름`→`?`→값 해석·클램프)를 대체. P2/P5 는 실행 후처리. **P6 는 기본 비활성**(P0·보안 리뷰 전 금지) |
| `run-pattern-rest.candidate.md` | 특이사항 ② | `run_pattern` 의 REST 문 개방 후보(라우팅 결정). **결정 대기** |
| `mcp-cors.candidate.md` | 특이사항 ① | `index.js` 응답 마무리 자리(문서 참조). **결정 대기** |
| `catalog-snapshot.json` | (테스트 픽스처) | 이식 안 함 — 431 패턴 오프라인 회귀용 |
| `*.test.mjs` | (검증) | 이식 시 `scripts/` 로 옮겨 `npm test` 에 편입 |

## 테스트 (지금 바로)

```bash
node --test marketplace/prep/*.test.mjs      # 46건 중 GW 40건(auditor 28 + ext 12)
```

## 준비 상태 (결정 전 실측)

- **P0 감사기**: 실제 카탈로그 **431 패턴 전량 오탐 0**(서빙 테이블 allowlist), 내부표 참조 0.
  레드팀 15종(콤마조인·JOIN·파생테이블·스칼라서브쿼리·스키마한정 `main._keys`·`pragma_*`·
  스택쿼리·CTE 내부표·UNION·ATTACK) **전부 거부**. 토크나이저 기반(정규식 우회 불가).
- **설계 발견**: 431 중 **9 패턴이 형제 서빙 테이블을 읽는다**(422/431 만 자기 테이블만 사용).
  → **P0 allowlist 는 제품 단위가 아니라 도메인/서빙 단위**여야 그 9 개가 안 깨진다. 이식 시 반영.
- **P1·P3**: 431 패턴 변환 스윕 무회귀(qa-lab `pattern-plus.js` 와 같은 로직의 서버 정본).
- **P6**: 순수 구현 + 3중 방어(allow 필수·정확일치·치환후 재감사)까지 있으나 **기본 비활성**.

관련: #192 · #217 · qa-lab `pattern-plus.js`(브라우저 미리보기 버전)
