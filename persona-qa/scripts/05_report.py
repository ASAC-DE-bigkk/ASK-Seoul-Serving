# 05 — 집계: verdicts + answers + personas → summary.json + report.md
# LLM 호출 없음(순수 집계). 대시보드는 summary.json 을 먹는다.
#
# 사용: python scripts/05_report.py v3-20260812   # 회차 폴더 지정
#       python scripts/05_report.py               # out/ 평면 (정리 전 레이아웃)
#
# 리포트의 모든 비율에는 분자/분모와 Wilson 95% 신뢰구간을 병기한다 — 발표에서
# "그 %는 뭘 나눈 건가요"에 리포트만으로 답할 수 있어야 하기 때문. 정의서는 out/METHOD.md.
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stats import mean_ci, pct_cell, wilson  # noqa: E402

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / sys.argv[1] if len(sys.argv) > 1 else ROOT / "out"
SHARED = ROOT / "out" / "shared"
BAND_EDGES = [(20, 29, "20대"), (30, 39, "30대"), (40, 49, "40대"),
              (50, 64, "50-64"), (65, 200, "65+")]


def band(age: int) -> str:
    return next(label for lo, hi, label in BAND_EDGES if lo <= age <= hi)


def pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def main() -> None:
    pf = OUT / "personas.json"
    if not pf.exists():                      # 1·2차는 페르소나가 shared/ 에 있다
        pf = SHARED / "personas-v1v2.json"
    personas = {p["uuid"]: p for p in json.loads(pf.read_text(encoding="utf-8"))}
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

    n_personas = len({v["persona_uuid"] for v in verdicts.values()})
    n_grounded = sum(r["grounded"] for r in rows)
    u_mean, u_sd, u_half = mean_ci([r["usefulness"] or 0 for r in rows])

    md = ["# 페르소나 품질 테스트 결과 요약\n",
          f"- 표본: 질문 **{n}건** (페르소나 {n_personas}명)",
          f"- 커버리지(판정 '정상' 비율): **{pct_cell(len(ok), n)}**",
          f"- groundedness(근거/한계 명시): **{pct_cell(n_grounded, n)}**",
          f"- 유용성 평균: **{round(u_mean, 2)}/5** "
          f"(합 {round(sum(r['usefulness'] or 0 for r in rows), 1)}/{n}, "
          f"sd {round(u_sd, 2)}, CI {round(u_mean - u_half, 2)}~{round(u_mean + u_half, 2)})\n",
          "> 비율은 `분자/분모` 와 Wilson 95% 신뢰구간을 병기한다. 모든 라벨은 LLM 판정자",
          "> (`claude-haiku-4-5`)가 붙인 것이며, 계산 정의·한계는 `out/METHOD.md` 에 있다.\n",
          "## 판정 분포\n", "| 판정 | 건수 | 비율 (95% CI) |", "|---|---|---|"]
    md += [f"| {k} | {v} | {pct_cell(v, n)} |" for k, v in
           sorted(summary["verdicts"].items(), key=lambda x: -x[1])]

    def group_table(title: str, field: str) -> list[str]:
        g = defaultdict(list)
        for r in rows:
            g[r[field]].append(r)
        out = [f"\n## {title}\n",
               "| 구분 | n | 커버리지 (95% CI) | 유용성 | grounded (95% CI) |",
               "|---|---|---|---|---|"]
        for key, rs in sorted(g.items()):
            k_ok = sum(1 for r in rs if r["verdict"] == "정상")
            m, _, h = mean_ci([r["usefulness"] or 0 for r in rs])
            out.append(f"| {key} | {len(rs)} | {pct_cell(k_ok, len(rs))} | "
                       f"{round(m, 2)} ±{round(h, 2)} | "
                       f"{pct_cell(sum(r['grounded'] for r in rs), len(rs))} |")
        return out

    md += group_table("연령대별", "band")
    md += group_table("모델별 (실측 조건 혼합 주의 — PLAN §3-03)", "model")
    md += ["\n## 데이터 간극 (백로그 후보)\n", "| 간극 | 건수 |", "|---|---|"]
    md += [f"| {g['gap']} | {g['count']} |" for g in summary["gaps"][:20]]
    (OUT / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"→ summary.json · report.md (질문 {n}건, 커버리지 {summary['coverage_rate']}%)")


if __name__ == "__main__":
    main()
