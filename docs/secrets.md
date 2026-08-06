# 시크릿·자격증명 — 한 곳에 모은다

> **왜 이 문서가 있나** — 토큰·자격증명 이야기가 `environments`·`run-prod`·`access-control`·
> `runbook`·`setup`·README 에 조금씩 흩어져 **같은 걸 여러 번 다르게** 적고 있었다. 흩어지면
> 한 곳만 고쳐지고 나머지가 조용히 거짓말을 한다. 그래서 여기를 **정본**으로 둔다 —
> 다른 문서는 자기 흐름에 필요한 **실행 명령만** 남기고, "무엇이·어디에·왜"는 이리로 링크한다.
>
> 🔴 **값 자체는 여기에도 안 적는다.** 이 문서는 이름·위치·설정법·권한만 말한다. 실제 토큰은
> 파일(`.dev.vars`·`.env`)이나 Cloudflare 안에만 있고, 어느 문서에도 적지 않는다.

**마지막 갱신: 2026-08-06**

---

## 0. 한눈에

| 이름 | 무엇에 쓰나 | 누가 읽나 | 로컬 위치 | 배포본 위치 | 권한 |
|---|---|---|---|---|---|
| `OPS_TOKEN` | 콘솔 접근 잠금(조회·조치) | Worker (`env.OPS_TOKEN`) | `.dev.vars` | `wrangler secret put`(§2) | — |
| `CLOUDFLARE_API_TOKEN` | 원격 D1 접속·배포 | **wrangler 도구** | `.env` | 배포자·CI(GitHub Secrets §4) | 하는 일에 맞춰(§3) |
| `CLOUDFLARE_ACCOUNT_ID` | 계정 식별 | wrangler 도구 | `.env` | 〃 | — |
| `ISSUANCE_SALT` 등 | 게이트웨이(키 발급) | Worker | `marketplace/.dev.vars` | `secret put` | **마켓플레이스 소관 → §5** |

두 갈래로 갈린다: **Worker 안에서 읽는 값**(`OPS_TOKEN`·`ISSUANCE_SALT`)과 **wrangler 라는 도구가
읽는 값**(`CLOUDFLARE_*`). 역할이 다르지만 보관 규칙은 하나다.

---

## 1. 규칙 하나 — 로컬은 파일, 배포는 파일 밖

| 파일 | 누가 읽나 | 무엇 |
|---|---|---|
| `.dev.vars` | **Worker 안** | `env.OPS_TOKEN`·`env.ISSUANCE_SALT` — 화면·발급 기능이 런타임에 읽는 값 |
| `.env` | **wrangler 도구** | `CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_ACCOUNT_ID` — 원격 D1 접속·배포용 |

- **로컬은 파일**(`.dev.vars`·`.env`), **배포본은 파일 밖**(`wrangler secret put` — §2). wrangler 는 설정
  파일 옆의 `.env` 를 자동으로 읽는다(플래그 불필요). `.dev.vars` 도 설정 파일 옆(프로젝트 루트).
- **환경별 시크릿 파일을 만들지 않는다.** `.dev.vars.production`·`.env.production` 을 두면 *운영
  시크릿이 로컬 파일에 있다*는 뜻이 되고, 그 자체가 유출 경로다. 배포 시크릿은 Cloudflare 가
  보관하고, 자격증명은 배포하는 사람·CI 가 가진다.
- 둘 다 `.gitignore` 대상이고, 값이 빈 `.env.example`·`.dev.vars.example` 만 추적한다.
- ⚠️ **Windows 에서 `.dev.vars`·`.env` 를 셸로 만들 때 인코딩을 지정하지 않으면 UTF-16LE 로 저장돼
  조용히 안 읽힌다.** PowerShell 은 `-Encoding ascii` 를 빼지 말 것 — 증상·해법은 [setup.md §3](setup.md).

배경(왜 환경별 파일 대신 이 규칙인가)은 [environments.md §1-2](environments.md) · [agreement.md](agreement.md).

---

## 2. 배포본에 시크릿 넣기 — `wrangler secret put`

```bash
cd ops-dashboard
npx wrangler secret put OPS_TOKEN --env production
#   Enter a secret value: ●●●●●●●●   ← 프롬프트에 값 입력(대화형)
```

배포 시크릿의 성질 — 다른 문서에 흩어져 있던 오해 지점들을 여기 모은다:

- **어디에 저장되나** — D1 도 파일도 아니다. Cloudflare 가 보관하는 **암호화된 Worker 시크릿**이고,
  그 Worker(`ask-seoul-ops-dashboard`) + 그 환경(`production`)에만 묶여 런타임에 `env.OPS_TOKEN` 으로
  주입된다. `--env production` 은 `wrangler.toml` 의 `[env.production]` 을 고른다.
- 🔴 **한 번 넣으면 되읽을 수 없다** — 덮어쓰기·삭제만 된다. 그래서 이 문서에도 값을 안 적는다.
- **`put` 하는 순간 새 배포 버전이 자동으로 뜬다** — `deploy:prod` 를 다시 돌릴 필요 없이 수초 내
  반영된다(코드는 이미 배포돼 있어야 한다).
- **인증이 선행돼야 한다** — `secret put` 은 Worker 를 고치므로, 이 Worker 를 배포할 수 있는 계정으로
  로그인돼 있어야 한다(`npx wrangler login` 또는 `.env` 의 `CLOUDFLARE_API_TOKEN`). 권한은 §3.
