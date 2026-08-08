# qa-lab 테스트 매뉴얼 (마스터) — 로컬 · 서비스 모두

이슈 #192 검증용 테스트 랩을 **순차적으로** 돌려 보는 절차서다. 두 화면을 함께 다룬다.

- **마켓 테스트 콘솔** — MCP 6종·REST 요청·검증 (이 폴더: `marketplace/public/qa-lab/`)
- **대시보드 비교 화면** — 기존형↔신설형 지표 비교 (`ops-dashboard/public/qa-lab/`, 절차는 §5)

> 이 매뉴얼도 부가물이다 — 폴더를 지우면 함께 사라진다. 근간 코드는 건드리지 않는다.

---

## 접속 경로 한눈에

| 대상 | 로컬 (`npm run dev`) | 서비스 (배포) |
| --- | --- | --- |
| 마켓 테스트 콘솔 | http://localhost:8787/qa-lab/ | https://ask-seoul.kr/qa-lab/ |
| 대시보드 비교 화면 | http://localhost:8788/qa-lab/ | https://ops.ask-seoul.kr/qa-lab/ |
| wrangler 없이 즉시 확인 | 파일 더블클릭 + base=`https://ask-seoul.kr` | — |

- **로컬**은 게이트웨이를 내 PC에서 띄운다 — 실데이터를 보려면 **팀 Cloudflare 계정** 접근이 필요(§B-0).
- **서비스**는 이미 배포된 게이트웨이를 쓴다 — 계정·wrangler 불필요. **MCP 라이브까지 완전 동작**(동일 출처).
- 모든 호출에 식별자 **`max20_fable`** 가 실린다 — 로그 확인은 §6.

---

## 0. 준비물 (공통)

- Node 18+ 설치.
- 의존성 설치(처음 한 번): `cd marketplace && npm install` · `cd ../ops-dashboard && npm install`.
- **인증 도구(query_product·run_pattern·check_quota) 테스트용 API 키 1개** — 발급은 §3.
  무인증 도구(list_products·describe_product·preview_product·catalog)는 키 없이도 된다.

---

# A. 서비스(배포)에서 테스트 — 가장 간단, 권장 시작점

계정·로컬 구동 없이 바로 된다. **MCP 라이브까지 전부 동작**한다(페이지가 게이트웨이와 동일 출처).

### A-1. 배포 여부 확인
- 이 랩이 배포에 올라갔는지 확인: 브라우저로 **https://ask-seoul.kr/qa-lab/** 접속 → 페이지가 뜨면 배포됨.
  - 안 뜨면 아직 미배포다. 마켓플레이스는 `main` 머지 시 CD 배포(=팀 절차). 그전엔 §D(파일 열기)로 확인.
- 대시보드는 **https://ops.ask-seoul.kr/qa-lab/** (ops-dashboard는 `dev` 머지가 곧 배포).

### A-2. 키 발급 → §3

### A-3. 마켓 콘솔 시나리오 → §4  ·  대시보드 비교 → §5  ·  식별자 로그 확인 → §6

---

# B. 로컬에서 테스트 — 실데이터로 게이트웨이 구동

### B-0. 계정 확인 (제일 먼저)

로컬 구동은 **운영 D1(remote)** 에 직접 붙는다. 그 D1(`ask-seoul-prod-d1`)이 있는 **팀 Cloudflare
계정**으로 로그인돼 있어야 한다.

```powershell
cd marketplace
npx wrangler whoami        # 어떤 계정인지
npx wrangler d1 list       # ask-seoul-prod-d1 (59a8409e-…) 가 보여야 정상
```

- `d1 list`가 비어 있거나 그 DB가 안 보이면 **계정이 틀린 것** → `npx wrangler logout` 후
  `npx wrangler login` 으로 팀 계정 소속 Google 계정으로 다시 로그인. 계정이 안 보이면 팀
  관리자에게 Cloudflare 계정 멤버 초대 요청.
- 원격 dev 첫 실행 시 "workers.dev subdomain 등록" 오류가 나면, 안내 링크에서 서브도메인을 한 번
  등록(무료·안전 — `workers_dev=false`라 워커가 공개되지는 않는다).

> 🔴 로컬 구동은 운영 데이터를 만진다. 발급한 테스트 키는 §7에서 반드시 지운다.

