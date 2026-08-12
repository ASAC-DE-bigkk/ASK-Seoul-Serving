# 10 — 전 회차 페르소나·질문 통합표.
#
# 지금까지 쓴 페르소나와 질문이 회차 폴더에 흩어져 있어 "누구한테 뭘 물었나"를 한눈에 볼 수 없다.
# 문항 하나를 한 행으로 펴고 페르소나 속성을 붙여 하나의 파일로 만든다.
#
# 회차 폴더를 건드리지 않는다 — 읽기만 하고 out/shared/ 에 새 파일로 쓴다.
# 회차가 늘거나 채점이 끝나면 다시 돌리면 된다(순수 집계, LLM 호출 없음).
#
# 사용: python scripts/10_consolidate.py
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
SHARED = OUT / "shared"

# 회차 정의 — (라벨, 페르소나 파일, 질문 파일, 회차 폴더)
# 2차는 1차 질문 60건을 그대로 재사용했으므로 질문 파일이 따로 없다.
ROUNDS = [
    ("1차", SHARED / "personas-v1v2.json", SHARED / "questions-v1v2.json", "v1-20260811"),
    ("2차", SHARED / "personas-v1v2.json", None, "v2-20260812"),
    ("3차", OUT / "v3-20260812" / "personas.json", OUT / "v3-20260812" / "questions.json",
     "v3-20260812"),
    ("4차", OUT / "v4-20260812" / "personas.json", OUT / "v4-20260812" / "questions.json",
     "v4-20260812"),
]

# 06_detail_table.py 와 같은 분류 규칙 — 두 산출물의 '질문유형'이 어긋나지 않게 한다.
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


def load(p) -> object:
    return json.loads(Path(p).read_text(encoding="utf-8")) if p and Path(p).exists() else None


def main() -> None:
    personas: dict[str, dict] = {}          # uuid → 속성
    persona_rounds: dict[str, list] = {}    # uuid → 등장 회차
    questions: dict[str, dict] = {}         # qid → 질문
    verdicts: dict[str, dict] = {}          # 회차라벨 → {qid: verdict}
    asked: dict[str, set] = {}              # 회차라벨 → 출제된 qid
    measured: dict[str, set] = {}           # 회차라벨 → 실제 실측된 qid

    for label, pf, qf, rdir in ROUNDS:
        for p in (load(pf) or []):
            personas.setdefault(p["uuid"], p)
            persona_rounds.setdefault(p["uuid"], [])
        for q in (load(qf) or []):
            questions.setdefault(q["id"], q)
        v = load(OUT / rdir / "verdicts.json") or {}
        verdicts[label] = v
        # 2차는 질문 파일이 없다 — 판정된 문항이 곧 출제 목록이다.
        asked[label] = set(q["id"] for q in (load(qf) or [])) if qf else set(v)
        adir = OUT / rdir / "answers"
        measured[label] = {f.stem for f in adir.glob("*.json")} if adir.is_dir() else set()
        for qid in asked[label] | measured[label] | set(v):
            q = questions.get(qid)
            if q and q["persona_uuid"] in persona_rounds:
                if label not in persona_rounds[q["persona_uuid"]]:
                    persona_rounds[q["persona_uuid"]].append(label)

    labels = [r[0] for r in ROUNDS]
    rows = []
    for qid, q in questions.items():
        p = personas.get(q["persona_uuid"], {})
        used = [l for l in labels if qid in asked[l]]
        row = {
            "질문ID": qid,
            "출제 회차": " · ".join(used),
            "최초 회차": used[0] if used else "",
            "페르소나UUID": q["persona_uuid"],
            "나이": p.get("age"), "성별": p.get("sex"),
            "자치구": (p.get("district") or "").replace("서울-", ""),
            "직업": p.get("occupation"),
            "학력": p.get("education_level"), "혼인상태": p.get("marital_status"),
            "가구형태": p.get("family_type"),
            "취미": ", ".join((p.get("hobbies_and_interests_list") or [])[:5]),
            "페르소나 소개": (p.get("persona") or "").replace("\n", " "),
            "질문": q["question"],
            "질문유형": question_type(q["question"]),
        }
        for l in labels:
            row[f"{l} 실측"] = ("O" if qid in measured[l] else
                               ("미실측" if qid in asked[l] else ""))
            row[f"{l} 판정"] = verdicts[l].get(qid, {}).get("verdict", "")
        rows.append(row)

    rows.sort(key=lambda r: (labels.index(r["최초 회차"]) if r["최초 회차"] in labels else 99,
                             r["질문ID"]))

    csv_path = SHARED / "all-personas-questions.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as fh:  # BOM — 엑셀 호환
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # 통계 — 발표에서 "표본이 몇 명이냐"에 바로 답할 수 있게
    print(f"→ {csv_path}")
    print(f"   페르소나 {len(personas)}명 (전 회차 중복 없음) · 질문 {len(rows)}건")
    for l in labels:
        n_ask, n_mea = len(asked[l]), len(measured[l])
        pu = {questions[q]["persona_uuid"] for q in asked[l] if q in questions}
        print(f"   {l}: 출제 {n_ask}건 · 실측 {n_mea}건 · 판정 {len(verdicts[l])}건"
              f" · 페르소나 {len(pu) or '—'}명")
    reused = [r["질문ID"] for r in rows if len(r["출제 회차"].split(" · ")) > 1]
    print(f"   여러 회차에 쓰인 질문: {len(reused)}건 (1차 질문을 2차가 재사용)")
    print(f"   질문유형 분포: {dict(Counter(r['질문유형'] for r in rows).most_common())}")


if __name__ == "__main__":
    main()
