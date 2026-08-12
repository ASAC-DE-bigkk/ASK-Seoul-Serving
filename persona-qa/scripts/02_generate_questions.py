# 02 — 페르소나당 질문 3건 생성 (claude-sonnet-5, headless).
# 57개 제품 목록은 절대 프롬프트에 넣지 않는다 — 카탈로그를 모르는 수요를 흉내낸다.
#
# 사용: python scripts/02_generate_questions.py v4-20260812 [limit]
import json
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


_args = [a for a in sys.argv[1:]]
ROUND = _args[0] if _args and not _args[0].isdigit() else None
LIMIT_ARG = next((a for a in _args if a.isdigit()), None)
OUT = (Path(__file__).resolve().parent.parent / "out" / ROUND if ROUND
       else Path(__file__).resolve().parent.parent / "out")
MODEL = "claude-sonnet-5"
CLAUDE = shutil.which("claude") or "claude"  # Windows: claude.cmd 해석

PROMPT = """아래는 서울에 사는 한 인물의 프로필이다.

{profile}

이 인물이 일상·일·취미 속에서 "서울에 관한 데이터"로 답을 얻을 수 있을 법한
궁금증 3가지를 이 인물의 입말로 작성하라. 조건:
- 주제는 상권·창업, 도시생활(대기질·충전소 등), 문화행사, 도로교통, 대중교통, 날씨
  중에서 이 인물에게 자연스러운 것만 고른다 (억지로 분산하지 않는다).
- 특정 서비스나 데이터셋 이름을 언급하지 않는다. 인물이 자기 동네·직업·취미
  맥락에서 물을 법한 구체적 질문이어야 한다.
- JSON 배열만 출력한다: ["질문1", "질문2", "질문3"]"""


def profile_text(p: dict) -> str:
    hobbies = ", ".join((p.get("hobbies_and_interests_list") or [])[:4])
    return (
        f"- {p['age']}세 {p['sex']}, {p['district'].replace('서울-', '')} 거주\n"
        f"- 직업: {p['occupation']} / 학력: {p['education_level']} / {p['marital_status']}\n"
        f"- 취미: {hobbies}\n"
        f"- 소개: {p['persona'][:300]}"
    )


def generate(p: dict) -> list[str]:
    # 프롬프트는 stdin 으로 — claude.cmd(배치 래퍼)가 여러 줄 인자를 깨뜨린다
    cmd = [CLAUDE, "-p", "--model", MODEL, "--output-format", "json"]
    r = subprocess.run(cmd, input=PROMPT.format(profile=profile_text(p)),
                       capture_output=True, text=True, encoding="utf-8", timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"claude 실패(uuid={p['uuid'][:8]}): {r.stderr[:300]}")
    result = json.loads(r.stdout)["result"]
    start, end = result.find("["), result.rfind("]")
    questions = json.loads(result[start:end + 1])
    assert isinstance(questions, list) and len(questions) == 3
    return questions


def main() -> None:
    personas = json.loads((OUT / "personas.json").read_text(encoding="utf-8"))
    limit = int(LIMIT_ARG) if LIMIT_ARG else len(personas)
    out_file = OUT / "questions.json"
    done: dict = {}
    if out_file.exists():  # 재실행 시 이어서
        done = {q["persona_uuid"]: True for q in json.loads(out_file.read_text(encoding="utf-8"))}
    results = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else []
    for i, p in enumerate(personas[:limit]):
        if p["uuid"] in done:
            continue
        qs = generate(p)
        for j, q in enumerate(qs):
            results.append({
                "id": f"{p['uuid'][:8]}-q{j + 1}", "persona_uuid": p["uuid"],
                "question": q,
            })
        out_file.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[{i + 1}/{limit}] {p['district']} {p['age']}세 {p['occupation']}: {qs[0][:40]}…")
    print(f"→ {out_file} ({len(results)}문항)")


if __name__ == "__main__":
    main()
