# 로컬에서 돌리기 — 기본 환경 (Miniflare)

> **환경 매뉴얼 셋 중 하나.** [원격 dev D1](run-remote-dev.md) · [운영 D1](run-prod.md) ·
> 구조와 배분은 [environments.md](environments.md), OS별 설치는 [setup.md](setup.md).

**평소에 쓰는 환경이다.** 데이터도 실행도 전부 이 노트북 안에 있고, 팀 DB 에 아무 영향이 없다.
그래서 여기서는 **조치(쓰기)까지 다 된다** — 폐기·복구·쿼터·삭제.

| | |
|---|---|
| D1 | 로컬 sqlite (`marketplace/.wrangler/state`) — 두 프로젝트가 **한 상태를 공유**한다 |
| 플래그 | 없음. **기본이 로컬이다** |
| 쓰기 | ✅ 가능 |
| 주소 | 게이트웨이 `:8787` · 콘솔 `:8788` |

## 1. 준비 (한 번만)

Node 20+ 가 필요하다. 설치·OS별 함정은 [setup.md](setup.md) — 특히 Windows 는
설치 후 **IDE 를 완전히 껐다 켜야** `npm` 이 PATH 에 잡힌다.

## 2. 시드 — 게이트웨이 먼저

같은 D1 을 공유하므로 **순서가 있다.** 게이트웨이가 `_catalog`·`_keys`·
`_gateway_request_log` 를 만들고, 콘솔이 그걸 읽는다.

```bash
cd marketplace
npm install
npm run seed          # 마이그레이션 + 픽스처 → 표 + 데이터

cd ../ops-dashboard
npm install
npm run seed          # 마이그레이션만 → 표만, 데이터 0건
```

⚠️ **두 `npm run seed` 는 이름만 같고 하는 일이 다르다.**

| | 게이트웨이 | 콘솔 |
|---|---|---|
| 채우는 표 | `_catalog` · 제품 표 `d1_*` | `_ops_slo` · `_ops_domain` (+ 조회 DB 4종 미러) |
| 넣는 것 | 표 + **데이터**(팀 D1 실측 표본, 테이블당 50행) | 표 **만** |

콘솔 시드 뒤 '데이터 준비 상태' 탭이 비어 있는 것은 **정상이다** — 합성 데이터를 화면에
올리지 않기로 했기 때문이다([ops-dashboard decision/0005](../ops-dashboard/docs/decision/0005-slo-snapshot-to-d1.md)).

## 3. 비밀값

콘솔의 조치(쓰기)를 열려면 `OPS_TOKEN` 이 필요하다. 없으면 화면은 뜨고 **조치만** 503 이다.

```bash
# macOS / Linux
cd ops-dashboard
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" > .dev.vars
```

```powershell
# Windows — openssl 이 없고, 인코딩을 지정하지 않으면 UTF-16LE 로 저장돼 조용히 안 읽힌다
cd ops-dashboard
node -e "console.log('OPS_TOKEN='+require('crypto').randomBytes(16).toString('hex'))" | Set-Content .dev.vars -Encoding ascii
```

`.dev.vars` 는 `.gitignore` 대상이다. 커밋하지 않는다.

## 4. 띄우기

**게이트웨이를 먼저** 띄운다 — 공유 sqlite 의 WAL 복구 잠금이 충돌하는 것을 피한다.

```bash
cd marketplace   && npm run dev    # :8787
cd ops-dashboard && npm run dev    # :8788  (인스펙터 9230 — 게이트웨이 기본 9229 와 안 겹친다)
```

## 5. 확인

```bash
curl -s "http://localhost:8788/api/summary?days=14" | jq '{missing: .meta.missing, env: .meta.env}'
```

`meta.env.readonly` 가 `false` 면 로컬이다. 화면 상단 배지도 `로컬 개발` 로 뜬다.

D1 을 직접 들여다볼 때:

```bash
cd ops-dashboard
npm run d1:local -- "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 6. 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| `'npm'은(는) ... 인식되지 않습니다` | 설치 후 PATH 미갱신 | **IDE 를 완전히 종료 후 재시작** ([setup.md](setup.md)) |
| `npm install` 이 package.json 을 못 찾는다 | 리포 루트에는 없다 | `marketplace/` 나 `ops-dashboard/` 로 들어가서 실행 |
| '서빙 로그를 찾지 못했습니다' | 게이트웨이 미시드 / `--persist-to` 불일치 | `cd ../marketplace && npm run seed` |
| '실행 기록' 탭이 비었다 | 4종의 실측은 로컬에 **없다** | [원격 dev D1 로 본다](run-remote-dev.md) |
| 조치 버튼이 안 보인다 | 읽기 전용 모드 | 상단 잠금 해제 (`.dev.vars` 의 `OPS_TOKEN`) |
| 조치가 503 | `OPS_TOKEN` 미설정 | `.dev.vars` 작성 후 재시작 |

더 자세한 검증 절차는 [ops-dashboard runbook](../ops-dashboard/docs/runbook.md).
