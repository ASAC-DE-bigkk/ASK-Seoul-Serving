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

  var tip = null, current = null, pinned = false, hideT = null;

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

  function show(target) {
    clearTimeout(hideT);
    var text = target.getAttribute("data-tip");
    if (!text) return;
    var t = el();
    t.innerHTML = text;
    current = target;
    if (!t.id) t.id = "uitip";
    target.setAttribute("aria-describedby", "uitip");
    place(target);
  }

  function hide(force) {
    if (pinned && !force) return;
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
      if (t && t !== current) { pinned = false; show(t); }
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