- **한 번만 하면 된다** — 시크릿은 배포마다 유지된다. **CI 는 이걸 하지 않는다**(코드만 배포).

> 비대화형(`echo "값" | npx wrangler secret put …`)도 되지만 값이 셸 히스토리에 남으니 프롬프트를 권한다.

---

## 3. `CLOUDFLARE_API_TOKEN` 권한 — 하는 일에 맞춘다

토큰 권한이 곧 사고 반경이다. 필요한 만큼만 준다.

| 하는 일 | 필요한 권한 |
|---|---|
| 콘솔을 **보기만**(원격 D1 읽기) | `D1:Read` — 조치 버튼을 눌러도 실패한다(실수로 지울 일이 없다) |
| 콘솔에서 **조치**(D1 쓰기: 폐기·복구·쿼터·삭제) | `D1:Edit` — 실제 고객 키를 지울 수 있다 |
| **배포·시크릿 등록**(`deploy:prod`·`secret put`) | `Workers Scripts:Edit` |

- **평소에는 `D1:Read` 를 권한다.** 조치할 일이 생겼을 때만 올린다.
- 🔴 **콘솔은 토큰 권한이 사실상 마지막 바깥 방어선이다.** D1 이 운영 하나뿐이라
  ([0015](../ops-dashboard/docs/decision/0015-single-production-d1.md)) 로컬 구동도 운영에 그대로 간다 —
  게이트웨이(로컬이 사본)와 무게가 다르다.
- **원격 바인딩이라 `CLOUDFLARE_API_TOKEN` 이 없거나 만료면 콘솔 화면이 아예 안 뜬다** — 로컬 사본이
  없기 때문이다. 실행 절차는 [run-prod.md](run-prod.md) · [runbook.md](../ops-dashboard/docs/runbook.md).

---

## 4. 콘솔 `OPS_TOKEN` — 조회·조치를 잠근다

`OPS_TOKEN` 은 콘솔의 접근을 잠근다. **미설정이면 배포본은 `503` 으로 잠긴다**(fail-closed — 열린 채
잊히는 것보다 안 보여서 바로 아는 게 낫다). 무엇을 여닫는지의 **정책**은 [access-control.md](access-control.md)
(읽기 게이트 #93 · decision/0004 개정)에서 다룬다 — 여기서는 **값을 어떻게 넣나**만 말한다.

```bash
# 토큰 값 생성 (아무 값이나 무작위 16바이트면 된다. 로컬과 배포본이 같을 필요는 없다)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# 로컬 — 파일로
cd ops-dashboard
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars

# 배포본 — 파일 밖으로 (§2)
npx wrangler secret put OPS_TOKEN --env production
```

**확인** — 배포본에서 세 상태를 다 본다. 토큰 없이 `503→401` 로 바뀌면 시크릿이 들어간 것이다.

```bash
BASE=https://ops.ask-seoul.kr
curl -s -o /dev/null -w "토큰 없이   %{http_code}\n" "$BASE/api/summary?days=1"                               # 401
curl -s -o /dev/null -w "틀린 토큰   %{http_code}\n" -H "authorization: Bearer wrong"     "$BASE/api/summary?days=1"  # 401
curl -s -o /dev/null -w "올바른 토큰 %{http_code}\n" -H "authorization: Bearer $OPS_TOKEN" "$BASE/api/summary?days=1"  # 200
```

화면에서는 우상단 **잠금 해제**에 같은 값을 넣으면 열린다. 이 배포 시크릿 등록은
[manual-steps.md §1](manual-steps.md) 의 수동 절차이기도 하다(상태·안 하면 무슨 일이 나는지 포함).

---

## 5. CI 자격증명

배포 워크플로는 **GitHub Secrets** 에서 자격증명을 읽는다(로컬 `.env` 가 아니다):

- `CLOUDFLARE_API_TOKEN` — `Workers Scripts:Edit`
- `CLOUDFLARE_ACCOUNT_ID`

CI 는 **코드만** 배포한다 — `OPS_TOKEN`·마이그레이션은 사람이 하는 수동 절차로 남는다
([manual-steps.md](manual-steps.md)). 도입 경위는 [change-log.md](change-log.md) 의 CI 항목.

---

## 6. 게이트웨이(마켓플레이스) 시크릿 — 여기서 안 다룬다

`ISSUANCE_SALT` 등 게이트웨이 발급 시크릿은 **다른 프로젝트 소관**이다(대시보드/마켓플레이스 분리).
규칙(로컬은 파일, 배포는 `secret put`)은 §1~§2 그대로지만, 값·절차는 그쪽 런북이 정본이다 →
[marketplace/docs/deploy-runbook.md](../marketplace/docs/deploy-runbook.md).

---

## 관련

- [environments.md](environments.md) — 환경(로컬/운영)·`[env.production]` 상속 규칙
- [run-prod.md](run-prod.md) — 콘솔 실행 절차 · [runbook.md](../ops-dashboard/docs/runbook.md) — 콘솔 운영·증상표
- [access-control.md](access-control.md) — `OPS_TOKEN` 이 무엇을 잠그나(#93) · Cloudflare Access
- [manual-steps.md](manual-steps.md) — 사람이 직접 쳐야 하는 작업(§1 이 배포본 `OPS_TOKEN`)
- [setup.md](setup.md) — 최초 셋업 · [agreement.md](agreement.md) — 팀 합의(시크릿 원칙)
