# K-Skill 등록 전 팀 내부 평가 가이드 — `seoul-weather-risk`

이 문서는 upstream `k-skill` 등록 전에도 팀이 ASK 서울의 **실제 게시 데이터**와
`seoul-weather-risk` 클라이언트를 나누어 평가하는 절차다. 외부 사용자용 설치 안내가
아니며, 사용자 Marketplace API Key나 k-skill proxy 서비스 키를 새로 발급하거나 공유하는
절차도 아니다.

대상 제품은 `weather_place_risk_window` 하나다. 장소별 폭염·한파·호우·대설·강풍 후보를
예보 임계값으로 선별한 참고 정보이며, 기상청의 공식 특보를 대체하지 않는다.

## 먼저 경로를 고른다

| 확인하려는 것 | 사용할 경로 | 가능한 시점 | 키 | 확인하지 못하는 것 |
|---|---|---|---|---|
| 실제 게시 제품·schema·신선도 상태·행 페이지 | **A. Marketplace 직접 검증** | 지금 | 팀원 본인의 Marketplace 사용자 키 | k-skill proxy를 거친 사용자 경험 |
| 키 없는 `seoul-weather-risk` helper와 proxy 계약 | **B. 포크 소스 평가** | proxy route 준비 뒤 | 없음 | upstream npm 배포 뒤의 설치 경로 |
| 일반 사용자의 설치·호출 경험 | **C. 공식 설치** | upstream 병합·배포 뒤 | 없음 | 내부 미배포 변경 |

`A`는 데이터 상품의 품질·준비 상태를 즉시 확인하는 경로이고, `B`는 그 데이터를
k-skill이 어떤 제한된 API 표면으로 읽는지 검증하는 경로다. 둘 중 하나가 통과했다고
다른 하나까지 통과한 것은 아니다.

## 공통 보안·운영 경계

- 팀원은 이미 보유한 **자기 Marketplace 사용자 키만** `A`에 쓴다. 키 원문을 채팅,
  이슈·PR, `.env` 파일, 명령행 인수, URL, 로그에 넣거나 다른 팀원에게 전달하지 않는다.
  아래 예시는 이미 안전한 환경에서 주입된 `ASK_SEOUL_API_KEY`만 읽는다. 값 자체를
  `export`하는 명령은 제공하지 않는다.
