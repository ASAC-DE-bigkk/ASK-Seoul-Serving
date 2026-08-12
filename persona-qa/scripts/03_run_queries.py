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

# Windows 기본 콘솔은 cp949 라 한글 출력에서 UnicodeEncodeError 로 죽는다.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


_args = sys.argv[1:]
ROUND = _args[0] if _args and not _args[0].isdigit() else None
LIMIT_ARG = next((a for a in _args if a.isdigit()), None)
OUT = (Path(__file__).resolve().parent.parent / "out" / ROUND if ROUND
       else Path(__file__).resolve().parent.parent / "out")
CLAUDE = shutil.which("claude") or "claude"  # Windows: claude.cmd 해석
MODEL = os.environ.get("MODEL")  # 미지정이면 CLI 기본 모델
ANSWERS = OUT / "answers"
SYSTEM_HINT = ("서울 데이터 MCP 도구만 사용해 답하라. "
               "데이터에 없는 것은 없다고 말하고 지어내지 마라.")

# ── 측정 격리 (v4 부터) ────────────────────────────────────────────────
# --allowedTools 는 '자동 승인' 목록이지 '사용 가능' 목록이 아니다. 1~3차는 이것만 걸었고,
# 그 결과 실측 세션이 Bash·Grep·Read 로 로컬 파일까지 뒤졌다(1차 문항의 35.5%).
# 그러면 "MCP 데이터로 답했다"는 전제가 깨지므로 로컬 툴을 명시적으로 차단한다.
# ToolSearch 는 지연 로딩된 MCP 툴 스키마를 불러오는 경로라 반드시 살려둔다 —
# 이것까지 막으면(--tools "") MCP 호출이 0건이 되고 모델이 조회 없이 답한다(실측 확인).
# AskUserQuestion 도 남긴다 — '되물음'은 유효한 판정 라벨이다.
BLOCKED_TOOLS = ["Bash", "PowerShell", "Read", "Write", "Edit", "Grep", "Glob",
                 "Agent", "Task", "Skill", "WebFetch", "WebSearch", "NotebookEdit"]


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
           *(["--model", MODEL] if MODEL else []),
           "--append-system-prompt", SYSTEM_HINT,
           "--mcp-config", cfg_path, "--strict-mcp-config",
           "--allowedTools", "mcp__askseoul__*",
           "--disallowedTools", *BLOCKED_TOOLS,
           "--output-format", "stream-json", "--verbose"]
    try:
        r = subprocess.run(cmd, input=question, capture_output=True, text=True,
                           encoding="utf-8", timeout=600)
    except subprocess.TimeoutExpired:  # 한 건의 타임아웃이 배치 전체를 죽이지 않게
        return {"answer": None, "tool_path": [], "error": True,
                "model": MODEL or "cli-default", "stderr": "timeout(600s)"}
    tool_path: list[str] = []
    # tool_path 는 '시도'를 담는다 — 차단된 호출도 assistant 스트림엔 tool_use 로 남는다.
    # 차단 여부를 구분하지 않으면 "로컬 툴이 개입했다"와 "개입하려다 막혔다"가 뒤섞인다.
    # (실측 확인: 차단 시 tool_result 가 is_error=True + "not enabled in this context")
    by_id: dict[str, str] = {}
    blocked: list[str] = []
    answer, is_error = None, r.returncode != 0
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    name = block["name"].removeprefix("mcp__askseoul__")
                    tool_path.append(name)
                    by_id[block.get("id")] = name
        elif ev.get("type") == "user":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_result" and block.get("is_error"):
                    txt = block.get("content")
                    txt = txt if isinstance(txt, str) else json.dumps(txt, ensure_ascii=False)
                    if "not enabled in this context" in txt or "No such tool available" in txt:
                        blocked.append(by_id.get(block.get("tool_use_id"), "?"))
        elif ev.get("type") == "result":
            answer = ev.get("result")
            is_error = is_error or ev.get("is_error", False)
    return {"answer": answer, "tool_path": tool_path, "error": is_error,
            "model": MODEL or "cli-default",
            # 격리 설정을 문항마다 남긴다 — 나중에 "이 회차는 정말 MCP 만 썼나"를
            # 로그가 아니라 산출물만 보고 확인할 수 있어야 한다.
            "isolation": {"disallowed_tools": BLOCKED_TOOLS, "strict_mcp_config": True,
                          "blocked_calls": blocked},
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
    # --only <파일>: 실측할 질문ID 목록. 쿼터가 모자랄 때 부분 실측하고,
    # 어느 문항을 뺐는지 산출물로 남기기 위한 것 — 조용히 잘라내지 않는다.
    if "--only" in sys.argv:
        keep = set(json.loads((OUT / sys.argv[sys.argv.index("--only") + 1])
                              .read_text(encoding="utf-8")))
        skipped = len(questions) - len(keep)
        questions = [q for q in questions if q["id"] in keep]
        print(f"부분 실측: {len(questions)}건 대상 (제외 {skipped}건)")
    limit = int(LIMIT_ARG) if LIMIT_ARG else len(questions)
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
