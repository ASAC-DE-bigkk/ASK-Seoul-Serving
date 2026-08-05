/* theme.js — 다크/라이트 토글 배선. 모든 페이지가 이 한 벌을 공유한다.
 *
 * 테마 "적용"은 여기 없다 — 각 페이지 <head> 의 인라인 조각이 페인트 전에 끝낸다.
 * 그 조각까지 이 파일로 합치려면 <head> 에서 동기 로드해야 하는데, 그러면 첫 방문에
 * 왕복이 하나 늘어 첫 페인트가 그만큼 밀린다. 인라인 6줄이 그 값보다 싸다.
 *
 * 저장 규칙: 저장값이 있으면 = 사용자가 직접 골랐다. 그때만 OS 변경을 무시한다.
 * (첫 방문의 OS 해석 결과는 저장하지 않는다 — 저장해 버리면 그 순간 고정된다.)
 */
(function () {
  function wire() {
    var root = document.documentElement;
    var btn = document.getElementById("themeBtn");
    if (!btn) return;

    function label() {
      btn.setAttribute("aria-label",
        root.dataset.theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환");
    }
    label();

    btn.addEventListener("click", function () {
      root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
      try {
        localStorage.setItem("theme", root.dataset.theme);
      } catch (e) { /* 프라이빗 모드 등 차단 — 이번 세션만 바뀌고 다음 방문엔 OS 를 따른다 */ }
      label();
    });

    matchMedia("(prefers-color-scheme: light)").addEventListener("change", function (e) {
      var stored;
      try { stored = localStorage.getItem("theme"); } catch (err) { /* 위와 같음 */ }
      if (stored === "light" || stored === "dark") return;
      root.dataset.theme = e.matches ? "light" : "dark";
      label();
    });
  }

  /* defer 로 불리면 이미 파싱이 끝나 있다. 그래도 호출 위치를 가리지 않게 둘 다 받는다 */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
