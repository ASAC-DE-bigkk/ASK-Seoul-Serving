# 07 — 근거 레이어: 발표된 모든 수치의 분자·분모·신뢰구간·계산 위치를 기계 판독 가능하게 남긴다.
#
# 왜 필요한가: 05_report.py 는 "65.0%" 만 찍는다. 발표에서 "그건 뭘 나눈 건가요"
# "오차범위는요" "누가 판정했나요" 를 물으면 리포트만으로는 답이 안 나온다.
# 이 스크립트는 LLM 호출 없이(순수 집계) 회차 폴더를 읽어 metrics.json 을 만든다.
#
# 사용: python scripts/07_metrics.py            # 세 회차 전부
#       python scripts/07_metrics.py v3-20260812
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
ROUNDS = ["v1-20260811", "v2-20260812", "v3-20260812"]

Z = 1.959964  # 95%

# 03_run_queries.py 는 stream-json 의 tool_use 이름을 전부 담는다 — MCP 툴만 골라내야 한다.
MCP_TOOLS = {"list_products", "search_products", "describe_product",
             "preview_product", "query_product", "run_pattern", "check_quota"}
# 실제로 데이터 행을 가져오는 툴. "카탈로그만 뒤지다 끝난 것"과 구분하기 위함.
MCP_FETCH = {"query_product", "run_pattern", "preview_product"}
# CLI 자체 기능이라 오염이 아닌 툴 — ToolSearch 는 MCP 툴 스키마를 불러오는 정상 경로,
# AskUserQuestion 은 '되물음' 판정 그 자체다.
HARNESS_TOOLS = {"ToolSearch", "AskUserQuestion"}

BAND_EDGES = [(20, 29, "20대"), (30, 39, "30대"), (40, 49, "40대"),
              (50, 64, "50-64"), (65, 200, "65+")]

# 회차별 실행 조건 — 코드에서 읽어낼 수 없는 사실은 여기 명시적으로 적는다.
RUN_META = {
    "v1-20260811": {
        "date": "2026-08-11", "purpose": "베이스라인",
        "answer_model": "혼합 (claude-haiku-4-5 156 · cli-default 41 · claude-sonnet-5 34)",
        "questions_origin": "신규 생성 (02_generate_questions.py, 카탈로그 비공개)",
        "catalog": "shared/catalog-v1.json (59제품)",
    },
    "v2-20260812": {
        "date": "2026-08-12", "purpose": "보완 전후 비교",
        "answer_model": "claude-sonnet-5 통일",
        "questions_origin": "1차 231건에서 층화 추출한 60건을 그대로 재사용",
        "catalog": "shared/catalog-v2v3.json (60제품)",
    },
    "v3-20260812": {
        "date": "2026-08-12", "purpose": "신규 표본 독립 검증",
        "answer_model": "claude-sonnet-5 통일",
        "questions_origin": "신규 생성 (페르소나 20명 전원 신규, 기존 77명 제외)",
        "catalog": "shared/catalog-v2v3.json (60제품)",
    },
}

# 04_judge.py 가 실제로 쓴 값. 파일 헤더 주석은 sonnet-5 라고 되어 있으나 코드는 haiku 다.
JUDGE = {
    "model": "claude-haiku-4-5-20251001",
    "source": "scripts/04_judge.py:10 (MODEL 상수)",
    "caveat": "같은 파일 1행 주석은 'claude-sonnet-5' 라고 적혀 있으나 코드가 정본. "
              "1·2·3차 모두 haiku 가 채점했다.",
    "rubric": "PLAN.md §3-04 — 5개 라벨(정상/되물음/데이터없음/환각의심/오류)",
    "input": "질문자 프로필 + 질문 + 툴 호출 경로 + 답변 본문 앞 4000자",
    "recorded_per_item": "verdict · grounded · usefulness · gap "
                         "(판정 이유는 저장하지 않는다 — v4 에서 추가 예정)",
}


def wilson(k: int, n: int) -> list[float]:
    """이항비율 95% Wilson 점수구간. 정규근사보다 소표본에서 정직하다."""
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + Z * Z / n
    center = (p + Z * Z / (2 * n)) / d
    half = Z / d * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n))
    return [round(100 * max(0.0, center - half), 1), round(100 * min(1.0, center + half), 1)]


def prop(k: int, n: int, definition: str, source: str) -> dict:
    return {"value": round(100 * k / n, 1) if n else 0.0,
            "numerator": k, "denominator": n, "ci95": wilson(k, n),
            "formula": f"{k} ÷ {n} × 100", "definition": definition, "source": source}


