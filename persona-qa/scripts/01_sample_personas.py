# 01 — nvidia/Nemotron-Personas-Korea 에서 서울 거주자를 층화 샘플링.
# HF datasets-server 만 쓴다(전체 다운로드 없음). LLM 호출 없음. 시드 고정으로 재현 가능.
#
# 사용:
#   python scripts/01_sample_personas.py --n 50 --seed 42                    # 1차 재현
#   python scripts/01_sample_personas.py --round v4-20260812 --n 40 \
#          --seed 202608124 --exclude excluded-uuids.json                    # 신규 표본
#   python scripts/01_sample_personas.py --round v1-20260811 --n 17 --append --seed 43
#
# 회차마다 별도 스크립트(v3_sample20 / v4_sample40)를 두던 것을 여기로 합쳤다.
# 달라지는 건 인원수·시드·제외목록뿐이고 선별 규칙은 같아야 회차 간 비교가 성립한다.
import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다(--help 포함).
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATASET = "nvidia/Nemotron-Personas-Korea"
DATASET_ROWS = 1_000_000   # /rows num_rows_total 실측(2026-08-12)
SEOUL_TOTAL = 185_228      # /filter num_rows_total 실측(2026-08-10) — 참고값
BANDS = [(20, 29), (30, 39), (40, 49), (50, 64), (65, 120)]
KEEP = [
    "uuid", "persona", "professional_persona", "sex", "age", "occupation",
    "district", "education_level", "marital_status", "family_type",
    "hobbies_and_interests_list",
]
MAX_PAGES = 400  # scan 모드 상한 — 한 페이지 100행


def _req(path: str, params: dict) -> urllib.request.Request:
    qs = urllib.parse.urlencode(params)
    return urllib.request.Request(
        f"https://datasets-server.huggingface.co/{path}?{qs}",
        headers={"User-Agent": "persona-qa/0.1"})


def fetch(where: str, offset: int, length: int = 100) -> dict:
    """/filter — DuckDB 인덱스 기반. 서버측 인덱스가 죽어 있으면 500/422 가 난다."""
    req = _req("filter", {"dataset": DATASET, "config": "default", "split": "train",
                          "where": where, "offset": offset, "length": length})
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
    """/rows — 캐시가 잘 되는 일반 조회. 인덱스와 무관하게 살아 있다."""
    req = _req("rows", {"dataset": DATASET, "config": "default", "split": "train",
                        "offset": offset, "length": length})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return [r["row"] for r in json.load(resp)["rows"]]
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


class BandPicker:
    """밴드별 선별 규칙 — 성별 균형 · 직업 중복 회피 · 자치구 편중 완화.
    모든 회차가 이 규칙을 공유해야 표본 성격이 같다고 말할 수 있다."""

    def __init__(self, want: int, exclude: set):
        self.want, self.exclude = want, exclude
        self.picked: list[dict] = []
        self.sex, self.occ, self.dist = Counter(), Counter(), Counter()

    def full(self) -> bool:
        return len(self.picked) >= self.want

    def offer(self, row: dict) -> bool:
        if self.full() or row["uuid"] in self.exclude:
            return False
        if self.sex[row["sex"]] >= (self.want + 1) // 2:
            return False
        if self.occ[row["occupation"]] >= 1 or self.dist[row["district"]] >= 2:
            return False
        self.picked.append({k: row.get(k) for k in KEEP})
        self.sex[row["sex"]] += 1
        self.occ[row["occupation"]] += 1
        self.dist[row["district"]] += 1
        self.exclude.add(row["uuid"])
        return True


def band_sizes(n: int) -> list[int]:
    """n 명을 5개 연령대에 최대한 균등 배분. 나머지는 앞 밴드부터."""
    base, rem = divmod(n, len(BANDS))
    return [base + (1 if i < rem else 0) for i in range(len(BANDS))]


def sample_filter(sizes: list[int], rng: random.Random, exclude: set) -> list[dict]:
    out = []
    for (lo, hi), want in zip(BANDS, sizes):
        where = f"\"province\"='서울' AND \"age\">={lo} AND \"age\"<={hi}"
        total = fetch(where, 0, 1)["num_rows_total"]
        pk = BandPicker(want, exclude)
        for _ in range(12):
            if pk.full():
                break
            rows = [r["row"] for r in fetch(where, rng.randrange(0, max(1, total - 100)))["rows"]]
            rng.shuffle(rows)
            for row in rows:
                pk.offer(row)
        print(f"  {lo}-{hi}세: 모수 {total:,} → {len(pk.picked)}/{want}명", flush=True)
        out += pk.picked
    return out


