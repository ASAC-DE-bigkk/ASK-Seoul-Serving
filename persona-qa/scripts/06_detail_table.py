# 06 — 문항별 상세표: 질문ID·페르소나·질문·답변·사용 API·인용 제품·판정·보완점.
# 출력: out/detail-table.csv (전문) + out/detail.json (대시보드 임베드용 축약)
# 주의: "사용한 서빙 데이터"는 답변 본문에 product_id 가 명시된 경우만 — 하한값.
#       (실행 당시 툴 인자를 기록하지 않았다. 정확한 정본은 서버 _gateway_request_log.)
import csv
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
MCP_TOOLS = ("list_products", "search_products", "describe_product",
             "preview_product", "query_product", "run_pattern", "check_quota")

# 질문유형 — 우선순위 순서로 첫 매치 하나만 부여
QUESTION_TYPES = [
    ("예보·미래형", r"미리|예보|내일|모레|예측|올지|막힐지|붐빌지|비가 올|그칠지"),
    ("실시간·현재형", r"지금|현재|오늘"),
    ("경로·방법형", r"가는 길|가려면|타는 게|노선|경로|환승|방법|뭐가 더 빠|뭐가 덜"),
    ("시간대·패턴형", r"몇 시|시간대|요일|배차|첫차|막차|새벽|출퇴근 시간"),
    ("순위·비교형", r"제일|가장|어디가|어느 (동네|구|곳)|1위|톱|상위"),
    ("일정·목록형", r"언제 어디서|일정|열리는지|하는지|있는지|있을까|있나"),
    ("추이·이력형", r"추이|요즘|최근|어떻게 (변|달라)|흐름"),
]


def question_type(q: str) -> str:
    for name, pat in QUESTION_TYPES:
        if re.search(pat, q):
            return name
    return "기타"


def main() -> None:
    personas = {p["uuid"]: p for p in
                json.loads((OUT / "personas.json").read_text(encoding="utf-8"))}
    verdicts = json.loads((OUT / "verdicts.json").read_text(encoding="utf-8"))
    catalog = json.loads((OUT / "catalog.json").read_text(encoding="utf-8"))
    product_re = re.compile("|".join(p["product_id"] for p in catalog["products"]))

    rows = []
    for f in sorted((OUT / "answers").glob("*.json")):
        a = json.loads(f.read_text(encoding="utf-8"))
        v = verdicts.get(a["id"], {})
        p = personas[a["persona_uuid"]]
        answer = a.get("answer") or ""
        tools = [t for t in a["tool_path"] if t in MCP_TOOLS]
        rows.append({
            "질문ID": a["id"],
            "페르소나UUID": a["persona_uuid"],
            "페르소나": f"{p['age']}세 {p['sex']} · {p['district'].replace('서울-', '')} · {p['occupation']}",
            "질문": a["question"],
            "질문유형": question_type(a["question"]),
            "답변": answer,
            "사용한 API": " → ".join(tools) or "(없음)",
            "사용한 서빙 데이터(답변 명시 기준)": ", ".join(sorted(set(product_re.findall(answer)))) or "(미표기)",
            "판정": v.get("verdict", "미채점"),
            "실측 모델": a.get("model", "cli-default"),
            "보완점(gap)": v.get("gap") or "",
        })

    csv_path = OUT / "detail-table.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fh:  # BOM — 엑셀 호환
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    compact = [{**r, "답변": r["답변"][:220] + ("…" if len(r["답변"]) > 220 else "")}
               for r in rows]
    (OUT / "detail.json").write_text(
        json.dumps(compact, ensure_ascii=False), encoding="utf-8")
    print(f"→ {csv_path} ({len(rows)}행) · detail.json")


if __name__ == "__main__":
    main()