def mean_ci(xs: list[float], definition: str, source: str) -> dict:
    n = len(xs)
    if n == 0:
        return {"value": 0.0, "n": 0, "definition": definition, "source": source}
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    half = Z * sd / math.sqrt(n) if n > 1 else 0.0
    return {"value": round(m, 2), "n": n, "sum": round(sum(xs), 1), "sd": round(sd, 2),
            "ci95": [round(m - half, 2), round(m + half, 2)],
            "formula": f"{round(sum(xs), 1)} ÷ {n}", "scale": "1~5 정수",
            "definition": definition, "source": source}


def band(age: int) -> str:
    return next(label for lo, hi, lab in BAND_EDGES if lo <= age <= hi for label in [lab])


def build(round_dir: str) -> dict:
    d = OUT / round_dir
    verdicts = json.loads((d / "verdicts.json").read_text(encoding="utf-8"))
    pf = d / "personas.json"
    if not pf.exists():
        pf = OUT / "shared" / "personas-v1v2.json"
    personas = {p["uuid"]: p for p in json.loads(pf.read_text(encoding="utf-8"))}

    # answers/ 의 isolation 필드 — 그 회차가 로컬 툴을 차단했는지, 차단된 호출이 무엇인지.
    # tool_path 는 '시도'라서 차단 여부를 모르면 개입과 차단된 시도가 뒤섞인다.
    iso_by_id: dict[str, dict] = {}
    for f in (d / "answers").glob("*.json"):
        a = json.loads(f.read_text(encoding="utf-8"))
        iso_by_id[a["id"]] = a.get("isolation") or {}
    disallowed = set()
    for x in iso_by_id.values():
        disallowed |= set(x.get("disallowed_tools") or [])

    rows = []
    for qid, v in verdicts.items():
        tp = v.get("tool_path", []) or []
        p = personas[v["persona_uuid"]]
        rows.append({
            "id": qid, "verdict": v["verdict"], "grounded": bool(v.get("grounded")),
            "usefulness": v.get("usefulness"), "band": band(p["age"]),
            "mcp_any": any(t in MCP_TOOLS for t in tp),
            "mcp_fetch": any(t in MCP_FETCH for t in tp),
            "external": sorted({t for t in tp
                                if t not in MCP_TOOLS and t not in HARNESS_TOOLS}),
            # 차단 목록에 있는 툴을 부르려 한 것은 '개입'이 아니라 '차단된 시도'다.
            "external_executed": sorted({
                t for t in tp
                if t not in MCP_TOOLS and t not in HARNESS_TOOLS and t not in disallowed}),
        })

    n = len(rows)
    ok = sum(1 for r in rows if r["verdict"] == "정상")
    fetch = sum(1 for r in rows if r["mcp_fetch"])

    # 라벨 기반 커버리지와 툴경로 기반 커버리지의 2×2 — 두 정의가 얼마나 같은 것을 세는지
    xt = Counter((r["verdict"] == "정상", r["mcp_fetch"]) for r in rows)
    agree = xt[(True, True)] + xt[(False, False)]

    m = {
        "round": round_dir,
        "run": RUN_META.get(round_dir, {}),
        "judge": JUDGE,
        "n_questions": n,
        "n_personas": len({v["persona_uuid"] for v in verdicts.values()}),
        "verdict_counts": dict(Counter(r["verdict"] for r in rows)),
        "metrics": {
            "coverage_label": prop(
                ok, n,
                "판정 라벨이 '정상'인 문항 비율. 리포트·대시보드의 '커버리지'가 이 값이다.",
                "05_report.py:52 — pct(len(ok), n), ok = [r for r in rows if r['verdict']=='정상']"),
            "coverage_toolpath": prop(
                fetch, n,
                "답변 과정에서 데이터 조회 툴(query_product·run_pattern·preview_product)을 "
                "최소 1회 호출한 문항 비율. PLAN.md §3-04 가 원래 정의한 coverage 로, "
                "LLM 판정이 개입하지 않는 객관 지표다.",
                "07_metrics.py — tool_path ∩ MCP_FETCH ≠ ∅"),
            "groundedness": prop(
                sum(1 for r in rows if r["grounded"]), n,
                "판정자가 grounded=true 를 준 비율. '조회 데이터에 근거했거나 한계를 명시함'.",
                "05_report.py:50 — pct(sum(r['grounded']), n)"),
            "usefulness": mean_ci(
                [r["usefulness"] or 0 for r in rows],
                "판정자가 매긴 1~5 정수의 산술평균. 페르소나 관점의 실질적 도움 정도.",
                "05_report.py:51 — sum(usefulness) / n"),
        },
        "coverage_definitions_crosstab": {
            "note": "라벨 기반과 툴경로 기반이 같은 문항을 세는지 확인한다. "
                    "불일치 칸이 두 정의의 차이를 그대로 보여준다.",
            "label정상_and_조회함": xt[(True, True)],
            "label정상_but_조회안함": xt[(True, False)],
            "label비정상_but_조회함": xt[(False, True)],
            "label비정상_and_조회안함": xt[(False, False)],
            "agreement": prop(agree, n, "두 coverage 정의가 같은 판정을 내린 문항 비율", "07_metrics.py"),
        },
        "measurement_isolation": {
            "note": "--allowedTools 는 '자동 승인' 목록이지 '사용 가능' 목록이 아니다. 1~3차는 이것만 "
                    "걸어서 실측 세션이 Bash·Grep 으로 로컬 파일까지 뒤졌다. v4 부터 "
                    "--disallowedTools 로 로컬 툴을 실제로 막았다. "
                    "⚠️ tool_path 는 '시도'를 담는다 — 차단된 호출도 tool_use 로 남으므로, "
                    "차단 목록에 있는 툴은 개입이 아니라 '막힌 시도'로 따로 센다. "
                    "(실측 확인: 차단 시 tool_result 가 is_error=True + 'not enabled in this context')",
            "isolation_enabled": bool(disallowed),
            "disallowed_tools": sorted(disallowed),
            "questions_with_external_tool": prop(
                sum(1 for r in rows if r["external_executed"]), n,
                "로컬 툴이 실제로 실행된 문항 비율 — 진짜 오염 지표. "
                "차단 설정이 있는 회차에서는 차단 목록에 든 툴을 제외한다.",
                "07_metrics.py — tool_path − MCP − HARNESS − disallowed ≠ ∅"),
            "questions_with_blocked_attempt": prop(
                sum(1 for r in rows if r["external"] and not r["external_executed"]), n,
                "로컬 툴을 부르려 했으나 차단된 문항 비율 — 오염이 아니다. "
                "모델이 여전히 로컬 툴을 시도한다는 사실 자체는 기록해 둔다.",
                "07_metrics.py — external ≠ ∅ 이고 external_executed = ∅"),
            "external_tool_counts": dict(Counter(
                t for r in rows for t in r["external"]).most_common()),
            "questions_with_no_mcp_call": prop(
                sum(1 for r in rows if not r["mcp_any"]), n,
                "MCP 툴을 한 번도 부르지 않은 문항 비율", "07_metrics.py"),
        },
        "by_band": {},
    }

    groups = defaultdict(list)
    for r in rows:
        groups[r["band"]].append(r)
    for g, rs in sorted(groups.items()):
        k = sum(1 for r in rs if r["verdict"] == "정상")
        m["by_band"][g] = {
            "coverage_label": prop(k, len(rs), "연령대별 라벨 기반 커버리지", "05_report.py:60"),
            "usefulness": mean_ci([r["usefulness"] or 0 for r in rs],
                                  "연령대별 유용성 평균", "05_report.py:62"),
        }

    m["limitations"] = [
        f"모든 라벨은 LLM 판정자 1명({JUDGE['model']})이 붙였다. 재채점 일치율·사람 검수 "
        f"일치율을 측정한 적이 없으므로 판정 자체의 신뢰도는 이 회차에서 알 수 없다.",
        "판정 이유(rationale)를 저장하지 않아, 개별 문항이 왜 그 라벨을 받았는지 사후 확인이 안 된다.",
        f"n={n} 이므로 비율 지표의 95% 신뢰구간이 넓다. 위 ci95 를 반드시 함께 인용할 것.",
        "usefulness 는 1~5 정수 척도의 평균이라 등간성이 보장되지 않는다. 순서통계로만 읽는 것이 안전하다.",
    ]
    return m


def main() -> None:
    targets = sys.argv[1:] or ROUNDS
    for r in targets:
        m = build(r)
        (OUT / r / "metrics.json").write_text(
            json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
        c = m["metrics"]
        print(f"[{r}] n={m['n_questions']} "
              f"라벨커버리지 {c['coverage_label']['value']}% "
              f"({c['coverage_label']['numerator']}/{c['coverage_label']['denominator']}, "
              f"CI {c['coverage_label']['ci95'][0]}~{c['coverage_label']['ci95'][1]}) · "
              f"툴경로커버리지 {c['coverage_toolpath']['value']}% · "
              f"두 정의 일치 {m['coverage_definitions_crosstab']['agreement']['value']}%")


if __name__ == "__main__":
    main()