def sample_scan(sizes: list[int], rng: random.Random, exclude: set) -> list[dict]:
    """/rows 를 무작위 offset 으로 훑어 로컬에서 거른다 — 인덱스가 죽어도 동작한다."""
    pickers = [BandPicker(w, exclude) for w in sizes]
    seen_seoul = 0
    for page in range(MAX_PAGES):
        if all(p.full() for p in pickers):
            break
        rows = fetch_rows(rng.randrange(0, max(1, DATASET_ROWS - 100)))
        rng.shuffle(rows)
        for row in rows:
            if row.get("province") != "서울":
                continue
            seen_seoul += 1
            for (lo, hi), pk in zip(BANDS, pickers):
                if lo <= row["age"] <= hi:
                    pk.offer(row)
                    break
        if page % 10 == 0:
            print(f"  page {page + 1} · 서울 {seen_seoul}명 확인 · "
                  f"확보 {[len(p.picked) for p in pickers]}", flush=True)
    for (lo, hi), pk in zip(BANDS, pickers):
        print(f"  {lo}-{hi}세: {len(pk.picked)}/{pk.want}명")
    return [p for pk in pickers for p in pk.picked]


def main() -> None:
    ap = argparse.ArgumentParser(description="서울 페르소나 층화 샘플링")
    ap.add_argument("--round", dest="round_dir", default=None,
                    help="out/<round>/personas.json 에 쓴다 (없으면 out/personas.json)")
    ap.add_argument("--n", type=int, default=50, help="총 인원 (5개 연령대에 균등 배분)")
    ap.add_argument("--seed", type=int, default=42, help="난수 시드 — 재현의 핵심")
    ap.add_argument("--exclude", default=None,
                    help="제외할 uuid 목록 JSON (회차 폴더 기준 상대경로)")
    ap.add_argument("--mode", choices=["auto", "filter", "scan"], default="auto",
                    help="auto=filter 시도 후 실패하면 scan 으로 폴백")
    ap.add_argument("--append", action="store_true",
                    help="기존 personas.json 에 덧붙인다 (기존 인원은 자동 제외)")
    a = ap.parse_args()

    out_dir = ROOT / "out" / a.round_dir if a.round_dir else ROOT / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "personas.json"

    exclude: set[str] = set()
    if a.exclude:
        exclude |= set(json.loads((out_dir / a.exclude).read_text(encoding="utf-8")))
    existing: list[dict] = []
    if a.append and out_file.exists():
        existing = json.loads(out_file.read_text(encoding="utf-8"))
        exclude |= {p["uuid"] for p in existing}

    sizes = band_sizes(a.n)
    rng = random.Random(a.seed)
    print(f"목표 {a.n}명 · 밴드별 {sizes} · 시드 {a.seed} · 제외 {len(exclude)}명 · 모드 {a.mode}")

    if a.mode == "scan":
        personas = sample_scan(sizes, rng, exclude)
    else:
        try:
            personas = sample_filter(sizes, rng, exclude)
        except Exception as e:
            if a.mode == "filter":
                raise
            # 2026-08-12 실측: HF 쪽 DuckDB 인덱스가 corrupted/rebuilding 상태였다.
            print(f"  /filter 실패({type(e).__name__}) → scan 모드로 폴백", flush=True)
            # rng 를 새로 만든다 — 실패 전까지 filter 가 난수를 몇 번 뽑았는지에 따라
            # 폴백 결과가 달라지면 시드를 고정한 의미가 없다.
            personas = sample_scan(sizes, random.Random(a.seed), exclude)

    personas = existing + personas
    if len(personas) != a.n + len(existing):
        print(f"⚠️ 목표 미달: {len(personas)}명 (목표 {a.n + len(existing)})")
    out_file.write_text(json.dumps(personas, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"합계 {len(personas)}명 · 자치구 {len(Counter(p['district'] for p in personas))}종 "
          f"· 성별 {dict(Counter(p['sex'] for p in personas))}")
    print(f"→ {out_file}")


if __name__ == "__main__":
    main()
