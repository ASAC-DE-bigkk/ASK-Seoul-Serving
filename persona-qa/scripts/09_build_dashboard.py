# 09 — 회차 대시보드 생성. 어느 회차든 같은 스크립트로 만든다.
#
# 입력은 전부 산출물이다: summary.json · metrics.json · (있으면) reliability.json.
# 회차마다 별도 빌더(v2_build_dashboard / v3_build_dashboard)를 두던 것을 여기로 합쳤다.
# 그 둘은 손으로 쓴 서술(사례·전후 비교)이 섞여 있어 재현용으로 archive/ 에 남겼다.
#
# 사용: python scripts/09_build_dashboard.py v4-20260812
#
# 모든 %에 분자/분모와 95% CI 를 함께 찍는다 — 발표에서 "그건 뭘 나눈 건가요"에
# 대시보드만 보고 답할 수 있어야 하기 때문. 정의서는 persona-qa/METHOD.md.
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent

# 판정은 계열(categorical)이 아니라 상태(status) 척도다 — 정상 good / 되물음 warning /
# 데이터없음 serious / 환각·오류 critical. 상태 색은 반드시 라벨·표와 함께 쓴다.
CSS = """
:root{--plane:#f6f5f1;--surface:#fdfcfa;--sunk:#f0eee7;--ink:#16150f;--ink-2:#57544a;
--muted:#8a8578;--rule:#e2dfd4;--ok:#17705a;--ask:#c07d16;--none:#a8503a;--bad:#7d2440;
--shadow:0 1px 2px rgba(22,21,15,.05),0 8px 24px -18px rgba(22,21,15,.35);}
@media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
--plane:#121211;--surface:#1c1b19;--sunk:#232220;--ink:#f4f3ee;--ink-2:#b8b4a7;
--muted:#8d887b;--rule:#302e2a;--ok:#3f9d80;--ask:#d69a3c;--none:#c9705a;--bad:#a83a52;
--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px -20px rgba(0,0,0,.8);}}
:root[data-theme="dark"]{--plane:#121211;--surface:#1c1b19;--sunk:#232220;--ink:#f4f3ee;
--ink-2:#b8b4a7;--muted:#8d887b;--rule:#302e2a;--ok:#3f9d80;--ask:#d69a3c;--none:#c9705a;
--bad:#a83a52;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px -20px rgba(0,0,0,.8);}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);word-break:keep-all;overflow-wrap:break-word;
font:400 15px/1.65 system-ui,-apple-system,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:44px 20px 80px;display:flex;flex-direction:column;gap:40px}
.wrap,section,.chart,.panel,.scroll,.kpis,.kpi,.smalls,.row,.brow,.track,.stack,.btrack{min-width:0}
.eyebrow{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;font-weight:600}
h1{font-size:1.75rem;line-height:1.25;margin:0 0 10px;letter-spacing:-.02em;text-wrap:balance;font-weight:700}
h2{font-size:1.08rem;margin:0 0 4px;letter-spacing:-.01em;font-weight:650}
.lede{color:var(--ink-2);margin:0;max-width:66ch}
section{display:flex;flex-direction:column;gap:16px}
.sec-note{color:var(--ink-2);margin:0;max-width:68ch;font-size:.94rem}
.sec-note b{color:var(--ink);font-weight:650}
.caution{background:var(--sunk);border:1px solid var(--rule);border-left:2px solid var(--ok);
border-radius:3px;padding:18px 20px}
.caution p{margin:0 0 8px;font-size:.88rem;color:var(--ink-2);line-height:1.65;max-width:70ch}
.caution p:last-child{margin-bottom:0}.caution b{color:var(--ink)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--surface);border:1px solid var(--rule);border-top:2px solid var(--muted);
border-radius:3px;padding:16px;display:flex;flex-direction:column;gap:6px;box-shadow:var(--shadow)}
.kpi.hi{border-top-color:var(--ok)}
.kpi-lab{font-size:.8rem;color:var(--ink-2);font-weight:600}
.kpi-val{font-size:1.7rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.kpi.hi .kpi-val{color:var(--ok)}
.kpi-note{margin:0;font-size:.76rem;color:var(--muted);line-height:1.5}
.kpi-note b{color:var(--ink-2)}
.chart{background:var(--surface);border:1px solid var(--rule);border-radius:3px;
padding:20px 22px 16px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:13px}
.row{display:grid;grid-template-columns:120px 1fr 190px;align-items:center;gap:14px}
.rlab{font-size:.87rem;font-weight:600;display:flex;flex-direction:column;gap:1px}
.rn{font-size:.68rem;color:var(--muted);font-weight:500;font-variant-numeric:tabular-nums}
.track{display:block;position:relative;height:22px;background:var(--sunk);border-radius:2px}
.bar{display:block;height:100%;background:var(--ok);opacity:.85;border-radius:2px 4px 4px 2px}
.ref2{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink-2);opacity:.8}
.rval{font-size:.85rem;font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.stack{display:flex;height:26px;gap:2px}
.seg{height:100%;border-radius:2px}
.seg.s-ok{background:var(--ok)}.seg.s-ask{background:var(--ask)}.seg.s-none{background:var(--none)}
.seg.s-bad,.sw-bad{background:repeating-linear-gradient(45deg,transparent 0 3px,rgba(255,255,255,.42) 3px 5px),var(--bad)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.78rem;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px;font-weight:600}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.sw-ok{background:var(--ok)}.sw-ask{background:var(--ask)}.sw-none{background:var(--none)}
.smalls{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.panel{background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:16px 18px;
box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px}
.panel h3{margin:0;font-size:.85rem;font-weight:650}
.panel .sub{margin:0;font-size:.72rem;color:var(--muted)}
.brow{display:grid;grid-template-columns:52px 1fr 118px;align-items:center;gap:10px;font-size:.79rem}
.blab{color:var(--ink-2);font-weight:600}
.btrack{display:block;height:10px;background:var(--sunk);border-radius:2px}
.bbar{display:block;height:100%;background:var(--ok);opacity:.75;border-radius:2px 3px 3px 2px}
.bval{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:.72rem}
table{border-collapse:collapse;width:100%;font-size:.84rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule)}
th{color:var(--ink-2);font-weight:650;font-size:.78rem}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}.scroll table{min-width:520px}
footer{border-top:1px solid var(--rule);padding-top:16px;color:var(--muted);font-size:.78rem;line-height:1.7}
code{font:500 .92em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink-2)}
"""


def esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def ci(m: dict) -> str:
    """지표 dict → '39/60 · CI 52.4~75.8'"""
    return f"<b>{m['numerator']} ÷ {m['denominator']}</b> · CI {m['ci95'][0]}~{m['ci95'][1]}"


def kpi(label: str, value: str, note: str, hi: bool = False) -> str:
    return (f'<div class="kpi{" hi" if hi else ""}"><span class="kpi-lab">{esc(label)}</span>'
            f'<span class="kpi-val">{esc(value)}</span><p class="kpi-note">{note}</p></div>')


def build(round_dir: str) -> str:
    d = ROOT / "out" / round_dir
    M = json.loads((d / "metrics.json").read_text(encoding="utf-8"))
    S = json.loads((d / "summary.json").read_text(encoding="utf-8"))
    R = json.loads((d / "reliability.json").read_text(encoding="utf-8")) \
        if (d / "reliability.json").exists() else None
    c, run, xt, iso = M["metrics"], M.get("run", {}), M["coverage_definitions_crosstab"], \
        M["measurement_isolation"]
    n = M["n_questions"]

    parts = [f'''<header>
  <p class="eyebrow">ASK: SEOUL · 페르소나 품질 테스트</p>
  <h1>{esc(round_dir)} — 문항 {n}건 · 페르소나 {M["n_personas"]}명</h1>
  <p class="lede">{esc(run.get("purpose", ""))} · 실측 모델 {esc(run.get("answer_model", "—"))}
  · 판정자 <code>{esc(M["judge"]["model"])}</code></p>
</header>

<section class="caution">
  <h2>이 숫자들은 어떻게 계산됐나</h2>
  <p><b>커버리지(라벨)는 판정 '정상' 건수 ÷ 전체 문항 수</b>다. 그 '정상'은 판정자
  <code>{esc(M["judge"]["model"])}</code>가 질문·툴 호출 경로·답변 본문(앞 4000자)을 읽고
  5개 라벨 중 하나를 고른 결과다.</p>
  <p>모든 비율에 <b>분자/분모</b>와 <b>Wilson 95% 신뢰구간</b>을 병기했다. 계산 정의·한계는
  <code>persona-qa/METHOD.md</code>, 기계 판독본은 이 폴더의 <code>metrics.json</code>.</p>
</section>

<section>
  <h2>헤드라인</h2>
  <div class="kpis">
    {kpi("커버리지 (라벨)", f'{c["coverage_label"]["value"]}%', ci(c["coverage_label"]), hi=True)}
    {kpi("커버리지 (툴경로)", f'{c["coverage_toolpath"]["value"]}%', ci(c["coverage_toolpath"]))}
    {kpi("근거성", f'{c["groundedness"]["value"]}%', ci(c["groundedness"]))}
    {kpi("유용성", f'{c["usefulness"]["value"]}/5',
         f'<b>합 {c["usefulness"]["sum"]} ÷ {c["usefulness"]["n"]}</b> · sd {c["usefulness"]["sd"]}')}
  </div>
</section>''']

    # ── 판정 분포 ──────────────────────────────────────────────
    counts = M["verdict_counts"]
    order = [("정상", "s-ok"), ("되물음", "s-ask"), ("데이터없음", "s-none")]
    bad = counts.get("환각의심", 0) + counts.get("오류", 0)
    segs = "".join(
        f'<i class="seg {cls}" style="width:{100 * counts.get(lab, 0) / n:.2f}%"></i>'
        for lab, cls in order if counts.get(lab, 0))
    if bad:
        segs += f'<i class="seg s-bad" style="width:{100 * bad / n:.2f}%"></i>'
    rows = "".join(
        f'<tr><td>{esc(lab)}</td><td class="num">{counts.get(lab, 0)}</td>'
        f'<td class="num">{100 * counts.get(lab, 0) / n:.1f}%</td></tr>'
        for lab in ["정상", "되물음", "데이터없음", "환각의심", "오류"] if counts.get(lab, 0))
    parts.append(f'''<section>
  <h2>판정 분포</h2>
  <p class="sec-note">정상 → 되물음 → 데이터없음 → 환각·오류 순의 <b>상태 척도</b>다(계열 색이 아니다).</p>
  <div class="chart">
    <div class="legend"><span><i class="sw sw-ok"></i>정상</span><span><i class="sw sw-ask"></i>되물음</span>
      <span><i class="sw sw-none"></i>데이터없음</span><span><i class="sw sw-bad"></i>환각·오류</span></div>
    <div class="stack">{segs}</div>
  </div>
  <div class="scroll"><table><thead><tr><th>판정</th><th class="num">건수</th><th class="num">비율</th></tr></thead>
    <tbody>{rows}</tbody></table></div>
</section>''')

    # ── 두 커버리지 정의 교차검증 ────────────────────────────────
    parts.append(f'''<section>
  <h2>커버리지가 두 개인 이유 — 그 차이가 곧 백로그다</h2>
  <p class="sec-note"><b>라벨 기반</b>은 "질문에 답했나"(LLM 판정), <b>툴경로 기반</b>은
  "제품에 도달했나"(툴 호출 로그, LLM 판정 없음)를 잰다.</p>
  <div class="chart">
    <div class="row"><span class="rlab">커버리지<span class="rn">막대=라벨 · 세로선=툴경로</span></span>
      <span class="track"><span class="bar" style="width:{c["coverage_label"]["value"]}%"></span>
      <span class="ref2" style="left:{c["coverage_toolpath"]["value"]}%"></span></span>
      <span class="rval">{c["coverage_label"]["value"]}% / {c["coverage_toolpath"]["value"]}%</span></div>
  </div>
  <div class="scroll"><table>
    <thead><tr><th>{n}건</th><th class="num">데이터 조회함</th><th class="num">조회 안 함</th></tr></thead>
    <tbody>
      <tr><td><b>판정 '정상'</b></td><td class="num">{xt["label정상_and_조회함"]}</td>
          <td class="num">{xt["label정상_but_조회안함"]}</td></tr>
      <tr><td><b>'정상' 아님</b></td><td class="num">{xt["label비정상_but_조회함"]}</td>
          <td class="num">{xt["label비정상_and_조회안함"]}</td></tr>
    </tbody></table></div>
  <p class="sec-note">
    <b>정상 &amp; 미조회 {xt["label정상_but_조회안함"]}건</b> — 조회 없이 '정상'을 준 경우.
    0에 가까울수록 라벨이 툴 로그와 모순되지 않는다는 뜻이다.<br>
    <b>'정상' 아님 &amp; 조회함 {xt["label비정상_but_조회함"]}건</b> — 제품엔 닿았는데 질문은
    해결 못 한 구간. 제품 부재가 아니라 <b>세분화 부족</b>이라 백로그는 "축 추가"를 가리킨다.<br>
    <b>'정상' 아님 &amp; 미조회 {xt["label비정상_and_조회안함"]}건</b> — 제품이 없어 조회조차 못 한 공백.
  </p>
</section>''')

    # ── 측정 격리 ──────────────────────────────────────────────
    ext = iso["questions_with_external_tool"]
    parts.append(f'''<section>
  <h2>측정 격리</h2>
  <p class="sec-note">실측 세션이 MCP 밖 로컬 툴(Bash·Grep 등)을 썼다면 "MCP 데이터로 답했다"는
  전제가 흔들린다. 낮을수록 깨끗한 측정이다.</p>
  <div class="kpis">
    {kpi("로컬 툴 개입 문항", f'{ext["value"]}%', ci(ext))}
    {kpi("MCP 미호출 문항", f'{iso["questions_with_no_mcp_call"]["value"]}%',
         ci(iso["questions_with_no_mcp_call"]))}
  </div>
  <p class="sec-note">개입한 툴: <code>{esc(iso["external_tool_counts"] or "없음")}</code></p>
</section>''')

    # ── 신뢰도 (있을 때만) ──────────────────────────────────────
    if R:
        cards = "".join(
            kpi(r["comparison"], f'{r["agreement"]["value"]}%',
                f'{ci(r["agreement"])} · κ={r["cohen_kappa"]}')
            for r in R["results"])
        dis = "".join(
            f'<tr><td>{esc(r["comparison"])}</td><td>{esc(d["base"])} → {esc(d["other"])}</td>'
            f'<td class="num">{d["n"]}</td></tr>'
            for r in R["results"] for d in r["disagreements"][:4])
        parts.append(f'''<section>
  <h2>판정 신뢰도 — "LLM 판정을 믿을 수 있나"</h2>
  <p class="sec-note">라벨별 비례 층화 표본으로 잰다. <b>Cohen's κ</b>는 우연 일치를 걷어낸 값이다 —
  라벨이 '정상'에 쏠려 있으면 단순 일치율은 아무 판정자나 높게 나온다.</p>
  <div class="kpis">{cards}</div>
  <div class="scroll"><table><thead><tr><th>비교</th><th>불일치 방향</th><th class="num">건수</th></tr></thead>
    <tbody>{dis or '<tr><td colspan="3">불일치 없음</td></tr>'}</tbody></table></div>
</section>''')

    # ── 연령대별 ───────────────────────────────────────────────
    brows = "".join(
        f'<div class="brow"><span class="blab">{esc(g)}</span>'
        f'<span class="btrack"><span class="bbar" style="width:{s["coverage_label"]["value"]}%"></span></span>'
        f'<span class="bval">{s["coverage_label"]["value"]}% '
        f'({s["coverage_label"]["numerator"]}/{s["coverage_label"]["denominator"]})</span></div>'
        for g, s in M["by_band"].items())
    parts.append(f'''<section>
  <h2>연령대별 커버리지</h2>
  <p class="sec-note">연령대별 표본이 작아 신뢰구간이 넓다 — 방향성만 읽을 것.</p>
  <div class="chart">{brows}</div>
</section>''')

    # ── 데이터 간극 ────────────────────────────────────────────
    gaps = "".join(f'<tr><td>{esc(g["gap"])}</td><td class="num">{g["count"]}</td></tr>'
                   for g in S.get("gaps", [])[:20])
    parts.append(f'''<section>
  <h2>데이터 간극 (백로그 후보)</h2>
  <p class="sec-note">판정자가 "답하지 못한 원인이 데이터 쪽"이라고 본 문항의 사유다.
  자유 텍스트라 같은 원인이 다른 문장으로 적히면 빈도가 과소계상된다.</p>
  <div class="scroll"><table><thead><tr><th>간극</th><th class="num">건수</th></tr></thead>
    <tbody>{gaps}</tbody></table></div>
</section>''')

    parts.append(f'''<footer>
  수치 정본 <code>metrics.json</code> · 집계 <code>summary.json</code> · 정의서 <code>persona-qa/METHOD.md</code><br>
  이 대시보드는 <code>scripts/09_build_dashboard.py {esc(round_dir)}</code> 로 언제든 재생성된다 (LLM 호출 없음).
</footer>''')

    return ('<!doctype html>\n<html lang="ko">\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{esc(round_dir)} 페르소나 품질 테스트 · ASK: SEOUL</title>\n'
            f'<style>{CSS}</style>\n<div class="wrap">\n' + "\n\n".join(parts) +
            '\n</div>\n</html>\n')


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("사용: python scripts/09_build_dashboard.py <회차폴더>")
    round_dir = sys.argv[1]
    html = build(round_dir)
    p = ROOT / "out" / round_dir / "dashboard.html"
    p.write_text(html, encoding="utf-8")
    print(f"→ {p} ({len(html.encode('utf-8')):,} bytes)")


if __name__ == "__main__":
    main()
