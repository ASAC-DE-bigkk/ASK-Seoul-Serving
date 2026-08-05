# 접근 제어 — 어느 레이어에서 무엇을 막나

> **이 문서는 두 프로젝트가 함께 관리한다.** 지금 무엇이 열려 있고 무엇이 잠겨 있는지,
> 각 잠금이 **어느 레이어에서 동작하는지**, 그리고 **권한이 없어서 못 하는 것**이 무엇인지.
>
> 계기: 2026-08-06 에 `ops.ask-seoul.kr` 이 **인증 없이 열려 있는 것**이 실측으로 확인됐다.

## 0. 한 장 요약

요청이 사용자에서 데이터까지 가는 길에 잠금을 걸 수 있는 자리는 **넷**이다.

```
   사용자
     │
     ▼
 ┌─────────────────────────────────────────────────────────┐
 │ L1  DNS / 라우트        도메인이 워커에 붙어 있나        │  ✅ 우리가 함
 ├─────────────────────────────────────────────────────────┤
 │ L2  Cloudflare 엣지     Access · WAF · IP 규칙 · 레이트   │  ❌ 권한 없음
 ├─────────────────────────────────────────────────────────┤
 │ L3  워커 코드           토큰 게이트 · 버스트 · 쿼터       │  ✅ 우리가 함
 ├─────────────────────────────────────────────────────────┤
 │ L4  데이터              마스킹 · 값 미저장 · 스키마 잠금  │  ✅ 우리가 함
 └─────────────────────────────────────────────────────────┘
     │
     ▼
   D1 (운영)
```

🔴 **L2 가 통째로 비어 있다.** Cloudflare 계정(`Dy950328@…`) 권한이 없어서다 — 아래 §5.
그래서 지금은 **L3(코드)가 사실상 유일한 방벽**이다.

---

## 1. L1 — DNS / 라우트

**무엇을 막나**: 아무것도. 이 레이어는 "누가 이 워커에 닿을 수 있나"의 **주소**를 정할 뿐이다.
호스트를 떼면 그 URL 로는 못 오지만, 워커 자체는 살아 있다.

### 동작 방법

`wrangler.toml` 의 `routes` 가 커스텀 도메인을 워커에 붙인다.

```toml
# ops-dashboard/wrangler.toml
[env.production]
routes = [
  { pattern = "ops.ask-seoul.kr", custom_domain = true }
]
```

### 설정 방법 — 실제 예제

지금 붙어 있는 것을 확인한다:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/domains" \
  | jq -r '.result[] | "\(.hostname)  ->  \(.service)"'
```

```text
transit.ask-seoul.kr   ->  ask-seoul-transit-api
dev.ask-seoul.kr       ->  ask-seoul-gateway-dev
dev-ops.ask-seoul.kr   ->  ask-seoul-ops-dashboard-dev     ← 폐기했다고 적었는데 살아 있다
ops.ask-seoul.kr       ->  ask-seoul-ops-dashboard
```

⚠️ **`wrangler.toml` 에서 `routes` 를 지우고 재배포해도 커스텀 도메인은 남는 경우가 있다.**
설정과 실체가 갈리므로 **위 명령으로 실물을 확인**한다. 실제로 `dev-ops.` 가 그렇게 남아 있다.

떼려면:

```bash
curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/domains/<domain_id>"
```

### 한계

**이건 잠금이 아니다.** 주소를 감추는 것에 가깝다 — `workers.dev` 주소나 다른 경로가 열려
있으면 그대로 닿는다. L1 만으로 보호했다고 여기면 안 된다.

---

## 2. 🔴 L2 — Cloudflare 엣지 (지금 **못 쓴다**)

**무엇을 막나**: 요청이 **워커에 닿기 전에** 끊는다. 가장 바깥이고 가장 싸다 — 워커가
실행되지도 않으므로 비용도 안 든다.

### 여기서 할 수 있었던 것

| 기능 | 무엇을 하나 | 이 프로젝트에서의 쓸모 |
|---|---|---|
| **Access (Zero Trust)** | 로그인(Google·GitHub·OTP) 뒤로 호스트를 넣는다 | **사람 단위** 접근 제어 — "누가 봤나"가 남는다 |
| **WAF 커스텀 규칙** | 국가·경로·UA 로 차단 | `/api/keys` 를 사내 IP 로 한정 |
| **IP 접근 규칙** | 특정 IP만 허용 | 팀 6명이 고정 IP 면 가장 간단 |
| **Rate limiting** | 초당 요청 상한 | 콘솔 스크래핑 방지 |
| **Bot Fight Mode** | 자동 크롤러 차단 | 검색엔진 색인 방지 보강 |

### 왜 못 쓰나 — 실측

```bash
ACC=0d39ddce1c07c97df66843ede19f56c4
for ep in "accounts/$ACC/access/apps" "zones/$Z/rulesets" \
          "zones/$Z/firewall/access_rules/rules" "zones/$Z/settings/security_level"; do
  curl -s -o /dev/null -w "%{http_code}  $ep\n" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/$ep"
