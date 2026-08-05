# 수동 작업 — 코드·CI 가 대신 못 하는 것

> **왜 이 문서가 있나** — 자동화되지 않은 운영 작업이 PR 본문·커밋 메시지·이슈에 흩어져
> 있었다. 흩어지면 **"해야 하는데 아무도 안 한 상태"가 조용히 지속된다** — 실제로
> `dev-ops.ask-seoul.kr` 이 "폐기했다"고 적힌 채 두 달 가까이 열려 있었다.
>
> 여기 있는 것은 **사람이 직접 쳐야 하는 명령**과 **그것이 안 됐을 때 무슨 일이 나는지**다.
> 상태는 실측으로 갱신한다 — "했다고 생각한다"가 아니라 확인한 값을 적는다.

**마지막 실측: 2026-08-06**

---

## 0. 한눈에

| # | 무엇 | 누가 | 상태 |
|---|---|---|---|
| [1](#1--콘솔-ops_token-시크릿-설정) | 콘솔 `OPS_TOKEN` 시크릿 | 콘솔 | 🔴 **미완 — 콘솔이 503 으로 잠겨 있다** |
| [2](#2-운영-d1-마이그레이션-적용) | 운영 D1 마이그레이션 | 콘솔 | ✅ 완료 |
| [3](#3-운영-d1-에-게이트웨이-표-만들기) | 운영 D1 게이트웨이 표 | 게이트웨이 | ✅ 완료 (2026-08-06 확인) |
| [4](#4-_ops_slo-를-채우는-경로) | `_ops_slo` 적재 경로 | 파이프라인 | 🟡 미착수 — 탭이 비는 원인 |
| [5](#5-cloudflare-access) | Cloudflare Access | 계정 소유자 | 🔴 권한 미확보 |

---

## 1. 🔴 콘솔 `OPS_TOKEN` 시크릿 설정

### 안 하면

**콘솔 전체가 503 으로 잠긴다.** 지금이 그 상태다.

```bash
$ curl -s https://ops.ask-seoul.kr/api/summary?days=1
{"type":"about:blank","title":"ops console locked","status":503,
 "detail":"OPS_TOKEN 미설정 — 이 콘솔은 조회에도 운영자 토큰이 필요하다(decision/0004 개정). …"}
```

**이건 고장이 아니라 의도된 기본값이다**(fail-closed). 시크릿을 안 넣으면 아무것도 안
내보낸다 — "열린 채 잊히는 것"보다 "안 보여서 바로 아는 것"이 낫다는 판단이다.

### 하는 법

```bash
cd ops-dashboard
npx wrangler secret put OPS_TOKEN --env production
# 프롬프트에 값 입력. 로컬 .dev.vars 의 값과 **같을 필요는 없다** —
# 로컬과 배포본은 각자 자기 토큰을 갖는 게 맞다.
```

토큰 생성:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### 확인

```bash
BASE=https://ops.ask-seoul.kr
curl -s -o /dev/null -w "토큰 없이   %{http_code}\n" "$BASE/api/summary?days=1"
curl -s -o /dev/null -w "올바른 토큰 %{http_code}\n" -H "authorization: Bearer $TOKEN" "$BASE/api/summary?days=1"
```

```text
토큰 없이   401     ← 503 에서 401 로 바뀌면 시크릿이 들어간 것이다
올바른 토큰 200
```

> **CI 는 이걸 하지 않는다.** 배포는 코드만 나간다. 시크릿은 Cloudflare 가 보관하고
> 배포마다 유지되므로 **한 번만** 하면 된다.

---

## 2. 운영 D1 마이그레이션 적용

### 안 하면

콘솔 소유 표(`_ops_slo`·`_ops_domain`)가 없어 '데이터 준비 상태' 탭이 질의 실패로 강등된다.

### 하는 법

```bash
cd ops-dashboard
npm run migrate:list    # 무엇이 남았나 먼저
npm run migrate         # 장부 백필 → apply
```

**CD 는 마이그레이션을 돌리지 않는다.** 코드 배포와 분리돼 있다 — 운영 스키마가 머지
타이밍에 바뀌면 되돌릴 창이 없기 때문이다. 대신 배포 전에 `schema-ready` 잡이
**적용됐는지 읽기로 확인**하고, 미적용분이 있으면 배포를 막는다.

### 상태 — ✅ 완료

```text
$ npm run migrate:list
✅ No migrations to apply!

운영 D1 에 _ops_slo · _ops_domain 존재 확인
```

> 🔴 `migrations/0002`(조회 DB 4종 미러)는 **운영에서 실행되지 않는다.** 거기엔 진짜 표가
> 이미 있고, 그대로 돌리면 `CREATE INDEX` 가 **남의 운영 표에** 만들어진다. 장부 백필이
> "표가 이미 있으면 실행 없이 기록만" 해서 건너뛴다.

---

## 3. 운영 D1 에 게이트웨이 표 만들기

### 안 하면

콘솔의 **응답 상태 · 이용 행동 · API 사용량 · 이용자 키** 네 탭이 빈다.

### 하는 법

게이트웨이 소관이다 — [marketplace/docs/deploy-runbook.md](../marketplace/docs/deploy-runbook.md) 1번.

### 상태 — ✅ 완료 (2026-08-06 실측)

```text
_keys · _usage · _burst · _gateway_request_log   전부 존재
_gateway_request_log  5건   (마지막 2026-08-05T15:33:19Z · env 1종)
_keys 0건 · _usage 0건      ← 표는 있고 아직 트래픽이 안 쌓인 단계
```

2026-08-05 까지는 **표 자체가 없었다.** 그 사이 만들어졌다.

> ⚠️ **이 시점부터 콘솔이 고객 데이터를 다룬다.** `_keys` 에 행이 들어오면 이메일
> 마스킹본·쿼터·사용량이 화면에 뜬다. 읽기 게이트(#93)가 **그 전에** 들어간 것이 다행이다 —
> 순서가 반대였으면 공개 URL 로 고객 정보가 나갔다.

---

## 4. `_ops_slo` 를 채우는 경로

### 안 하면

'데이터 준비 상태' 탭이 **비어 있다.** 표는 있고 행이 0이다 — 화면은 "기록이 없습니다"로
정확히 말한다(고장이 아니다).

### 하는 법

정규 경로는 **culture DAG 의 export task** 다. 이 리포 밖(ASAC-DAG)이고, 팀 D1 쓰기라
승인 주체가 미정이다(agreement §8-3).

🔴 **합성 픽스처를 넣지 않는다.** 운영 D1 이므로 그게 곧 오염이다
([CLAUDE.md §4](../ops-dashboard/CLAUDE.md) — 화면에 모의 데이터를 올리지 않는다).

### 상태 — 🟡 미착수

```text
_ops_slo  0행   (표는 존재)
```

실행 기록 탭은 조회 DB 4종에서 **직접** 읽으므로 이것과 무관하게 동작한다
(2026-08-06 실측: 98일치 · DAG 49건).

---

## 5. Cloudflare Access

### 안 하면

**사람 단위 접근 제어와 감사 로그가 없다.** 지금은 공유 토큰 하나(#1)로 버틴다 —
"누가 봤나·누가 지웠나"에 답할 수 없다.

### 하는 법

계정(`Dy950328@gmail.com's Account`) 권한이 필요하다. 우리 토큰은 403 이다.

```text
Zero Trust → Access → Applications → Add an application
  Type            : Self-hosted
  Application URL : ops.ask-seoul.kr      ← ⚠️ 반드시 호스트 단위로 한정
  Policy          : Allow · 팀 이메일 (또는 Google/GitHub IdP)
```

> ⚠️ **범위를 zone 전체나 `*.ask-seoul.kr` 로 걸면 공개 API(`ask-seoul.kr`·`dev.`·MCP)까지
> 로그인 뒤로 잠긴다** — 외부 소비자가 못 쓴다(#20 결정 B-1).

### 상태 — 🔴 권한 미확보

배경·실측 권한 지도는 **#94** 와 [access-control.md](access-control.md).
**언제 될지 정해진 바 없다.** 그때까지 #1 의 토큰 게이트가 그 자리를 대신한다.

---

## 갱신 규칙

- **상태 칸은 실측으로 채운다.** 각 항목의 "확인" 명령을 실제로 돌린 값만 적는다.
- 항목을 완료하면 **지우지 말고 ✅ 로 바꾸고 실측을 남긴다** — 언제 됐는지가 다음 사람에게
  필요한 정보다.
- 새 수동 작업이 생기면 **여기 먼저 적고** PR 본문에서 이 문서를 가리킨다.
  PR 본문에만 적으면 머지된 뒤 아무도 안 본다.

관련: [run-prod.md](run-prod.md)(콘솔 실행 절차) · [access-control.md](access-control.md)(접근 제어) ·
[environments.md](environments.md)(환경 규약) · #94 · #85
