"""랜딩 데모 응답 스냅샷 생성기 — public/demo-samples.json 을 쓴다.

사용법 (marketplace/ 에서, `npm run dev` 가 :8787 에 떠 있어야 한다):
    python fixtures/build_demo_samples.py

**왜 스냅샷인가.** 랜딩 데모가 `/api/v1/preview` 를 실호출하면 방문 1회마다 D1 에
쓰기가 쌓인다 — `_burst` UPSERT + `_request_log` INSERT 가 호출당 2건이고,
도메인 순환이라 방문 1회에 최대 6번이다. 비용보다 문제는 관측 오염이다:
`_request_log` 는 "무엇이 실제로 쓰이나"를 재는 유일한 근거인데(CLAUDE.md §3),
랜딩 장식 트래픽이 그 표를 채우면 콘솔 사용량 탭이 읽는 값이 흐려진다.

**꾸며낸 행이 아니다.** 여기서 쓰는 행은 전부 실제 `/api/v1/preview` 응답이다.
다만 시점이 고정되므로 화면에 생성 날짜를 함께 표시한다(index.html `.stamp`).
갱신하려면 이 스크립트를 다시 돌려 산출물을 커밋한다.

행은 데모가 그리는 컬럼만 남기지 않고 **통째로** 싣는다 — 컬럼 목록은
index.html 의 DEMOS 에 있고, 여기서 복제하면 둘이 조용히 어긋난다.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "http://localhost:8787"
ROWS = 3  # 데모 표가 그리는 행 수

# index.html DEMOS 의 table 과 같은 순서 — 도메인당 하나.
TABLES = [
    "gold_culture_activity_by_dong",
    "gold_citydata_ppltn_hourly",
    "gold_transit_dong_now",
    "d1_dong_category_matrix",
    "gold_weather_place_risk_window",
    "gold_traffic_incident_x_weather_current_hourly",
]

OUT = Path(__file__).resolve().parent.parent / "public" / "demo-samples.json"


def fetch(table: str) -> list[dict]:
    url = f"{BASE}/api/v1/preview/{table}"
    try:
        with urllib.request.urlopen(url, timeout=15) as res:
            body = json.loads(res.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise SystemExit(f"{table}: {url} 호출 실패 — npm run dev 가 떠 있는지 확인 ({exc})")
    rows = body.get("rows") or []
    if not rows:
        raise SystemExit(f"{table}: 응답에 행이 없다 — npm run seed 로 픽스처를 채울 것")
    return rows[:ROWS]


def main() -> None:
    samples = {table: fetch(table) for table in TABLES}
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "GET /api/v1/preview/<table> (로컬 D1 — fixtures/seed.sql 기준)",
        "samples": samples,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(len(v) for v in samples.values())
    print(f"{OUT.relative_to(OUT.parent.parent)} — {len(samples)}개 표 · {total}행 · {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