- k-skill proxy의 전용 서비스 키는 proxy 런타임에만 둔다. 팀원 PC에 복사하거나 `A`의
  사용자 키 대신 쓰지 않는다. 서비스 키 권한·회수 계약은
  [ASK-Seoul-Serving #194](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/issues/194)와
  [#195](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/pull/195)에 있다.
- 이 가이드를 위해 `wrangler dev`나 로컬 Marketplace Worker를 실행하지 않는다. 현재
  로컬 Worker도 운영 D1의 `_usage`·`_burst`·요청 로그에 영향을 줄 수 있다.
- 읽기 전용 호출도 개인 key의 burst/quota와 요청 기록을 사용한다. 필요한 최소 횟수만
  실행하고, `set -x`가 켜진 셸에서는 먼저 끈다.

## A. Marketplace 직접 검증

### 사전 조건

안전한 개인 환경에서 `ASK_SEOUL_API_KEY`가 이미 설정되어 있어야 한다. 기본 endpoint는
`https://ask-seoul.kr`이며, 별도 검증 endpoint를 쓰는 경우에만
`ASK_SEOUL_MARKETPLACE_BASE_URL`을 HTTPS origin으로 설정한다.

아래는 API Key를 인수나 출력에 넣지 않는 표준 라이브러리 점검이다. bundle, product,
data page의 **비밀값이 아닌 요약값만** 출력한다.

```bash
python3 - <<'PY'
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

api_key = os.environ.get("ASK_SEOUL_API_KEY")
if not api_key:
    sys.exit("ASK_SEOUL_API_KEY가 현재 안전한 환경에 설정되어 있지 않습니다.")

base_url = os.environ.get("ASK_SEOUL_MARKETPLACE_BASE_URL", "https://ask-seoul.kr").rstrip("/")
paths = {
    "bundle": "/skill/v1/bundles/seoul-weather-risk",
    "product": "/skill/v1/products/weather_place_risk_window",
    "data": "/skill/v1/products/weather_place_risk_window/data?limit=1",
}

for label, path in paths.items():
    request = Request(
        f"{base_url}{path}",
        headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.load(response)
        if label == "bundle":
            result = {
                "status": response.status,
                "bundle_id": payload.get("bundle_id"),
                "registration_ready": payload.get("registration_ready"),
                "blockers": payload.get("blockers"),
                "products": [
                    {
                        "product_id": item.get("product_id"),
                        "registration_ready": item.get("registration_ready"),
                        "publication_id": item.get("publication_id"),
                        "blockers": item.get("blockers"),
                    }
                    for item in payload.get("products", [])
                    if isinstance(item, dict)
                ],
            }
        elif label == "product":
            metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
            result = {
                "status": response.status,
                "bundle_id": payload.get("bundle_id"),
                "product_id": payload.get("product_id"),
                "registration_ready": payload.get("registration_ready"),
                "publication_id": payload.get("publication_id"),
                "blockers": payload.get("blockers"),
                "column_names": [
                    item.get("name") for item in metadata.get("columns", [])
                    if isinstance(item, dict)
                ],
            }
        else:
            result = {
                "status": response.status,
                "bundle_id": payload.get("bundle_id"),
                "product_id": payload.get("product_id"),
                "publication_id": payload.get("publication_id"),
                "row_count": payload.get("row_count"),
                "limit": payload.get("limit"),
                "has_more": payload.get("has_more"),
                "next_cursor_present": payload.get("next_cursor") is not None,
            }
    except HTTPError as error:
        try:
            body = json.load(error)
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        result = {"status": error.code, "code": body.get("code"), "detail": body.get("detail")}
    except URLError as error:
        result = {"status": "network_error", "detail": str(error.reason)}
    print(f"{label}: {json.dumps(result, ensure_ascii=False)}")
PY
```

### 판정 기준과 기록할 증거

- bundle은 `bundle_id=seoul-weather-risk`이고, 제품 목록이
  `weather_place_risk_window` 하나여야 한다.
- 제품 metadata에는 시간축 `forecast_at`과 이 제품이 공개하기로 한 column이 있어야 한다.
  `registration_ready=true`, 비어 있는 `blockers`, 유효한 `publication_id`가 등록 준비의
  최소 증거다. 하나라도 아니면 이슈의 blocker를 해결하기 전까지 등록 준비로 표현하지 않는다.
- data page는 동일한 `bundle_id`·`product_id`·`publication_id`, `1..500` 범위의 `limit`,
  `row_count`와 실제 `rows` 길이의 일치를 확인한다. 다음 페이지가 필요할 때만 동일한
  제품·publication 안에서 `next_cursor`를 재사용한다.
- 결과에는 실행 시각(KST), 세 endpoint의 상태 코드, `registration_ready`, `blockers`,
  `publication_id`, data `row_count`만 남긴다. API Key, 전체 Authorization 헤더, 원문 행은
  기록하지 않는다.

## B. 포크 소스에서 helper·proxy 경계 평가

이 경로는 upstream 등록을 기다리지 않고 현재 소스의 helper 계약을 확인하는 방법이다.
아래 고정 commit은 [upstream PR #552](https://github.com/NomaDamas/k-skill/pull/552)에 올린
`seoul-weather-risk` 변경이다.

```bash
git clone https://github.com/ASAC-DE-bigkk/k-skill.git
cd k-skill
git fetch origin feat/546-seoul-weather-risk
git checkout --detach 2b5ca5931d30139ccab3609ee016d0e6ff3f557e

# 네트워크 호출 없이 proxy 모드와 사용자 key 불필요 계약만 확인
python3 seoul-weather-risk/scripts/seoul_weather_risk.py -- preflight
```

`preflight`는 `mode=hosted_proxy`, `user_api_key_required=false`를 보여야 한다. data 호출은
다음 세 조건이 모두 충족된 뒤에만 한다.

1. #195가 병합되어 Marketplace에 서비스-key scope·회수 정책이 적용되었다.
2. k-skill proxy에 `seoul-weather-risk` route와 **전용·회수 가능한** 서비스 키가 운영자에 의해 배포되었다.
3. proxy 공개 health와 route 배포 revision이 확인되었다.

준비가 확인된 경우에만 다음 순서로 실행한다. 팀원은 서비스 키나 사용자 API Key를 넣지
않는다.

```bash
python3 seoul-weather-risk/scripts/seoul_weather_risk.py -- catalog
python3 seoul-weather-risk/scripts/seoul_weather_risk.py -- describe \
  --product-id weather_place_risk_window
python3 seoul-weather-risk/scripts/seoul_weather_risk.py -- query \
  --product-id weather_place_risk_window --limit 20
```

`upstream_not_configured`(503)는 helper가 우회할 문제가 아니다. proxy의 origin 또는
서비스 키가 아직 준비되지 않았다는 운영 상태이므로, 팀원은 서비스 키를 받아 직접 호출하지
말고 `A`로 돌아가 데이터 계약만 검증한다.

### 왜 지금 일반 설치 명령을 쓰지 않는가

현재 `SKILL.md`는 설치 후 `@nomadamas/k-skill` npm CLI가 제공하는 최신 instruction·helper를
호출하도록 생성된다. upstream 병합·npm 배포 전에는 그 CLI에 포크 전용
`seoul-weather-risk` asset이 없을 수 있으므로, `npx ... skills add`만으로는 실제 배포와
동일한 실행을 보장하지 못한다. 이 가이드의 소스 직접 실행은 그 공백을 숨기지 않는
**내부 평가용** 경로다.

## C. upstream 병합·배포 뒤의 일반 설치

upstream PR #552가 병합되고 해당 스킬이 공식 배포 목록에 포함된 뒤에만 일반 사용자는
다음처럼 설치한다.

```bash
npx --yes skills add NomaDamas/k-skill --skill seoul-weather-risk -g
```

설치 뒤에는 에이전트에게 `seoul-weather-risk`로 장소별 기상 위험 예상 시간대를 조회해 달라고
요청한다. 이 정상 경로에는 Marketplace 사용자 키 설정이나 개인 Vault 설치가 필요하지 않다.

## 실패 응답을 성공으로 바꾸지 않는다

| 증상 | 의미 | 다음 조치 |
|---|---|---|
| `401` / `missing api key` / `unknown api key` | `A`의 사용자 키가 없거나 인식되지 않음 | 본인 키의 안전한 환경 설정만 확인한다. 키를 공유·재발급하지 않는다. |
| `403` / `revoked api key` | 사용자 키가 비활성·권한 없음, 또는 서비스 키 권한 문제 | 사용자 키는 본인 access 상태를 확인한다. proxy 문제는 운영자에게 scope·회수 상태만 문의한다. |
| `409` / `cursor_expired` | publication이 바뀌어 이전 page cursor가 무효 | bundle/product부터 다시 읽고 새 cursor로 재시작한다. |
| `429` | 개인 키 quota/burst 또는 proxy rate limit | 재시도 시각을 따르고 반복 호출을 멈춘다. |
| `503` / `product_not_ready` | 권리·품질·신선도·게시 gate 중 하나가 미충족 | `blockers`를 이슈 증거로 남기고 data를 정상이라고 표시하지 않는다. |
| `503` / `upstream_not_configured` | proxy 운영 설정이 미완료 | `A`로 제품 상태를 확인하고 proxy 운영자에게 배포 전제조건을 전달한다. |
| `response_contract_invalid` | bundle/product/data 응답이 스킬의 단일 제품 계약과 다름 | fixture나 추정값으로 대체하지 말고 응답 요약과 revision을 이슈에 남긴다. |

## 내부 평가 완료 기준

- `A`에서 실제 게시 제품의 bundle·product·data 응답을 요약으로 보관했다.
- `registration_ready`와 `blockers`를 현재 사실 그대로 기록했다. 준비되지 않은 상태를
  통과로 바꾸지 않았다.
- `B`를 수행한 경우 helper의 단일 제품·`forecast_at`·제한 조회 계약과 proxy 응답을 함께
  확인했고, 서비스 키를 팀원 환경으로 가져오지 않았다.
- 일반 설치·자연어 호출 검증은 `C`의 upstream 병합·npm 배포 뒤에 별도로 다시 수행한다.