done
```

```text
403  accounts/…/access/apps                 ← Access
403  zones/…/rulesets                       ← WAF
403  zones/…/firewall/access_rules/rules    ← IP 규칙
403  zones/…/settings/security_level        ← 보안 수준
```

계정이 **`Dy950328@gmail.com's Account`** 이고 우리 토큰에 그 권한이 없다.
**계정 소유자만 열 수 있다** — §5 참조.

### 왜 "다른 계정에 세팅"이 답이 아닌가

- **Access 는 zone 이 속한 계정에서만 건다.** 다른 계정의 Access 앱은 이 호스트를 못 잡는다.
- **워커를 다른 계정으로 옮길 수도 없다.** D1(`ask-seoul-prod-d1`)이 이 계정에 있고 **D1 은
  계정 간 바인딩이 안 된다.** 옮기면 콘솔이 데이터를 못 본다 — 존재 이유가 사라진다.

---

## 3. L3 — 워커 코드 (**지금 유일한 방벽**)

### 3-1. 콘솔 토큰 게이트

**무엇을 막나**: `/api/*` 전부. 토큰 없으면 데이터가 한 줄도 안 나간다.

#### 동작 방법

세 상태로 갈린다([decision/0004](../ops-dashboard/docs/decision/0004-read-open-write-token.md) 개정).

| 상태 | 응답 | 뜻 |
|---|---|---|
| `OPS_TOKEN` 미설정 | **503** | fail-closed — 배포본은 시크릿 넣기 전까지 아무것도 안 낸다 |
| 설정 + 토큰 없음/틀림 | **401** | |
| 설정 + 올바른 토큰 | 통과 | 조회와 조치가 **같은 토큰** |

게이트는 **라우터 맨 앞 한 곳**에서 건다 — 라우트마다 붙이면 새 엔드포인트에서 빠뜨리고,
그게 곧 공개 노출이다.

```js
// ops-dashboard/src/index.js
if (url.pathname.startsWith("/api/")) {
  const denied = requireRead(env, request);
  if (denied) return denied;
}
```

#### 설정 방법 — 실제 예제

```bash
# 로컬
cd ops-dashboard
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
npm run dev

# 배포본 — 이걸 안 하면 콘솔이 503 으로 잠긴 채다(의도된 기본값)
npx wrangler secret put OPS_TOKEN --env production
```

#### 확인 — 세 상태를 다 본다

```bash
BASE=https://ops.ask-seoul.kr

curl -s -o /dev/null -w "토큰 없이      %{http_code}\n" "$BASE/api/summary?days=1"
curl -s -o /dev/null -w "틀린 토큰      %{http_code}\n" -H "authorization: Bearer wrong" "$BASE/api/summary?days=1"
curl -s -o /dev/null -w "올바른 토큰    %{http_code}\n" -H "authorization: Bearer $OPS_TOKEN" "$BASE/api/summary?days=1"
```

```text
토큰 없이      401     (시크릿 미설정이면 503)
틀린 토큰      401
올바른 토큰    200
```

#### 한계 — **이게 Access 를 대신하지 못한다**

- **공유 토큰 하나다.** 사람 단위가 아니고, **"누가 봤나·누가 지웠나"가 안 남는다.**
- 토큰을 아는 사람 전부가 운영 데이터를 본다.
- **정적 페이지(HTML·JS)는 계속 열려 있다** — `run_worker_first = ["/api/*"]` 라 Assets 가
  먼저 서빙한다. 데이터는 안 나가고 화면은 잠금만 뜬다. 콘솔의 **존재**는 숨기지 못한다.

### 3-2. 게이트웨이 — 키 인증 · 버스트 · 쿼터

**무엇을 막나**: 외부 API 소비자. 콘솔과 **다른 문**이다.

| 층 | 무엇 | 어디서 |
|---|---|---|
| **키 인증** | `Authorization: Bearer ask_…` 전 경로 필수 | `authenticate()` |
| **버스트** | 분당 상한(기본 60) — **인증 뒤·처리 앞** | `checkBurst()` |
| **일일 쿼터** | 키별 하루 상한. 메타 조회는 안 깎는다 | `_usage` |

