# 04 — 실측 답변 채점.
# 루브릭: PLAN.md §3-04. trap 기준 재사용 — 지어내지 않고 한계를 밝히면 groundedness PASS.
#
# 사용:
#   python scripts/04_judge.py v4-20260812                      # 기본 판정자(haiku) → verdicts.json
#   python scripts/04_judge.py v4-20260812 --out verdicts-rejudge.json --only sample40.json
#   python scripts/04_judge.py v4-20260812 --model claude-sonnet-5 \
#          --out verdicts-sonnet.json --only sample40.json
#   python scripts/04_judge.py                                   # out/ 평면 (정리 전 레이아웃)
#
# ── 판정 이유(rationale)에 관한 설계 주의 ──────────────────────────────
# v4 부터 판정 이유를 함께 받는다. 다만 JSON 키 순서를 verdict → … → rationale 로 고정한다.
# 모델은 앞에서부터 토큰을 생성하므로, 이유를 먼저 쓰게 하면 그 추론이 라벨을 바꿔
# 1~3차와 라벨 분포를 비교할 수 없게 된다. 라벨을 먼저 확정시키고 이유를 뒤에 붙이면
# 판정 절차 자체는 이전 회차와 동일하게 유지된다.
import hashlib
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent.parent
CLAUDE = shutil.which("claude") or "claude"  # Windows: claude.cmd 해석
DEFAULT_MODEL = "claude-haiku-4-5-20251001"  # 비용 절약 — 사용자 요청(2026-08-10)
# 1·2·3차 전부 이 모델이 채점했다. 회차마다 판정자를 바꾸면 라벨 분포가 판정자 때문에
# 움직인 건지 서비스 때문인지 갈라낼 수 없어, 판정 품질보다 비교 가능성을 택했다.

PROMPT = """서울 공공데이터 MCP 서비스의 답변을 채점한다.

## 질문자 프로필
{profile}

## 질문
{question}

## 서비스가 사용한 툴 경로
{tool_path}

## 서비스 답변
{answer}

## 채점 기준
- verdict: "정상"(데이터로 답함) / "되물음"(장소·기간 등을 확인하러 반문) /
  "데이터없음"(해당 데이터가 없다고 정직하게 밝힘) / "환각의심"(툴 결과 없이
  단정하거나 데이터에 없을 내용을 지어냄) / "오류"(실행 실패)
- grounded: 답이 조회 데이터에 근거했거나 한계를 명시했으면 true. 지어냈으면 false.
- usefulness: 이 질문자에게 실질적 도움 정도 1~5 (데이터없음이라도 정직하고
  대안을 안내했으면 2~3점 가능).
- gap: 답하지 못한 원인이 데이터 쪽 간극이면 한 줄로 (예: "자치구 단위 없음",
  "해당 주제 제품 부재"). 없으면 null.
- rationale: 위 verdict 를 그렇게 판정한 근거를 한국어 한 문장으로. 답변에서
  근거가 된 대목을 짚어라. (반드시 verdict 를 정한 뒤에 쓴다)

JSON 만 출력하되 키 순서를 지켜라:
{{"verdict": "...", "grounded": true, "usefulness": 3, "gap": null, "rationale": "..."}}"""

PROMPT_SHA = hashlib.sha256(PROMPT.encode("utf-8")).hexdigest()[:12]


def judge(item: dict, personas: dict, model: str) -> dict:
    p = personas[item["persona_uuid"]]
    profile = f"{p['age']}세 {p['sex']}, {p['district']} 거주, {p['occupation']}"
    if item.get("error") or not item.get("answer"):
        return {"verdict": "오류", "grounded": False, "usefulness": 1, "gap": None,
                "rationale": "실행 실패 — 답변이 생성되지 않았다(채점자 호출 없음)."}
    prompt = PROMPT.format(profile=profile, question=item["question"],
                           tool_path=" → ".join(item["tool_path"]) or "(툴 미사용)",
                           answer=item["answer"][:4000])
    # 프롬프트는 stdin 으로 — claude.cmd(배치 래퍼)가 여러 줄 인자를 깨뜨린다
    r = subprocess.run([CLAUDE, "-p", "--model", model, "--output-format", "json"],
                       input=prompt, capture_output=True, text=True,
                       encoding="utf-8", timeout=180)
    result = json.loads(r.stdout)["result"]
    return json.loads(result[result.find("{"):result.rfind("}") + 1])


def main() -> None:
    args = sys.argv[1:]
    round_dir = args[0] if args and not args[0].startswith("--") else None
    out_name, model, only = "verdicts.json", DEFAULT_MODEL, None
    for i, a in enumerate(args):
        if a == "--out":
            out_name = args[i + 1]
        elif a == "--model":
            model = args[i + 1]
        elif a == "--only":
            only = args[i + 1]

    OUT = ROOT / "out" / round_dir if round_dir else ROOT / "out"
    SHARED = ROOT / "out" / "shared"
    pf = OUT / "personas.json"
    if not pf.exists():
        pf = SHARED / "personas-v1v2.json"
    personas = {p["uuid"]: p for p in json.loads(pf.read_text(encoding="utf-8"))}

    files = sorted((OUT / "answers").glob("*.json"))
    if only:  # 검증용 부분 채점 — 대상 질문ID 목록 JSON
        keep = set(json.loads((OUT / only).read_text(encoding="utf-8")))
        files = [f for f in files if f.stem in keep]

    out_file = OUT / out_name
    verdicts = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else {}
    meta = {"judge_model": model, "prompt_sha256_12": PROMPT_SHA,
            "rubric": "PLAN.md §3-04", "answer_chars_seen": 4000,
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    for i, f in enumerate(files):
        item = json.loads(f.read_text(encoding="utf-8"))
        if item["id"] in verdicts:
            continue
        t0 = time.time()
        v = judge(item, personas, model)
        verdicts[item["id"]] = {
            **v, "tool_path": item["tool_path"], "persona_uuid": item["persona_uuid"],
            # 판정자 메타를 문항마다 남긴다 — "누가 언제 무슨 프롬프트로 채점했나"에
            # 사후에 답할 수 있어야 하기 때문. 1~3차에는 이 기록이 없다.
            "_judge": {"model": model, "prompt_sha256_12": PROMPT_SHA,
                       "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       "elapsed_s": round(time.time() - t0, 1)},
        }
        out_file.write_text(json.dumps(verdicts, ensure_ascii=False, indent=1),
                            encoding="utf-8")
        print(f"[{i + 1}/{len(files)}] {item['id']}: {v['verdict']} u={v['usefulness']}",
              flush=True)

    (OUT / f"{out_file.stem}-meta.json").write_text(
        json.dumps({**meta, "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "n_judged": len(verdicts)}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {out_file} ({len(verdicts)}건, 판정자 {model})")


if __name__ == "__main__":
    main()
