# 로컬에서 돌리기 — **게이트웨이 전용**

> **환경 매뉴얼.** 콘솔은 [run-prod.md](run-prod.md), 구조와 배분은
> [environments.md](environments.md), OS별 설치는 [setup.md](setup.md), 지도는 [index.md](index.md).

> 🔴 **2026-08-06 — 이 문서의 "로컬"은 더는 로컬 DB 가 아니다.**
> dev D1 폐기(#85 · [decision/0015](../ops-dashboard/docs/decision/0015-single-production-d1.md))로
> **게이트웨이도 로컬 구동이 운영 D1 에 직접 붙는다.** 로컬인 것은 실행 위치(내 노트북의
> workerd)뿐이고, **데이터는 운영이다.**
>
> 콘솔 작업이면 이 문서가 아니라 [run-prod.md](run-prod.md) 를 본다.

| | |
|---|---|
| D1 | 🔴 **운영 `ask-seoul-prod-d1`** — 바인딩의 `remote = true` |
| 플래그 | **없음.** `--remote` 를 붙이지 않는다(아래 §5) |
| 쓰기 | 🔴 **운영에 그대로 간다** |
| 주소 | 게이트웨이 `:8787` |

## ⚠️ 대가를 알고 쓴다

로컬 구동이 운영 `_keys`·`_usage`·`_burst` 를 **실제로 건드린다.**

- **테스트 키는 운영 `_keys` 에 남는다** — 쓰고 나면 `DELETE /api/v1/keys?purge=true` 로 지운다.
- **요청 로그는 섞이지 않는다** — `ASK_ENV="local"` 로 찍혀 콘솔이 환경 스코프로 걸러낸다(#64).
- **쿼터·버스트는 그 키의 것만** 소모한다.
- 🔴 **남의 표 모양은 바꾸지 않는다** — `_request_log`(transit) · `_ops_*`(ASAC-DAG) ·
  `_catalog`·제품 표(도메인 export)에 `DROP`·`ALTER` 금지. 스키마 변경은 §4 로만.

**왜 이렇게 됐나**: dev D1 이 폐기돼 로컬이 볼 실물이 운영뿐이다. 서빙 메타(권리·컬럼
설명·활용 예시)가 운영에만 있어서 **로컬 픽스처로는 권리 게이트(#88)·카탈로그 응답을
검증할 수 없었다.**

## 1. 준비 (한 번만)

Node 20+ 가 필요하다. 설치·OS별 함정은 [setup.md](setup.md) — 특히 Windows 는
설치 후 **IDE 를 완전히 껐다 켜야** `npm` 이 PATH 에 잡힌다.

```bash
cd marketplace
cp .dev.vars.example .dev.vars   # ISSUANCE_SALT — 발급 기능용
cp .env.example .env             # CLOUDFLARE_API_TOKEN — 원격 바인딩용. 없으면 D1 이 안 붙는다
npm install
```

시크릿 파일 두 개의 역할 구분은 [environments.md §1-2](environments.md) 가 정본이다.
토큰 권한은 **필요한 만큼만** 준다 — 보기만 할 거면 `D1:Read` 로 충분하다.

## 2. 시드 — **없다**

`npm run seed` 를 없앴다. 로컬이 실물을 보므로 픽스처를 넣을 자리가 없고, 넣으면 그게 곧
운영 오염이다. `fixtures/` 디렉토리는 **지우지 않고 남겼다** — 스키마가 어떤 모양이었는지
찾을 곳이 필요하다.

## 3. 띄우기

```bash
cd marketplace && npm run dev    # :8787 · 🔴 운영 D1
```

기동 로그에 **`Mode: remote`** 가 뜨는지 본다. 안 뜨면 운영이 아니라 빈 로컬을 보고 있다(§5).

콘솔을 같이 띄우려면 [run-prod.md §2](run-prod.md) 를 따른다(`:8788`, 인스펙터 9230 —
게이트웨이 기본 9229 와 안 겹친다). **둘이 같은 D1 을 보므로** 게이트웨이에서 발급한 키가
콘솔 화면에 그대로 나타난다.

## 4. 스키마 변경 — 사람이 직접 친다

팀 D1 쓰기라 에이전트에 대리 실행시키지 않는다(`0004` 오염이 정확히 그 경로에서 났다).

```bash
npm run migrate:list      # 적용 여부를 먼저 본다
npm run migrate:backfill  # 🔴 장부 백필 — 단독으로 먼저 돌린다
npm run migrate:apply     # 그다음 적용
```

**백필을 건너뛰면 `0001` 부터 재실행되고, 그중 `0004` 는 조건을 달 수 없는
`ALTER TABLE _request_log ADD COLUMN` 이다 — 그 이름의 표는 남의 것이다**(transit 워커).
백필은 이름이 아니라 `route` 컬럼 유무로 우리 표인지를 가려 그 재연을 막는다.

절차 정본은 [deploy-runbook §0·§1](../marketplace/docs/deploy-runbook.md).

## 5. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| `'npm'은(는) ... 인식되지 않습니다` | 설치 후 PATH 미갱신 | **IDE 를 완전히 종료 후 재시작** ([setup.md](setup.md)) |
| `npm install` 이 package.json 을 못 찾는다 | 리포 루트에는 없다 | `marketplace/` 로 들어가서 실행 |
| **카탈로그가 비었다 · 표가 없다고 나온다** | 🔴 운영이 아니라 빈 로컬을 보고 있다 | 아래 표 |
| `npm run seed` 가 없다 | **정상이다** — #85 로 삭제됐다 | 스키마 적용은 §4 |

### 원격에 붙는 것은 **설정이지 플래그가 아니다**

| 시도 | 결과 |
|---|---|
| **`remote = true` + 플래그 없는 `wrangler dev`** | ✅ **정상** — `Mode: remote` |
| `wrangler dev --remote` (옛 플래그) | 바인딩 이름·배지는 맞는데 **질의만 빈 결과** |
| `experimental_remote` | 이 버전(4.115)에 **없는 필드** — 경고만 찍고 local 로 조용히 떨어진다 |

가운데 줄이 특히 위험하다. 빈 결과를 강등 로직이 "표가 없습니다"로 표시해서 **화면만 보면
운영에 데이터가 없는 것처럼 보인다.** 콘솔이 먼저 밟은 함정이다([environments.md §3-4](environments.md)).

게이트웨이 쪽 자세한 절차는 [marketplace/docs/](../marketplace/docs/),
콘솔은 [ops-dashboard runbook](../ops-dashboard/docs/runbook.md).