### B-1. 마켓 게이트웨이 실행
```powershell
cd marketplace
npm run dev            # → http://localhost:8787
```
바인딩 표에 `env.DB … remote`, `env.ASK_ENV ("local")` 가 뜨고 remote 연결이 성립하면 성공.

### B-2. (동시) 대시보드 콘솔 실행 — 다른 터미널에서
```powershell
cd ops-dashboard
npm run dev            # → http://localhost:8788
```

### B-3. 접속
- 마켓 콘솔: **http://localhost:8787/qa-lab/** (base 칸은 **비워 둔다** = 현재 출처 = 로컬 게이트웨이)
- 대시보드: **http://localhost:8788/qa-lab/** (base 칸은 `http://localhost:8787` 로 — 게이트웨이 로컬 주소)

### B-4. 키 발급 → §3  ·  시나리오 → §4·§5  ·  로그 확인 → §6  ·  정리 → §7

---

# C. wrangler 없이 즉시 확인 (파일 열기)

로컬 구동·계정 없이 화면만 보고 무인증·REST를 시험하는 최단 경로.

1. `marketplace/public/qa-lab/index.html` 을 브라우저로 더블클릭(파일 열기).
2. "게이트웨이 주소(base)" 에 **`https://ask-seoul.kr`** 입력.
3. 무인증 도구(list_products·describe_product·preview_product, REST catalog/preview)와 §7의 패턴
   변환 미리보기가 바로 동작한다.
   - **제약**: MCP 라이브 호출(`/mcp`)은 응답에 CORS 헤더가 없어 **교차 출처(파일 열기 포함)에서 막힌다.**
     MCP 라이브까지 보려면 **A(배포본)** 또는 **B(로컬 동일 출처)** 로 연다.

---

## 3. API 키 발급 (인증 도구용)

키 발급은 Google OAuth 경로뿐이다(이메일 발급 폐지). **로컬은 기본적으로 OAuth가 꺼져 있어**,
배포 사이트에서 받는 게 가장 간단하다.

1. https://ask-seoul.kr → 카탈로그(시작하기/키 발급) → **Google 로그인**.
2. **키가 한 번만 표시**된다 → 즉시 복사(서버엔 해시만 저장돼 다시 못 본다).
3. 이 키를 qa-lab(로컬이든 배포든)의 "API 키(Bearer)" 칸에 붙여넣는다.

> 계정당 키 1개. 잃어버리면 `DELETE /api/v1/keys` 로 폐기 후 재발급.

---

## 4. 마켓 테스트 콘솔 — 도구별 순차 시나리오

각 단계의 "기대"가 맞는지 확인하며 내려간다. (배포본이면 base 비움, 로컬이면 base 비움/로컬주소)

| # | 조작 | 입력 | 기대 결과 |
| --- | --- | --- | --- |
| 1 | **연결 확인** 버튼 | — | `✔ 연결됨 · 서버 ask-seoul v0.1.0 · 식별자 max20_fable 등록` |
| 2 | **제품 목록 불러오기** | — | `제품 57종 로드됨`, 아래 제품 브라우저 표시(57종·431패턴) |
| 3 | 전송=MCP, 도구=`list_products`, **보내기** | — | MCP 200 · 제품 목록 JSON |
| 4 | `describe_product` | product_id=`commerce_address_succession` | 컬럼·시간축·usage_patterns 포함 응답 |
| 5 | `preview_product` | 같은 product_id | 5행 표 + JSON (무차감) |
| 6 | `query_product` ⟨기존형·AS-IS⟩ | product_id + filters `{"gu_code":"11680"}` + limit `20` | 원시 행 표 · 쿼터 1 차감(헤더/usage) |
| 7 | `run_pattern` ⟨신설형·TO-BE⟩ | product_id=`commerce_address_succession`, pattern_id=`category_net_flow`, params `{}` | 계산된 결과 행 + `insight_sample_ko` + `verified` |
| 8 | `check_quota` | — | 오늘 사용량/한도 (이메일 없이) |
| 9 | **대시보드 비교용으로 복사** (6·7 실행 후) | — | 클립보드에 결과 JSON — §5-5에서 붙여넣기 |

