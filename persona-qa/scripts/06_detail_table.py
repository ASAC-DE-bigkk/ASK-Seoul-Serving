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
