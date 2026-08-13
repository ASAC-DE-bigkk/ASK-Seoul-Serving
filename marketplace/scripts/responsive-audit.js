/**
 * 반응형 감사 — 브라우저 콘솔(또는 DevTools Snippets)에 **통째로 붙여** 실행한다.
 *
 *     페이지를 열고 → 개발자도구 Console → 이 파일 내용 붙여넣기 → Enter
 *     폭을 바꾸려면 반응형 모드(Ctrl+Shift+M)에서 320 / 375 / 768 / 1280 을 각각 본다.
 *
 * Node 로는 못 돈다 — 레이아웃을 실제로 계산해야 나오는 값들이라 브라우저가 필요하다.
 * (헤드리스 브라우저를 붙이는 건 이 레포에 아직 없는 인프라라 §6 영역이다.)
 *
 * ── 왜 이게 있나 ──────────────────────────────────────────────────────────────
 * "가로 밀림 0" 하나만 보다가 실제 결함을 세 번 놓쳤다(2026-08-07 실측, catalog):
 *
 *   ① 검색창이 46px 로 찌그러짐        → 페이지는 안 밀린다. 그래서 안 걸렸다
 *   ② 카드 내용이 테두리를 28px 넘음   → 페이지는 안 밀린다. 그래서 안 걸렸다
 *   ③ 사이드바가 안 숨겨져 본문이 한 화면 아래에서 시작 → 375px 만 봐서 못 봤다
 *
 * 셋 다 원인이 같은 함정인 경우가 많다 — **flex/grid 항목의 `min-width:auto`**
 * (`.wrap`·`.auth`·`.side` 가 전부 이것이었다). 안 줄어드는 항목이 보이면 그 조상에
 * `min-width:0` 또는 `minmax(0,1fr)` 을 먼저 의심한다.
 *
 * ④ 는 종류가 다르다(2026-08-13 추가). **폭이 아니라 입력 방식이 만드는 결함**이라
 * 위 셋을 아무리 봐도 안 나왔다: iOS Safari 는 글자 16px 미만인 입력칸에 포커스가 가면
 * 페이지를 확대하고 **그대로 둔다**. 그 상태에서는 레이아웃이 화면보다 넓어 가로로 밀리는데,
 * 정작 이 감사에서는 "밀림 없음"으로 나온다 — 확대는 렌더 뒤에 일어나기 때문이다.
 * 실측(2026-08-13): 카탈로그 7칸·랜딩 1칸·QA Lab 13칸·스킬데모 1칸 = **전 화면의 입력 22칸
 * 전부**가 12~15px 이었다. 처방은 폰 폭에서 16px 로 올리는 것 하나다 —
 * `user-scalable=no` 는 확대 자체를 막아 접근성 위반이고, 그건 고침이 아니라 은폐다.
 */
(() => {
  const vw = document.documentElement.clientWidth;
  const cls = (el) => (typeof el.className === "string" ? el.className : "").trim().slice(0, 28);
  const name = (el) =>
    el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls(el) ? `.${cls(el).split(/\s+/).join(".")}` : "");
  const scrollable = (el) => ["auto", "scroll", "hidden"].includes(getComputedStyle(el).overflowX);

  // ① 페이지가 통째로 가로로 밀리나 (기존 유일 지표)
  const 가로밀림 = document.documentElement.scrollWidth > vw + 1;

  // ② 입력 요소가 못 쓸 만큼 찌그러졌나. 80px = 한글 3~4자 — 그 아래면 플레이스홀더가 안 읽힌다.
  //    라디오·체크박스는 원래 작다(제외).
  const 찌그러짐 = [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => !["radio", "checkbox", "hidden"].includes(el.type))
    .map((el) => ({ el, w: Math.round(el.getBoundingClientRect().width) }))
    .filter(({ el, w }) => w > 0 && w < 80 && el.getBoundingClientRect().height > 0)
    .map(({ el, w }) => ({ 요소: name(el), 폭: w, 안내문: (el.placeholder || "").slice(0, 24) }));

  // ③ 자기 부모 박스 밖으로 새나. 부모가 스크롤 컨테이너면 정상이다 — `.table-scroll` 안의
  //    넓은 표는 결함이 아니라 규격(12열 1,279px 표가 279px 안에서 스크롤되는 게 정답).
  const 박스넘침 = [];
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const p = el.parentElement;
    if (!p || scrollable(p)) return;
    const over = Math.round(r.right - p.getBoundingClientRect().right);
    if (over > 2) 박스넘침.push({ 요소: name(el), 부모: name(p), 넘침: over });
  });

  // ④ 폰에서 포커스 시 화면이 확대되나. 16px 미만이면 iOS Safari 가 확대한다(위 주석 참조).
  //    데스크톱 폭에서는 해당 없으므로 폰 구간에서만 센다 — 그래서 `matchMedia` 로 스스로 건너뛴다.
  const 폰 = matchMedia("(max-width:760px), (pointer:coarse)").matches;
  const 확대유발 = !폰 ? [] : [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => !["radio", "checkbox", "hidden"].includes(el.type))
    .map((el) => ({ el, fs: parseFloat(getComputedStyle(el).fontSize) }))
    .filter(({ fs }) => fs < 16)
    .map(({ el, fs }) => ({ 요소: name(el), 글자: `${fs}px` }));

  const 결함수 = (가로밀림 ? 1 : 0) + 찌그러짐.length + 박스넘침.length + 확대유발.length;
  const 결과 = {
    뷰포트: vw,
    판정: 결함수 === 0 ? "✅ 통과" : `❌ ${결함수}건`,
    "① 가로밀림": 가로밀림 ? `문서폭 ${document.documentElement.scrollWidth}px` : "없음",
    "② 찌그러진 입력": 찌그러짐.length ? 찌그러짐 : "없음",
    "③ 부모 박스 넘침": 박스넘침.length ? 박스넘침.slice(0, 10) : "없음",
    "④ 포커스 확대 유발": 폰 ? (확대유발.length ? 확대유발 : "없음") : "해당 없음(데스크톱 폭)",
  };
  console.table([{ 뷰포트: vw, 판정: 결과.판정, 밀림: 가로밀림 ? "❌" : "✅",
                   찌그러짐: 찌그러짐.length || "✅", 넘침: 박스넘침.length || "✅",
                   확대: 폰 ? (확대유발.length || "✅") : "—" }]);
  return 결과;
})();
