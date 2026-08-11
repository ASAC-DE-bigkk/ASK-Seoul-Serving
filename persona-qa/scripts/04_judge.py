# 04 — 실측 답변 채점 (claude-sonnet-5, headless).
# 루브릭: PLAN.md §3-04. trap 기준 재사용 — 지어내지 않고 한계를 밝히면 groundedness PASS.
import json
import shutil
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
ANSWERS = OUT / "answers"
MODEL = "claude-haiku-4-5-20251001"  # 비용 절약 — 사용자 요청(2026-08-10)
CLAUDE = shutil.which("claude") or "claude"  # Windows: claude.cmd 해석

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

JSON 만 출력: {{"verdict": "...", "grounded": true, "usefulness": 3, "gap": null}}"""


def judge(item: dict, personas: dict) -> dict:
    p = personas[item["persona_uuid"]]
    profile = f"{p['age']}세 {p['sex']}, {p['district']} 거주, {p['occupation']}"
    if item.get("error") or not item.get("answer"):
        return {"verdict": "오류", "grounded": False, "usefulness": 1, "gap": None}
    prompt = PROMPT.format(profile=profile, question=item["question"],
                           tool_path=" → ".join(item["tool_path"]) or "(툴 미사용)",
                           answer=item["answer"][:4000])
    # 프롬프트는 stdin 으로 — claude.cmd(배치 래퍼)가 여러 줄 인자를 깨뜨린다
    r = subprocess.run([CLAUDE, "-p", "--model", MODEL, "--output-format", "json"],
                       input=prompt, capture_output=True, text=True,
                       encoding="utf-8", timeout=180)
    result = json.loads(r.stdout)["result"]
    return json.loads(result[result.find("{"):result.rfind("}") + 1])


def main() -> None:
    personas = {p["uuid"]: p for p in
                json.loads((OUT / "personas.json").read_text(encoding="utf-8"))}
    out_file = OUT / "verdicts.json"
    verdicts = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else {}
    files = sorted(ANSWERS.glob("*.json"))
    for i, f in enumerate(files):
        item = json.loads(f.read_text(encoding="utf-8"))
        if item["id"] in verdicts:
            continue
        v = judge(item, personas)
        verdicts[item["id"]] = {**v, "tool_path": item["tool_path"],
                                "persona_uuid": item["persona_uuid"]}
        out_file.write_text(json.dumps(verdicts, ensure_ascii=False, indent=1),
                            encoding="utf-8")
        print(f"[{i + 1}/{len(files)}] {item['id']}: {v['verdict']} u={v['usefulness']}")
    print(f"→ {out_file} ({len(verdicts)}건)")


if __name__ == "__main__":
    main()
