/* ═══════════════════════════════════════════════════════════════════════════════
   ui.js — 툴팁 한 벌 (프로젝트 독립, 의존성 0)

   **다른 프로젝트에 그대로 붙일 수 있는** 툴팁 엔진이다. 하는 일은 하나:
   `data-tip="..."` 가 붙은 요소에, 마우스를 올리면(데스크톱) 뜨고 벗어나면 닫히는,
   그리고 누르면(모바일·터치) 토글되는 말풍선을 단다. 화면 밖으로 나가지 않게
   위치를 재보정한다.

   ── 왜 title 이 아니라 이걸 쓰나 ──────────────────────────────────────────────
   브라우저 기본 title 은 ① 모바일에서 안 뜨고 ② 지연이 있고 ③ 여러 줄·서식이
   안 되고 ④ 화면 끝에서 잘린다. 상태 배지가 "왜 이 상태인지"를 설명해야 하는
   화면에서 그 넷이 다 걸린다.

   ── 붙이는 법 ────────────────────────────────────────────────────────────────
   1. <script src="ui.js" defer></script>  (또는 모듈에서 UITip.init())
   2. 설명이 필요한 요소에 data-tip="여기에 <b>서식</b> 도 된다" 를 단다.
   3. 동적으로 그린 요소도 자동으로 잡힌다(이벤트 위임 — 다시 init 할 필요 없다).

   접근성: data-tip 요소에 tabindex=0 이 없으면 자동으로 넣어 키보드로도 열린다
   (Enter/Space 토글, Esc 닫기). 스크린리더용 aria-describedby 도 연결한다.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.UITip) return;

  var tip = null, current = null, pinned = false, hideT = null, showT = null;
  var HOVER_DELAY = 75;   // 호버로 열 때만 살짝 늦춘다 — 표를 스칠 때 배지마다 깜빡이지 않게

  function el() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "uitip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  // 대상 위쪽 가운데에 띄우되, 위가 좁으면 아래로 뒤집고, 좌우로 화면을 벗어나면 끌어당긴다.
  function place(target) {
    var t = el(), r = target.getBoundingClientRect(), m = 8, vw = innerWidth, vh = innerHeight;
    t.hidden = false;
    // 폭을 먼저 확정해야 위치 계산이 맞는다(max-width 는 css 가 건다)
    var tw = t.offsetWidth, th = t.offsetHeight;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(m, Math.min(left, vw - tw - m));      // 좌우 클램프
    var above = r.top - th - m;
    var top = above >= m ? above : r.bottom + m;          // 위가 좁으면 아래로
    top = Math.max(m, Math.min(top, vh - th - m));        // 상하 클램프
    t.style.left = left + "px";
    t.style.top = top + "px";
    requestAnimationFrame(function () { t.classList.add("on"); });
  }

  // 실제로 그려 띄우는 부분 — show() 가 즉시 또는 지연 뒤에 부른다.
  function render(target) {
    var text = target.getAttribute("data-tip");
    if (!text) return;
    var t = el();
    t.innerHTML = text;
    if (!t.id) t.id = "uitip";
    target.setAttribute("aria-describedby", "uitip");
    place(target);
  }

  function show(target, delay) {
    clearTimeout(hideT);
    clearTimeout(showT);
    if (!target.getAttribute("data-tip")) return;
    current = target;                       // 지연 중에도 '지금 대상'은 정해 둔다(호버 이탈 판정용)
    if (delay) showT = setTimeout(function () { if (current === target) render(target); }, delay);
    else render(target);
  }

  function hide(force) {
    if (pinned && !force) return;
    clearTimeout(showT);                    // 아직 안 뜬 예약분도 취소한다
    pinned = false;
    if (current) current.removeAttribute("aria-describedby");
    current = null;
    if (!tip) return;
    tip.classList.remove("on");
    // 트랜지션이 끝난 뒤 감춘다 — 즉시 hidden 이면 페이드아웃이 안 보인다
    hideT = setTimeout(function () { if (tip) tip.hidden = true; }, 140);
  }

  function closest(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute("data-tip")) return node;
      node = node.parentNode;
    }
    return null;
  }

  function init() {
    // 데스크톱: 올리면 열리고 벗어나면 닫힌다 (요청 그대로 — 호버 해제 시 자동 닫힘)
    document.addEventListener("mouseover", function (e) {
      var t = closest(e.target);
      if (t && t !== current) { pinned = false; show(t, HOVER_DELAY); }
    });
    document.addEventListener("mouseout", function (e) {
      var t = closest(e.target);
      // 자식으로 이동한 경우는 무시(같은 대상 안에서의 이동)
      if (t && t === current && !t.contains(e.relatedTarget)) hide(false);
    });
    // 모바일·터치: 누르면 토글. 같은 것을 다시 누르면 닫힌다.
    document.addEventListener("click", function (e) {
      var t = closest(e.target);
      if (t) {
        if (current === t && pinned) { hide(true); }
        else { show(t); pinned = true; }
        e.stopPropagation();
      } else if (pinned) hide(true);
    });
    // 키보드 — data-tip 요소는 초점을 받을 수 있어야 하고, Enter/Space 로 토글, Esc 로 닫힘
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") return hide(true);
      var t = closest(document.activeElement);
      if (!t) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (current === t && pinned) hide(true); else { show(t); pinned = true; }
      }
    });
    document.addEventListener("focusin", function (e) {
      var t = closest(e.target);
      if (t) { ensureFocusable(t); show(t); }
    });
    document.addEventListener("focusout", function (e) {
      var t = closest(e.target);
      if (t === current && !pinned) hide(false);
    });
    // 스크롤·리사이즈 중에는 위치가 어긋나므로 닫는다(다시 올리면 제 위치에 뜬다)
    addEventListener("scroll", function () { if (current && !pinned) hide(true); }, true);
    addEventListener("resize", function () { hide(true); });
    // 이미 있는 data-tip 요소를 초점 가능하게 — 동적 요소는 focusin 에서 처리
    document.querySelectorAll("[data-tip]").forEach(ensureFocusable);
  }

  function ensureFocusable(node) {
    if (!node.hasAttribute("tabindex") &&
        !/^(a|button|input|select|textarea)$/i.test(node.tagName))
      node.setAttribute("tabindex", "0");
  }

  window.UITip = { init: init, hide: function () { hide(true); } };
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   UIPage — 긴 표를 **스크롤로 이어 받는다** (프로젝트 독립, 의존성 0)

   하는 일은 하나: `<table data-page="…">` 를 담고 있는 **스크롤 상자가 바닥에 닿으면**
   그 표에 `ui:page` 이벤트를 쏜다. 다음 쪽을 무엇으로 채울지는 **앱이 정한다** —
   이 파일은 열도 행도 모른다.

   ── 왜 필요한가 ──────────────────────────────────────────────────────────────
   행이 수십·수백이면 ① 한 번에 다 그리느라 렌더가 무겁고 ② 카드가 세로로 끝없이
   늘어나 **다른 카드가 화면 밖으로 밀린다.** 화면은 "지금 무엇이 문제인가"를 한눈에
   보여주는 것이 일인데, 표 하나가 그 한눈을 잡아먹는다.

   ── 붙이는 법 ────────────────────────────────────────────────────────────────
   1. 표를 첫 쪽만 그리고 `<table data-page="어떤키">` 를 단다.
   2. `document.addEventListener("ui:page", e => …)` 에서 `e.target.dataset.page` 로
      다음 쪽을 `<tbody>` 에 덧붙인다. 다 붙였으면 표에 `data-page-done="1"` 을 단다.
   3. 끝. 스크롤 감지·상자 만들기·다시 그린 뒤 재연결은 여기가 알아서 한다.

   ── 🔴 이 엔진이 반드시 다뤄야 하는 함정 셋 ──────────────────────────────────
   ① **스크롤이 안 생기면 더 부를 길이 없다.** 상자 높이가 첫 쪽보다 크면 스크롤바가
      없고, 그러면 사용자는 나머지 행에 **영원히 닿지 못한다**(조용히 잘린 표가 된다).
      그래서 넘칠 때까지 먼저 채운다.
   ② **스크롤 이벤트는 버블링하지 않는다.** 위임하려면 **캡처 단계**로 받아야 한다.
   ③ **표는 다시 그려진다**(innerHTML 교체). 노드에 리스너를 달면 그때마다 끊긴다 —
      그래서 문서 한 곳에서 위임하고, 새 표는 MutationObserver 로 알아챈다.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.UIPage) return;

  var NEAR = 80;    // 바닥에서 이만큼(px) 남으면 다음 쪽을 부른다 — 닿고 나서 부르면 끊겨 보인다
  var FILL = 40;    // 한 번의 sync 에서 채울 최대 쪽수. 무한 루프 방지용 빗장이다

  /** 이 표를 담는 스크롤 상자. 없으면 부모를 상자로 승격한다. */
  function host(tbl) {
    var c = tbl.closest(".scroll");
    if (c) return c;
    var p = tbl.parentElement;
    if (!p) return null;
    // 승격 표시를 남긴다 — 나중에 "이 상자는 왜 스크롤이지"에 답할 수 있어야 한다.
    p.classList.add("scroll", "pagehost");
    return p;
  }

  function ask(tbl) {
    tbl.dispatchEvent(new CustomEvent("ui:page", { bubbles: true }));
  }

  function rowCount(tbl) {
    return tbl.tBodies && tbl.tBodies[0] ? tbl.tBodies[0].rows.length : 0;
  }

  /** 🔴 함정 ① — 아직 안 넘치는 상자는 넘칠 때까지 채운다. */
  function fill(tbl) {
    var c = host(tbl);
    if (!c) return;
    for (var n = 0; n < FILL; n++) {
      if (tbl.dataset.pageDone === "1") return;
      if (c.scrollHeight - c.clientHeight > 4) return;      // 이제 스크롤이 생겼다
      var before = rowCount(tbl);
      ask(tbl);
      // 앱이 표를 통째로 다시 그렸을 수 있다 — 떨어진 노드로 더 돌면 무한 루프다.
      if (!tbl.isConnected || rowCount(tbl) === before) return;
    }
  }

  function sync(root) {
    var list = (root || document).querySelectorAll("table[data-page]");
    for (var i = 0; i < list.length; i++) fill(list[i]);
  }

  // 🔴 함정 ② — scroll 은 버블링하지 않는다. 캡처로 받아야 위임이 된다.
  function onScroll(e) {
    var c = e.target;
    if (!c || c.nodeType !== 1 || !c.classList || !c.classList.contains("scroll")) return;
    if (c.scrollTop + c.clientHeight < c.scrollHeight - NEAR) return;
    // 🔴 한 상자에 페이징 표가 **둘 이상** 있을 수 있다(펼친 상세 안에 또 표가 들어가는 경우).
    //    첫 번째만 부르면 나머지는 **영원히 안 늘어난다** — 잘린 채로 조용히 멈춘다.
    //    바닥에 닿았다는 것은 "이 상자에서 더 볼 것을 달라"는 뜻이므로 안 끝난 표를 다 부른다.
    var list = c.querySelectorAll("table[data-page]");
    for (var i = 0; i < list.length; i++)
      if (list[i].dataset.pageDone !== "1") ask(list[i]);
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; sync(); });
  }

  function init() {
    if (init.done) return;
    init.done = true;
    document.addEventListener("scroll", onScroll, true);
    // 🔴 함정 ③ — 다시 그린 표를 알아채는 곳. 호출부마다 "다 그렸으니 붙여 줘"를
    //    적게 하면 **한 곳만 빠뜨려도 그 표가 조용히 잘린다.**
    if (window.MutationObserver)
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    // 화면이 넓어지면 상자가 더 보이므로 다시 채워야 할 수 있다.
    window.addEventListener("resize", schedule);
    schedule();
  }

  window.UIPage = { init: init, sync: sync, NEAR: NEAR };
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
