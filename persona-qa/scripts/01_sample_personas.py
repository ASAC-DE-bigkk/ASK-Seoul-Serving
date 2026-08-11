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
    for attempt in range(5):  # 간헐적 500/429·타임아웃 — 지수 백오프 재시도
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or attempt == 4:
                raise
            time.sleep(2 ** attempt)
        except (TimeoutError, urllib.error.URLError, OSError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def fetch_rows(offset: int, length: int = 100) -> list[dict]:
    # /filter 가 타임아웃일 때의 우회로 — 캐시가 잘 되는 일반 /rows 를 받아 직접 거른다
    qs = urllib.parse.urlencode({
        "dataset": DATASET, "config": "default", "split": "train",
        "offset": offset, "length": length,
    })
    req = urllib.request.Request(
        f"https://datasets-server.huggingface.co/rows?{qs}",
        headers={"User-Agent": "persona-qa/0.1"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return [r["row"] for r in json.load(resp)["rows"]]
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def sample_band_scan(lo: int, hi: int, rng: random.Random,
                     count: int, exclude: set) -> list[dict]:
    picked: list[dict] = []
    used_occ: Counter = Counter()
    sex_count: Counter = Counter()
    for _ in range(40):
        if len(picked) >= count:
            break
        rows = fetch_rows(rng.randrange(0, 1_000_000 - 100))
        rng.shuffle(rows)
        for row in rows:
            if len(picked) >= count:
                break
            if (row["province"] != "서울" or not (lo <= row["age"] <= hi)
                    or row["uuid"] in exclude
                    or sex_count[row["sex"]] >= (count + 1) // 2
                    or used_occ[row["occupation"]] >= 1):
                continue
            picked.append({k: row.get(k) for k in KEEP})
            sex_count[row["sex"]] += 1
            used_occ[row["occupation"]] += 1
    print(f"  {lo}-{hi}세(scan): {len(picked)}명")
    return picked


def sample_band(lo: int, hi: int, rng: random.Random,
                count: int = PER_BAND, exclude: set | None = None) -> list[dict]:
    where = f"\"province\"='서울' AND \"age\">={lo} AND \"age\"<={hi}"
    first = fetch(where, 0, 1)
    total = first["num_rows_total"]
    exclude = exclude or set()
    picked: list[dict] = []
    used_occupations: Counter = Counter()
    used_districts: Counter = Counter()
    sex_count: Counter = Counter()
    tries = 0
    # 무작위 offset 에서 100명씩 끌어와 성별 5:5 · 직업/자치구 중복 최소화 그리디 선별
    while len(picked) < count and tries < 12:
        tries += 1
        offset = rng.randrange(0, max(1, total - 100))
        rows = [r["row"] for r in fetch(where, offset)["rows"]]
        rng.shuffle(rows)
        for row in rows:
            if len(picked) >= count:
                break
            if row["uuid"] in exclude:
                continue
            if sex_count[row["sex"]] >= (count + 1) // 2:
                continue
            if used_occupations[row["occupation"]] >= 1 or used_districts[row["district"]] >= 2:
                continue
            picked.append({k: row.get(k) for k in KEEP})
            sex_count[row["sex"]] += 1
            used_occupations[row["occupation"]] += 1
            used_districts[row["district"]] += 1
    if len(picked) < count:  # 제약이 과하면 남은 자리는 제약 없이 채운다
        for row in rows:
            if len(picked) >= count:
                break
            if row["uuid"] not in exclude and all(p["uuid"] != row["uuid"] for p in picked):
                picked.append({k: row.get(k) for k in KEEP})
    print(f"  {lo}-{hi}세: 모수 {total:,} → {len(picked)}명")
    return picked


def main() -> None:
    import sys
    OUT.mkdir(parents=True, exist_ok=True)
    out_file = OUT / "personas.json"
    if len(sys.argv) > 1 and sys.argv[1] == "extra":
        # 추가 표본: 기존 personas.json 에 없는 사람만 뽑아 덧붙인다 (02~04 가 새 것만 처리)
        want = int(sys.argv[2]) if len(sys.argv) > 2 else 17
        per_band = -(-want // len(BANDS))  # ceil — 밴드 균등으로 뽑고 라운드로빈으로 want 명만
        existing = json.loads(out_file.read_text(encoding="utf-8"))
        exclude = {p["uuid"] for p in existing}
        rng = random.Random(43)
        by_band = [sample_band_scan(lo, hi, rng, count=per_band, exclude=exclude)
                   for lo, hi in BANDS]
        added = [p for group in zip(*by_band) for p in group][:want]
        personas = existing + added
        print(f"추가 {len(added)}명 (합계 {len(personas)}명)")
        out_file.write_text(json.dumps(personas, ensure_ascii=False, indent=1), encoding="utf-8")
        return
    rng = random.Random(42)
    personas = []
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
