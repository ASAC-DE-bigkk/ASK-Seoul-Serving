# 03 — 질문 150건을 headless Claude + 원격 MCP(ask-seoul.kr/mcp)로 실측.
# mcp-eval-57 과 같은 방법론. 툴 호출 경로를 stream-json 에서 추출해 함께 기록한다.
#
# 사전 조건: 환경변수 ASK_SEOUL_KEY (전용 이메일로 발급한 테스트 키 — PLAN.md §4).
#            끝나면 반드시 purge: DELETE /api/v1/keys?purge=true
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
CLAUDE = shutil.which("claude") or "claude"  # Windows: claude.cmd 해석
ANSWERS = OUT / "answers"
SYSTEM_HINT = ("서울 데이터 MCP 도구만 사용해 답하라. "
               "데이터에 없는 것은 없다고 말하고 지어내지 마라.")


def mcp_config_path(key: str) -> str:
    cfg = {"mcpServers": {"askseoul": {
        "type": "http", "url": "https://ask-seoul.kr/mcp",
        "headers": {"Authorization": f"Bearer {key}"},
    }}}
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(cfg, f)
    f.close()
    return f.name


def run_one(question: str, cfg_path: str) -> dict:
    # 질문은 stdin 으로 — claude.cmd(배치 래퍼)가 여러 줄/특수문자 인자를 깨뜨린다
    cmd = [CLAUDE, "-p",
           "--append-system-prompt", SYSTEM_HINT,
           "--mcp-config", cfg_path, "--strict-mcp-config",
           "--allowedTools", "mcp__askseoul__*",
           "--output-format", "stream-json", "--verbose"]
    r = subprocess.run(cmd, input=question, capture_output=True, text=True,
                       encoding="utf-8", timeout=600)
    tool_path: list[str] = []
    answer, is_error = None, r.returncode != 0
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    tool_path.append(block["name"].removeprefix("mcp__askseoul__"))
        elif ev.get("type") == "result":
            answer = ev.get("result")
            is_error = is_error or ev.get("is_error", False)
    return {"answer": answer, "tool_path": tool_path, "error": is_error,
            "stderr": r.stderr[-300:] if is_error else None}


def process(q: dict, cfg: str) -> str:
    out_file = ANSWERS / f"{q['id']}.json"
    result = run_one(q["question"], cfg)
    out_file.write_text(json.dumps({**q, **result}, ensure_ascii=False, indent=1),
                        encoding="utf-8")
    status = "ERR" if result["error"] else "→".join(result["tool_path"]) or "툴 미사용"
    return f"[{q['id']}] {status} | {q['question'][:40]}…"


def main() -> None:
    key = os.environ.get("ASK_SEOUL_KEY")
    if not key:
        sys.exit("ASK_SEOUL_KEY 환경변수가 없다 — PLAN.md §4 대로 전용 키를 발급하라.")
    questions = json.loads((OUT / "questions.json").read_text(encoding="utf-8"))
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(questions)
    workers = int(os.environ.get("WORKERS", "3"))  # 버스트 한도를 넘지 않게 소폭 병렬
    ANSWERS.mkdir(parents=True, exist_ok=True)
    cfg = mcp_config_path(key)
    todo = [q for q in questions if not (ANSWERS / f"{q['id']}.json").exists()][:limit]
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(process, q, cfg) for q in todo]
        for fut in as_completed(futures):
            done += 1
            print(f"({done}/{len(todo)}) {fut.result()}", flush=True)
    os.unlink(cfg)
    print(f"이번 실행 {done}건 · 누적 {len(list(ANSWERS.glob('*.json')))}건 / {len(questions)}건")


if __name__ == "__main__":
    main()
