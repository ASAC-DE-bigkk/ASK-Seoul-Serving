"""로컬 D1 시드 생성기 — 팀 D1(읽기 전용)에서 서빙 제품 전종 샘플을 추출해 seed.sql 을 쓴다.

사용법 (레포 루트 sample/ 에서, .env 의 CLOUDFLARE_API_TOKEN 필요):
    python marketplace/fixtures/build_fixtures.py

산출물 seed.sql 은 커밋한다 — 팀원은 토큰 없이
예전에는 `npm run seed` 가 이 산출물로 로컬 D1 을 세웠다 — 그 경로는 #85 로 없어졌고,
지금 이 파일들은 스키마 참고용이다.

**두 갈래로 수집한다.**
- 라이브 `_catalog` 에 등록된 제품(타 도메인): 계약값(description·product_question·
  tests·time_axis·serving_status·freshness)을 **그대로 옮긴다**. 여기선 라이브가 정본이다.
- culture: 라이브 `_catalog` 에 아직 행이 없다(계약 선언 ASAC-DBT#346 리뷰 중).
  아래 CULTURE_PRODUCTS 의 계약값으로 **목표 상태를 로컬에서 먼저 산다**.

`_catalog` 는 계약 v1.1(15컬럼) 기준 픽스처 — 라이브 16컬럼 스키마와 다르며 그게 의도다
(라이브의 serving_tier 는 계약 v1.1 에 없어 싣지 않는다).
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ACCOUNT = "0d39ddce1c07c97df66843ede19f56c4"
# 2026-08-03 부터 파이프라인 게시 대상이 prod D1(ask-seoul-prod-d1)로 이동(ASAC-DAG#668).
# 픽스처 원천도 게시 정본을 따라간다 — 구 dev D1(9db0e851…)은 더 이상 갱신되지 않는다.
DATABASE = "59a8409e-3be6-467b-8214-7938c59c8729"
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DATABASE}/query"
SAMPLE_ROWS = 50

# (table, product_id, product_question, time_axis, description) — ASAC-DBT#346 meta.serving 계약값.
# description 은 dbt 계약(_culture_gold__models.yml)의 모델 설명에서 옮겼다 — 그레인과 주의사항이
# 여기 실려야 API 만 쓰는 소비자(특히 AI)가 한계를 안다. 내부 이슈 번호는 외부 문구 기준대로 뺐다.
CULTURE_PRODUCTS = [
    ("gold_culture_activity_by_dong", "culture_activity_by_dong", "어느 행정동에서 언제 문화 활동이 얼마나 열리나?", "event_date",
     "행정동(admin_dong_code) × 일자 문화활동 집계. 426개 행정동 전체가 스카폴드로 존재해 활동 0건인 동도 0으로 조회된다. 스포츠 예약은 제외."),
    ("gold_culture_calendar_density", "culture_calendar_density", "구별로 어느 날짜에 행사가 몰리나(밀집도)?", "event_date",
     "일×자치구 문화 밀도·경쟁 지수(그레인 gu_code×event_date). 시민에겐 '볼 게 많은 날'=total_events, 주최자에겐 '피해야 할 날'=concentration."),
    ("gold_culture_event_schedule", "culture_event_schedule", "이번 주말·특정 기간 서울에서 무슨 문화행사가 열리나?", "event_start_date",
     "문화행사 목록 질의 표면(행사 1행). 6개 소스 union 후 크로스소스 중복 제거(전문 소스 우선). '이번 주말 행사'는 기간 겹침 질의라 from/to(시작일 기준)만으로는 진행 중 장기 행사를 놓칠 수 있다 — event_end_date 를 함께 볼 것."),
    ("gold_culture_event_crowd", "culture_event_crowd", "무슨 요일 몇 시에 행사 주변이 붐비나?", None,
     "행사 자치구의 요일×시간대 평시 혼잡 베이스라인(gu_code×day_of_week×hour_of_day). 실시간 도시데이터 핫스팟(~120곳) 한정 평시 값 — 특정 행사일의 실측 증가분이 아니다."),
    ("gold_culture_boxoffice_daily", "culture_boxoffice_daily", "지금 서울에서 예매 상위 공연은 무엇인가?", "snapshot_date",
     "KOPIS 예매 랭킹 일 스냅샷(snapshot_date×rank_no). 스냅샷이 매일 쌓여 예매 추이 시계열의 원천이 된다."),
    ("gold_culture_dine_around", "culture_dine_around", "행사 많은 동네 주변 외식 상권은 어디인가?", None,
     "동별 문화 밀도 × 요식업 스톡 프로필(행정동 1행, 426동 스카폴드). dine_around_score 는 두 축 백분위의 기하평균 — 요식업 데이터 없는 동은 score 가 null."),
    ("gold_culture_booking_curve", "culture_booking_curve", "공연 예매 인기가 개막까지 어떤 궤적으로 차오르나?", None,
     "공연별 예매 순위 궤적 요약(1공연 1행). KOPIS 는 순위만 제공 — 예매율·판매좌석·매진 데이터는 없어 '순위 궤적'으로만 본다."),
]

# 표시명·설명은 **계약 `meta.serving.display` 가 정본**이고 게시본 `d1_catalog_display` 로
# 나간다(ASAC-DAG#706). 예전엔 여기 57종을 손으로 적어 `public/product-display.json` 을
# 만들었는데, 발행이 앞서가면 사본이 뒤에 남아 계속 어긋났다 — 그 표와 산출물을 지웠다.

CATALOG_DDL = (
    "CREATE TABLE _catalog (name TEXT PRIMARY KEY, product_id TEXT, "
    "external INTEGER, description TEXT, product_question TEXT, tests TEXT, time_axis TEXT, "
    "columns TEXT, row_count INTEGER, serving_status TEXT, publication_id TEXT, "
    "source_run_id TEXT, published_bytes INTEGER, freshness TEXT, exported_at TEXT);"
)
CATALOG_COLS = (
    "name, product_id, external, description, product_question, tests, time_axis, columns, "
    "row_count, serving_status, publication_id, source_run_id, published_bytes, freshness, exported_at"
)


def d1(sql: str, attempts: int = 4) -> list[dict]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not token:
        raise SystemExit("CLOUDFLARE_API_TOKEN 미설정 — sample/.env 값을 환경변수로 넘겨 실행")
    req = urllib.request.Request(
        API,
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    # 전종 생성은 요청이 200건 가까이 된다 — 일시적 네트워크 오류 하나로 처음부터
    # 다시 돌리지 않도록 재시도한다. 조회 전용이라 재시도가 안전하다.
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.load(resp)
            break
        except (urllib.error.URLError, TimeoutError) as e:
            if i == attempts - 1:
                raise SystemExit(f"D1 연결 실패({attempts}회 시도): {e}")
            time.sleep(2 ** i)
    if not body.get("success"):
        raise SystemExit(f"D1 오류: {body.get('errors')}")
    return body["result"][0]["results"]


def lit(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sample_rows(table: str, axis: str | None) -> list[dict]:
    """표본을 '오늘 근처'로 잡는다 — 과거쪽 최신 + 미래쪽 최근접을 섞어 최대 SAMPLE_ROWS 행.

    미리보기 API 가 표본 안에서 시간축 내림차순 5행을 보여주기 때문에, 뜨는 방식이
    그대로 화면이 된다. 앞쪽 rowid 를 뜨면 실시간 제품이 몇 달 전 값을 보여주고,
    그렇다고 내림차순만 쓰면 이벤트형 제품이 1년 뒤 장기 전시를 대표로 내건다.
    (SQLite 는 INTEGER 를 TEXT 보다 항상 작게 보므로 연도·요일 같은 숫자 축은
    전부 과거 버킷으로 떨어진다 — 내림차순 정렬이라 최신부터 담긴다.)
    """
    if not axis:
        return d1(f'SELECT * FROM "{table}" LIMIT {SAMPLE_ROWS}')
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    past = d1(f'SELECT * FROM "{table}" WHERE "{axis}" <= \'{now}\' '
              f'ORDER BY "{axis}" DESC LIMIT {SAMPLE_ROWS}')
    future = d1(f'SELECT * FROM "{table}" WHERE "{axis}" > \'{now}\' '
                f'ORDER BY "{axis}" ASC LIMIT {SAMPLE_ROWS}')
    half = SAMPLE_ROWS // 2
    take_past = min(len(past), max(half, SAMPLE_ROWS - len(future)))
    return past[:take_past] + future[:SAMPLE_ROWS - take_past]


def collect() -> list[dict]:
    """라이브 _catalog 등록분 + culture 계약분 → 제품 목록(테이블명 순)."""
    products = []
    for row in d1("SELECT * FROM _catalog"):
        table = row["name"]
        # 라이브에 계약 필드가 빈 행이 있다(transit 3종 — 구 d1_direct 경로).
        # product_id 는 표시·도메인 분류에 쓰이므로 테이블명에서 유도하되,
        # external·serving_status 는 라이브 값을 그대로 둔다(선언되지 않은 걸 선언된 척하지 않는다).
        products.append({
            "table": table,
            "product_id": row.get("product_id") or table.removeprefix("gold_"),
            "external": row.get("external"),
            "description": row.get("description"),
            "product_question": row.get("product_question"),
            "tests": row.get("tests") or "[]",
            "time_axis": row.get("time_axis"),
            "serving_status": row.get("serving_status"),
            "freshness": row.get("freshness"),
        })

    known = {p["table"] for p in products}
    for table, product_id, question, time_axis, description in CULTURE_PRODUCTS:
        if table in known:  # 계약이 머지되어 라이브에 실리면 그쪽이 정본
            continue
        products.append({
            "table": table,
            "product_id": product_id,
            "external": 1,
            "description": description,
            "product_question": question,
            "tests": "[]",
            "time_axis": time_axis,
            "serving_status": "published",
            "freshness": None,
        })
    return sorted(products, key=lambda p: p["table"])


def main() -> None:
    products = collect()
    out: list[str] = [
        "-- generated by build_fixtures.py — 팀 D1 샘플 (제품 %d종 · 테이블당 최대 %d행)"
        % (len(products), SAMPLE_ROWS),
        "DROP TABLE IF EXISTS _catalog;",
        CATALOG_DDL,
    ]
    now = datetime.now(timezone.utc).isoformat()

    for p in products:
        table, product_id = p["table"], p["product_id"]
        info = d1(f"PRAGMA table_info({table})")
        cols = [(c["name"], c["type"] or "TEXT") for c in info]
        col_defs = ", ".join(f'"{n}" {t}' for n, t in cols)
        out.append(f'DROP TABLE IF EXISTS "{table}";')
        out.append(f'CREATE TABLE "{table}" ({col_defs});')

        total = d1(f'SELECT COUNT(*) AS n FROM "{table}"')[0]["n"]
        axis = p["time_axis"]
        rows = sample_rows(table, axis if axis and axis in dict(cols) else None)
        names = ", ".join(f'"{n}"' for n, _ in cols)
        for r in rows:
            values = ", ".join(lit(r.get(n)) for n, _ in cols)
            out.append(f'INSERT INTO "{table}" ({names}) VALUES ({values});')

        columns_json = json.dumps([{"name": n, "type": t} for n, t in cols], ensure_ascii=False)
        out.append(
            f"INSERT OR REPLACE INTO _catalog ({CATALOG_COLS}) VALUES ("
            + ", ".join([
                lit(table), lit(product_id), lit(p["external"]), lit(p["description"]),
                lit(p["product_question"]), lit(p["tests"]), lit(axis), lit(columns_json),
                str(total), lit(p["serving_status"]), "'local-fixture'", "'local-fixture'",
                "0", lit(p["freshness"]), lit(now),
            ])
            + ");"
        )

        print(f"{table}: sample={len(rows)} full={total}")

    seed = Path(__file__).with_name("seed.sql")
    seed.write_text("\n".join(out) + "\n", encoding="utf-8")

    print(f"\nwrote {seed} ({seed.stat().st_size:,} bytes) — 제품 {len(products)}종")


if __name__ == "__main__":
    main()