```bash
# 실제 예제 — 버스트를 넘겨 본다
K=ask_...
for i in $(seq 1 70); do
  curl -s -o /dev/null -w "%{http_code} " "http://localhost:8787/api/v1/data/d1_age_band?limit=1" \
    -H "authorization: Bearer $K"
done
# → 200 이 60개쯤 나오다 429 로 바뀐다. 429 에는 Retry-After 헤더가 붙는다
```

> 버스트를 **인증 뒤**에 두는 이유: 키 없는 요청이 남의 버킷을 밀어 올리면 안 된다.
> **처리 앞**에 두는 이유: 막힌 요청도 관측에 남아야 한다(#63 에서 이 순서 때문에
> 429 가 툴 이름을 못 남기던 것을 고쳤다).

### 3-3. 스키마 잠금 (`npm run d1`)

**무엇을 막나**: 사람이 실수로 **남의 표 모양**을 바꾸는 것.

```bash
cd ops-dashboard
npm run d1 -- "SELECT COUNT(*) FROM _ops_run_event"          # 통과
npm run d1 -- "UPDATE _keys SET daily_quota=500 WHERE …"     # 경고 찍고 통과
npm run d1 -- "ALTER TABLE _keys ADD COLUMN x TEXT"          # ❌ 거절
```

```text
d1: 스키마 변경(ALTER)은 이 경로로 하지 않는다.
  · 콘솔 소유 표  → migrations/ 에 파일을 더하고 `npm run migrate`
  · 남의 표        → 소유자에게 요청한다 (marketplace/ · ASAC-DAG)
```

DDL 은 **대상 표가 무엇이든** 막는다 — 장부를 안 거친 스키마 변경은 다음 사람의
`migrate` 를 어긋나게 하기 때문이다.

---

## 4. L4 — 데이터

**무엇을 막나**: 뚫렸을 때 **나가는 것의 양**. 앞 레이어가 실패해도 남는 마지막 줄이다.

| 규약 | 무엇 | 근거 |
|---|---|---|
| **이메일 마스킹은 서버에서** | 응답에 `email_masked`(`lu***@gmail.com`) 만. 원문 없음 | 화면에서만 가리면 API·devtools·curl 에 원문이 남는다 |
| **요청 값을 저장하지 않는다** | 필터는 **컬럼명 축**만. 값은 안 남는다 | 로그가 새도 질의 내용이 안 샌다 |
| **키 식별자는 `key_hash`** | prefix 는 충돌한다. 해시는 자격증명이 아니다 | 해시를 알아도 호출은 못 한다 |
| **응답은 `no-store`, 페이지는 `noindex`** | 캐시·검색 색인 방지 | |

```bash
# 실제 예제 — 원문 이메일이 응답에 없는지 본다 (통과 기준: 0줄)
curl -s -H "authorization: Bearer $OPS_TOKEN" "$BASE/api/keys" | jq -r '.keys[].email' 2>/dev/null
# → null 또는 오류. `email` 키 자체가 없다. 있는 건 email_masked 뿐이다
```

---

## 5. 🔴 권한이 없어 **못 하는 것** — 계정 소유자 요청 사항

지금 계정은 **`Dy950328@gmail.com's Account`**(`0d39ddce…`)이고, 우리 토큰에는 Workers·D1·
Zone 읽기만 있다. 아래는 **계정 소유자만** 할 수 있다.

| # | 필요한 것 | 왜 | 없으면 |
|---|---|---|---|
| 1 | **Cloudflare Access** 를 `ops.ask-seoul.kr` **에 한정해서** | 사람 단위 접근 제어 + "누가 봤나" 기록 | 공유 토큰 하나로 버틴다. 감사 불가 |
| 2 | API 토큰에 **Access:Edit** | 위를 코드/CI 로 관리 | 대시보드 수동 작업만 가능 |
| 3 | **WAF / IP 접근 규칙** | 콘솔을 사내 IP 로 한정 | 주소를 아는 사람 누구나 도달(잠금은 L3 뿐) |
| 4 | **Rate limiting** | 스크래핑·무차별 대입 방지 | 워커가 매 요청 실행 — 비용도 우리 몫 |

> ⚠️ **Access 를 걸 때 범위를 반드시 `ops.ask-seoul.kr` 로 한정한다.** zone 전체나
> `*.ask-seoul.kr` 로 걸면 **공개 API(`ask-seoul.kr`·`dev.`)까지 로그인 뒤로 잠긴다.**
> 외부 소비자가 못 쓰게 된다.

