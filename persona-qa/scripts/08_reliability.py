# 08 — 판정 신뢰도 측정. "LLM이 판정한 걸 믿을 수 있나요"에 숫자로 답하기 위한 것.
#
# 세 가지를 잰다:
#   1) 재채점 일치율   같은 판정자(haiku)로 두 번 채점했을 때 라벨이 같은 비율
#   2) 교차판정 일치율  다른 판정자(sonnet)가 같은 답변을 봤을 때 라벨이 같은 비율
#   3) 사람 검수 일치율 사람이 채운 시트와 LLM 판정이 같은 비율
# 우연 일치를 걷어내기 위해 Cohen's κ 도 함께 낸다 — 라벨이 '정상'에 쏠려 있으면
# 단순 일치율은 아무 판정자나 높게 나온다.
#
# 사용:
#   python scripts/08_reliability.py v4-20260812 --sample 40        # 층화 표본 추출 → sample40.json
#   python scripts/08_reliability.py v4-20260812 --human-sheet 20   # 사람 검수 시트 CSV 생성
#   python scripts/08_reliability.py v4-20260812                    # 일치율 계산
import csv
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stats import pct_cell, wilson  # noqa: E402

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent.parent
LABELS = ["정상", "되물음", "데이터없음", "환각의심", "오류"]


def cohen_kappa(a: list[str], b: list[str]) -> float:
    """우연 일치를 보정한 일치도. 1=완전일치, 0=우연 수준, 음수=우연보다 나쁨."""
    n = len(a)
    if n == 0:
        return 0.0
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum((ca[l] / n) * (cb[l] / n) for l in set(a) | set(b))
    return round((po - pe) / (1 - pe), 3) if pe < 1 else 1.0


def agreement(name: str, base: dict, other: dict) -> dict:
    ids = sorted(set(base) & set(other))
    a = [base[i]["verdict"] for i in ids]
    b = [other[i]["verdict"] for i in ids]
    k = sum(1 for x, y in zip(a, b) if x == y)
    # 어떤 라벨에서 갈리는지 — 개선 방향을 알려면 일치율 한 숫자로는 부족하다
    disagree = Counter((x, y) for x, y in zip(a, b) if x != y)
    lo, hi = wilson(k, len(ids))
    return {
        "comparison": name, "n": len(ids),
        "agreement": {"value": round(100 * k / len(ids), 1) if ids else 0.0,
                      "numerator": k, "denominator": len(ids), "ci95": [lo, hi],
                      "formula": f"{k} ÷ {len(ids)} × 100"},
        "cohen_kappa": cohen_kappa(a, b),
        "disagreements": [{"base": x, "other": y, "n": c}
                          for (x, y), c in disagree.most_common()],
        "grounded_agreement": pct_cell(
            sum(1 for i in ids if bool(base[i].get("grounded")) == bool(other[i].get("grounded"))),
            len(ids)),
        "usefulness_within_1": pct_cell(
            sum(1 for i in ids
                if abs((base[i].get("usefulness") or 0) - (other[i].get("usefulness") or 0)) <= 1),
            len(ids)),
    }


def stratified_sample(verdicts: dict, k: int, seed: int = 20260812) -> list[str]:
    """판정 라벨별로 비례 추출 — '정상'만 뽑히면 검증이 되지 않는다."""
    rng = random.Random(seed)
    by_label: dict[str, list[str]] = {}
    for qid, v in verdicts.items():
        by_label.setdefault(v["verdict"], []).append(qid)
    picked: list[str] = []
    for label, ids in sorted(by_label.items()):
        ids = sorted(ids)
        rng.shuffle(ids)
        want = max(1, round(k * len(ids) / len(verdicts)))
        picked += ids[:want]
    rng.shuffle(picked)
    return sorted(picked[:k])


def main() -> None:
    args = sys.argv[1:]
    round_dir = args[0]
    OUT = ROOT / "out" / round_dir
    verdicts = json.loads((OUT / "verdicts.json").read_text(encoding="utf-8"))

    if "--sample" in args:
        k = int(args[args.index("--sample") + 1])
        ids = stratified_sample(verdicts, k)
        (OUT / f"sample{k}.json").write_text(
            json.dumps(ids, ensure_ascii=False, indent=1), encoding="utf-8")
        dist = Counter(verdicts[i]["verdict"] for i in ids)
        print(f"→ sample{k}.json ({len(ids)}건) 라벨 분포: {dict(dist)}")
        return

    if "--human-sheet" in args:
        k = int(args[args.index("--human-sheet") + 1])
        ids = stratified_sample(verdicts, k, seed=99)
        answers = {f.stem: json.loads(f.read_text(encoding="utf-8"))
                   for f in (OUT / "answers").glob("*.json")}
        p = OUT / f"human-review-{k}.csv"
        with p.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["질문ID", "질문", "답변", "LLM판정", "LLM이유",
                        "사람판정(정상/되물음/데이터없음/환각의심/오류)", "사람메모"])
            for i in ids:
                a = answers.get(i, {})
                v = verdicts[i]
                w.writerow([i, a.get("question", ""), (a.get("answer") or "")[:3000],
                            v["verdict"], v.get("rationale", ""), "", ""])
        print(f"→ {p} ({len(ids)}건) — '사람판정' 열을 채운 뒤 다시 실행하면 일치율이 계산된다")
        return

    # 일치율 계산 — 있는 것만 비교한다
    results = []
    for fname, label in [("verdicts-rejudge.json", "재채점 (haiku ↔ haiku)"),
                         ("verdicts-sonnet.json", "교차판정 (haiku ↔ sonnet)")]:
        f = OUT / fname
        if f.exists():
            results.append(agreement(label, verdicts, json.loads(f.read_text(encoding="utf-8"))))

    for p in sorted(OUT.glob("human-review-*.csv")):
        rows = list(csv.DictReader(p.open(encoding="utf-8-sig", newline="")))
        human = {r["질문ID"]: {"verdict": r["사람판정"].strip()}
                 for r in rows if r.get("사람판정", "").strip()}
        if human:
            results.append({**agreement(f"사람 검수 ({p.name})", verdicts, human),
                            "filled": f"{len(human)}/{len(rows)}"})

    if not results:
        print("비교할 파일이 없다. --sample 로 표본을 뽑고 04_judge.py 를 --out 으로 두 번 더 돌려라.")
        return

    (OUT / "reliability.json").write_text(
        json.dumps({"round": round_dir, "results": results}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    for r in results:
        a = r["agreement"]
        print(f"{r['comparison']}: {a['value']}% ({a['numerator']}/{a['denominator']}, "
              f"CI {a['ci95'][0]}~{a['ci95'][1]}) · κ={r['cohen_kappa']}")
        for d in r["disagreements"][:5]:
            print(f"    {d['base']} → {d['other']}: {d['n']}건")


if __name__ == "__main__":
    main()
