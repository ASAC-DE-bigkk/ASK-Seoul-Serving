# 로컬에서 돌리기 — **게이트웨이 전용** (Miniflare)

> **환경 매뉴얼.** 콘솔은 [운영 D1](run-prod.md), 구조와 배분은
> [environments.md](environments.md), OS별 설치는 [setup.md](setup.md), 지도는 [index.md](index.md).

> 🔴 **2026-08-05 — 콘솔에는 이제 로컬 환경이 없다.**
> dev D1 폐기로 콘솔은 로컬 구동도 운영 D1 에 직접 붙는다
> ([decision/0015](../ops-dashboard/docs/decision/0015-single-production-d1.md)).
> **콘솔 작업이면 이 문서가 아니라 [run-prod.md](run-prod.md) 를 본다.**
>
> 이 문서는 **게이트웨이(marketplace)** 용으로 남는다 — 그쪽은 아직 전환 판단 대기다(**#85**).

**게이트웨이가 평소에 쓰는 환경이다.** 데이터도 실행도 전부 이 노트북 안에 있고,
팀 DB 에 아무 영향이 없다.

| | |
|---|---|
| D1 | 로컬 sqlite (`marketplace/.wrangler/state`) |
| 플래그 | 없음. **게이트웨이는 기본이 로컬이다** |
| 쓰기 | ✅ 가능 (로컬 사본에만) |
| 주소 | 게이트웨이 `:8787` |

## ⚠️ 두 프로젝트가 더는 같은 DB 를 보지 않는다

예전에는 콘솔이 `--persist-to` 로 게이트웨이의 로컬 상태에 붙어 **한 D1 을 공유**했다.
지금은 아니다:

| | 보는 D1 |
|---|---|
| 게이트웨이 로컬 | 로컬 sqlite (이 문서) |
| **콘솔** | **운영 `ask-seoul-prod-d1`** ([run-prod.md](run-prod.md)) |

그래서 **게이트웨이 로컬에서 발급한 키가 콘솔 화면에 안 보이는 것이 정상이다.**
반대로 콘솔의 응답 상태·이용 행동·API 사용량·이용자 키 탭은 운영 D1 에 게이트웨이 표가
아직 없어서 비어 있다 — 그것도 정상이고, 화면이 "이 환경에 없음"으로 사유를 말한다.
합쳐지는 시점은 게이트웨이 전환(**#85**) 이후다.

## 1. 준비 (한 번만)

Node 20+ 가 필요하다. 설치·OS별 함정은 [setup.md](setup.md) — 특히 Windows 는
설치 후 **IDE 를 완전히 껐다 켜야** `npm` 이 PATH 에 잡힌다.

## 2. 시드

```bash
cd marketplace
npm install
npm run seed          # 마이그레이션 + 픽스처 → 표 + 데이터
```

`fixtures/seed.sql` 은 `build_fixtures.py` 가 팀 D1 에서 뽑은 **실측의 부분집합**이다
(제품 62종 · 테이블당 50행). 조작된 값이 아니고, 게이트웨이 운영 표
(`_keys`·`_usage`·`_burst`·`_gateway_request_log`)는 **건드리지 않는다.**

> **콘솔에는 `npm run seed` 가 없다**(0015 로 삭제). 콘솔의 스키마 적용은
> `npm run migrate` 이고 대상은 운영 D1 이다 — [run-prod.md §5](run-prod.md).

## 3. 띄우기

```bash
cd marketplace && npm run dev    # :8787
```

콘솔을 같이 띄우려면 [run-prod.md §2](run-prod.md) 를 따른다(`:8788`, 인스펙터 9230 —
게이트웨이 기본 9229 와 안 겹친다). **둘은 서로 다른 DB 를 보므로 구동 순서 제약이 없다** —
공유 sqlite 의 WAL 잠금 충돌이 더는 생기지 않는다.

## 4. 확인

```bash
curl -s http://localhost:8787/api/v1/catalog | head -c 200
```

D1 을 직접 들여다볼 때:

```bash
cd marketplace
npx wrangler d1 execute ask-seoul-dev-d1 --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 5. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| `'npm'은(는) ... 인식되지 않습니다` | 설치 후 PATH 미갱신 | **IDE 를 완전히 종료 후 재시작** ([setup.md](setup.md)) |
| `npm install` 이 package.json 을 못 찾는다 | 리포 루트에는 없다 | `marketplace/` 로 들어가서 실행 |
| 콘솔에서 이 로컬 데이터가 안 보인다 | **정상이다** — 다른 DB 다 | 위 ⚠️ 절 · [run-prod.md](run-prod.md) |
| 콘솔에 `npm run seed` 가 없다 | **정상이다** — 0015 로 삭제됐다 | `npm run migrate` ([run-prod.md §5](run-prod.md)) |

게이트웨이 쪽 자세한 절차는 [marketplace/docs/](../marketplace/docs/),
콘솔은 [ops-dashboard runbook](../ops-dashboard/docs/runbook.md).