---

## 6. 지금 상태 요약

| | 열림/잠김 | 무엇이 막나 |
|---|---|---|
| 콘솔 `ops.ask-seoul.kr` — 페이지 | 🟡 열림 | 데이터는 없음. 잠금 화면만 |
| 콘솔 `/api/*` | ✅ **잠김** | L3 토큰 게이트 (2026-08-06~) |
| 콘솔 조치(폐기·삭제) | ✅ 잠김 | 같은 토큰 + 화면 2단 확인 |
| `dev-ops.ask-seoul.kr` | 🔴 **떠 있음** | 폐기했다고 적었으나 도메인이 남아 있다 — 정리 필요 |
| 게이트웨이 API | ✅ 키 인증 + 버스트 + 쿼터 | 의도된 공개 서비스 |
| **사람 단위 접근 제어** | 🔴 **없음** | Access 미확보(§5) |
| **감사 로그(누가 했나)** | 🔴 **없음** | 공유 토큰 하나 |

---

## 7. 이 구성은 **1인 프로젝트에도 그대로 쓸 수 있다**

여기 쓴 것 중 **팀 규모나 조직 계정이 있어야 하는 건 L2 뿐**이고, 나머지는 전부 개인
프로젝트에서 그대로 재현된다. 오히려 1인 프로젝트일수록 **L3·L4 를 코드로 갖는 것**이
중요하다 — 리뷰해 줄 사람이 없기 때문이다.

### 그대로 쓸 수 있는 것

| 레이어 | 기술 | 1인 프로젝트에서 |
|---|---|---|
| L1 | Cloudflare Workers + 커스텀 도메인 | 무료 플랜으로 됨. `workers.dev` 만 써도 됨 |
| L2 | **Cloudflare Access** | **무료 플랜에 포함(50 사용자까지)** — 개인 계정이면 오히려 **권한 문제가 없다** |
| L3 | 워커 코드 토큰 게이트 · 버스트 · 쿼터 | 의존성 0. 이 리포의 `requireRead`·`checkBurst` 가 그대로 예제 |
| L4 | 서버측 마스킹 · 값 미저장 · DDL 가드 | 규약이라 기술 스택과 무관 |
| 데이터 | **D1**(SQLite) + 증분 마이그레이션 + 장부 | 무료 플랜. `wrangler d1 migrations` |
| 배포 | GitHub Actions → `wrangler deploy` | 무료 |

### 개인 계정이면 이 프로젝트의 **막힌 곳이 안 막힌다**

지금 우리가 못 하는 §5 네 가지는 **계정 소유권 문제**이지 기술 한계가 아니다.
자기 계정이면 Access 를 10분이면 건다:

```
Cloudflare 대시보드 → Zero Trust → Access → Applications → Add an application
  · Type            : Self-hosted
  · Application URL : ops.<내도메인>            ← 반드시 호스트 단위로 한정
  · Policy          : Allow · Emails = 내 이메일 (또는 Google/GitHub IdP)
```

그러면 L3 토큰 게이트는 **없애도 되고**, 남겨서 이중으로 둬도 된다.

### 1인 프로젝트에서 특히 값이 나오는 것

- **fail-closed 기본값** — 시크릿을 안 넣으면 503. 혼자 하면 "나중에 잠가야지"를 잊는데,
  잊으면 **안 열리므로** 바로 안다.
- **DDL 가드** — 혼자 운영 DB 를 만지는 상황에서 손이 미끄러지는 것을 코드가 막는다.
- **결정 문서(`decision/`)** — 6개월 뒤의 자신이 "왜 이렇게 했지"를 묻는다. 리뷰어가 없을수록
  근거를 남길 곳이 필요하다.
- **`meta.*` 로 "거른 것을 말하기"** — 혼자 보는 화면일수록 조용히 틀린 숫자를 못 잡는다.

### 반대로 1인 프로젝트에서 **과한 것**

- 두 Worker 분리(콘솔·게이트웨이) — 청중이 하나면 한 워커로 충분하다
- 환경 3종·CD 자동 배포 — 손으로 `wrangler deploy` 해도 된다
- 문서 3층(결정·방향·참조) — `decision/` 하나면 된다

---

관련: [decision/0004](../ops-dashboard/docs/decision/0004-read-open-write-token.md)(토큰 게이트) ·
[0015](../ops-dashboard/docs/decision/0015-single-production-d1.md)(공개 배포의 계기) ·
[environments.md](environments.md)(환경·권한) · [agreement.md](agreement.md) §8(배포 결정)
