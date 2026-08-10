# 01 — Nemotron-Personas-Korea 에서 서울 거주자 50명 층화 샘플링.
# HF datasets-server /filter API 만 쓴다 (전체 다운로드 없음). 시드 고정으로 재현 가능.
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
DATASET = "nvidia/Nemotron-Personas-Korea"
SEOUL_TOTAL = 185_228  # /filter num_rows_total 실측(2026-08-10) — 달라져도 동작엔 지장 없음
PER_BAND = 10          # 연령대별 인원
BANDS = [(20, 29), (30, 39), (40, 49), (50, 64), (65, 120)]
KEEP = [
    "uuid", "persona", "professional_persona", "sex", "age", "occupation",
    "district", "education_level", "marital_status", "family_type",
    "hobbies_and_interests_list",
]


def fetch(where: str, offset: int, length: int = 100) -> dict:
    qs = urllib.parse.urlencode({
        "dataset": DATASET, "config": "default", "split": "train",
        "where": where, "offset": offset, "length": length,
    })
    req = urllib.request.Request(
        f"https://datasets-server.huggingface.co/filter?{qs}",
        headers={"User-Agent": "persona-qa/0.1"},
    )
    for attempt in range(5):  # 간헐적 500/429 — 지수 백오프 재시도
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or attempt == 4:
                raise
            time.sleep(2 ** attempt)


def sample_band(lo: int, hi: int, rng: random.Random) -> list[dict]:
    where = f"\"province\"='서울' AND \"age\">={lo} AND \"age\"<={hi}"
    first = fetch(where, 0, 1)
    total = first["num_rows_total"]
    picked: list[dict] = []
    used_occupations: Counter = Counter()
    used_districts: Counter = Counter()
    sex_count: Counter = Counter()
    tries = 0
    # 무작위 offset 에서 100명씩 끌어와 성별 5:5 · 직업/자치구 중복 최소화 그리디 선별
    while len(picked) < PER_BAND and tries < 12:
        tries += 1
        offset = rng.randrange(0, max(1, total - 100))
        rows = [r["row"] for r in fetch(where, offset)["rows"]]
        rng.shuffle(rows)
        for row in rows:
            if len(picked) >= PER_BAND:
                break
            if sex_count[row["sex"]] >= PER_BAND // 2:
                continue
            if used_occupations[row["occupation"]] >= 1 or used_districts[row["district"]] >= 2:
                continue
            picked.append({k: row.get(k) for k in KEEP})
            sex_count[row["sex"]] += 1
            used_occupations[row["occupation"]] += 1
            used_districts[row["district"]] += 1
    if len(picked) < PER_BAND:  # 제약이 과하면 남은 자리는 제약 없이 채운다
        for row in rows:
            if len(picked) >= PER_BAND:
                break
            if all(p["uuid"] != row["uuid"] for p in picked):
                picked.append({k: row.get(k) for k in KEEP})
    print(f"  {lo}-{hi}세: 모수 {total:,} → {len(picked)}명")
    return picked


def main() -> None:
    rng = random.Random(42)
    OUT.mkdir(parents=True, exist_ok=True)
    personas: list[dict] = []
    for lo, hi in BANDS:
        personas.extend(sample_band(lo, hi, rng))
    districts = Counter(p["district"] for p in personas)
    sexes = Counter(p["sex"] for p in personas)
    print(f"합계 {len(personas)}명 · 자치구 {len(districts)}종 · 성별 {dict(sexes)}")
    out_file = OUT / "personas.json"
    out_file.write_text(
        json.dumps(personas, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {out_file}")


if __name__ == "__main__":
    main()
