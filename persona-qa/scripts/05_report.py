# 05 — 집계: verdicts + answers + personas → out/summary.json + out/report.md
# LLM 호출 없음(순수 집계). 대시보드는 summary.json 을 먹는다.
import json
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
BAND_EDGES = [(20, 29, "20대"), (30, 39, "30대"), (40, 49, "40대"),
              (50, 64, "50-64"), (65, 200, "65+")]


def band(age: int) -> str:
    return next(label for lo, hi, label in BAND_EDGES if lo <= age <= hi)


def pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def main() -> None:
    personas = {p["uuid"]: p for p in
                json.loads((OUT / "personas.json").read_text(encoding="utf-8"))}
    verdicts = json.loads((OUT / "verdicts.json").read_text(encoding="utf-8"))
    answers = {}
    for f in (OUT / "answers").glob("*.json"):
        d = json.loads(f.read_text(encoding="utf-8"))
        answers[d["id"]] = d

    rows = []
    for qid, v in verdicts.items():
        a = answers.get(qid, {})
        p = personas[v["persona_uuid"]]
        rows.append({
            "id": qid, "verdict": v["verdict"], "grounded": bool(v.get("grounded")),
            "usefulness": v.get("usefulness"), "gap": v.get("gap"),
            "band": band(p["age"]), "sex": p["sex"],
            "district": p["district"].replace("서울-", ""),
            "occupation": p["occupation"],
            "model": a.get("model", "cli-default"),
            "question": a.get("question", ""),
            "tool_calls": len([t for t in a.get("tool_path", [])
                               if t.startswith(("list_", "search_", "describe_",
                                                "preview_", "query_", "run_"))]),
        })

    n = len(rows)
    ok = [r for r in rows if r["verdict"] == "정상"]
    summary = {
        "total": n,
        "verdicts": dict(Counter(r["verdict"] for r in rows)),
        "grounded_rate": pct(sum(r["grounded"] for r in rows), n),
        "usefulness_mean": round(sum(r["usefulness"] or 0 for r in rows) / n, 2) if n else 0,
        "coverage_rate": pct(len(ok), n),  # '정상' = 데이터로 답함
        "by_band": {}, "by_model": {}, "by_district": {},
        "gaps": [], "rows": rows,
    }
    for key, field in (("by_band", "band"), ("by_model", "model"), ("by_district", "district")):
        groups = defaultdict(list)
        for r in rows:
            groups[r[field]].append(r)
        summary[key] = {
            g: {"n": len(rs),
                "coverage": pct(sum(1 for r in rs if r["verdict"] == "정상"), len(rs)),
                "usefulness": round(sum(r["usefulness"] or 0 for r in rs) / len(rs), 2),
                "grounded": pct(sum(r["grounded"] for r in rs), len(rs))}
            for g, rs in sorted(groups.items())
        }
    gap_counter = Counter(r["gap"] for r in rows if r["gap"])
    summary["gaps"] = [{"gap": g, "count": c} for g, c in gap_counter.most_common()]

    (OUT / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

    md = ["# 페르소나 품질 테스트 결과 요약\n",
          f"- 표본: 질문 {n}건 (페르소나 50명)",
          f"- 커버리지(정상 답변률): **{summary['coverage_rate']}%**",
          f"- groundedness(근거/한계 명시): **{summary['grounded_rate']}%**",
          f"- 유용성 평균: **{summary['usefulness_mean']}/5**\n",
          "## 판정 분포\n", "| 판정 | 건수 |", "|---|---|"]
    md += [f"| {k} | {v} |" for k, v in
           sorted(summary["verdicts"].items(), key=lambda x: -x[1])]
    md += ["\n## 연령대별\n", "| 연령대 | n | 커버리지% | 유용성 | grounded% |", "|---|---|---|---|---|"]
    md += [f"| {g} | {s['n']} | {s['coverage']} | {s['usefulness']} | {s['grounded']} |"
           for g, s in summary["by_band"].items()]
    md += ["\n## 모델별 (실측 조건 혼합 주의 — PLAN §3-03)\n",
           "| 모델 | n | 커버리지% | 유용성 | grounded% |", "|---|---|---|---|---|"]
    md += [f"| {g} | {s['n']} | {s['coverage']} | {s['usefulness']} | {s['grounded']} |"
           for g, s in summary["by_model"].items()]
    md += ["\n## 데이터 간극 (백로그 후보)\n", "| 간극 | 건수 |", "|---|---|"]
    md += [f"| {g['gap']} | {g['count']} |" for g in summary["gaps"][:20]]
    (OUT / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"→ summary.json · report.md (질문 {n}건, 커버리지 {summary['coverage_rate']}%)")


if __name__ == "__main__":
    main()