빠른 채움: 각 도구 아래 **예시 칩**을 누르면 실제 product_id/pattern_id 가 채워진다.
제품 브라우저에서 **패턴 개수(예: 14개)** 를 누르면 run_pattern 폼으로 전환되고 패턴 목록이 칩으로 뜬다.

### 4-1. 패턴 변환 미리보기 (#192 P1·P3 승격 후보)
1. "제품 목록 불러오기"로 카탈로그 로드(§4-2).
2. 카드 ④에서 product_id·pattern_id 입력 → SQL이 자동 채워진다.
3. `params` 에 `{"n":10}` (또는 배열 `{"gus":["11680","11650"]}`), `param_defaults` 에 `{"min_biz":100}` 등 입력.
4. **변환 미리보기** → 오른쪽에 **converted SQL** 과 **bind values** 표시.
   - P3 배열은 `IN (?,?,?)` 로 전개, P1 기본값은 미전달 시 채워짐, 선언 밖/누락은 problem+json 400.
   - (실제 D1 실행이 아니라 **변환만** 미리 보는 것 — 실행은 run_pattern이 한다.)

---

## 5. 대시보드 비교 화면 — 순차 시나리오

(상세는 `ops-dashboard/public/qa-lab/TESTING.md` 에도 있음)

1. 게이트웨이 주소 확인(배포 `https://ask-seoul.kr` / 로컬 `http://localhost:8787`) → **카탈로그 불러와 비교 시작**.
2. **헤드라인**: "기존형으로 답 가능 %" vs "신설형 필요 %" 두 큰 숫자 확인
   (실측 기준 대략 **1.2% vs 98.8%**).
3. **능력별 막대**: `sort`·`aggregate`·`group_by` … 각 능력을 요구하는 패턴 비율. 빨강 = 기존형 미지원.
4. **질문 하나로 나란히 보기**: 제품·패턴 선택 → 좌(기존형)·우(신설형) 카드 + 하단 **지표 표**
   (요청 범위·답변 범위·AI 질의 접근성·정보 제공 정확성·답 가능 여부).
5. (키 있으면) **기존형 라이브 조회** → `/api/v1/data` 로 원시 행 수 실측.
6. (선택) 마켓 콘솔 §4-9에서 복사한 **신설형 결과 JSON** 을 하단 "붙여넣기" 칸에 넣고 **반영** →
   신설형 라이브 행 수가 지표에 반영된다(교차 출처 MCP 우회).

---

## 6. 식별자(`max20_fable`) 로그 확인

우리 테스트 트래픽이 로그에 남았는지 확인한다(실데이터 기준 — 배포 또는 로컬 remote).

- 콘솔(ops.ask-seoul.kr 또는 localhost:8788)의 **'이용 행동'** 탭에서
  `agent_name = max20_fable`(MCP initialize) · `intent = max20_fable`(툴/REST) 로 우리 요청을 식별.
- 값은 연결 설정의 "요청 식별자" 칸에서 바꿀 수 있다(기본 `max20_fable`).

---

## 7. 정리 (cleanup)

- **테스트 키 삭제**(로컬 remote·배포 모두 운영 `_keys` 에 남는다):
  ```bash
  curl -X DELETE 'https://ask-seoul.kr/api/v1/keys?purge=true' -H 'Authorization: Bearer ask_…'
  # 로컬이면 http://localhost:8787
  ```
- **랩 전체 소거**(기능 자체를 없앨 때):
  ```bash
  rm -rf marketplace/public/qa-lab ops-dashboard/public/qa-lab
  ```
  근간에 참조가 없어 그 외 작업은 필요 없다.

---

## 8. 검증 체크리스트

- [ ] 연결 확인에서 서버 정보 + `max20_fable 등록` 표시
- [ ] list_products 57종 · describe/preview 정상
- [ ] query_product(기존형)로 원시 행 수신 · 쿼터 1 차감
- [ ] run_pattern(신설형)로 계산 결과 + insight 수신
- [ ] 패턴 변환 미리보기에서 P1(기본값)·P3(배열 IN) 동작, 선언 밖 파라미터 400
- [ ] 대시보드 헤드라인 1.2%/98.8% · 능력별 막대 표시
- [ ] 지표 표에서 기존형 "답 불가"/신설형 "가능" 판정
- [ ] 이용 행동 탭에서 `max20_fable` 식별 확인
- [ ] 테스트 키 purge 완료
