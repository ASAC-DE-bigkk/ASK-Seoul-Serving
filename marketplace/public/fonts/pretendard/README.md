# Pretendard Variable v1.3.9 — 셀프호스트 사본

출처: npm `pretendard@1.3.9` → `dist/web/variable/` (SIL OFL 1.1, css 머리에 전문).
CSP 가 외부 폰트를 막으므로(`default-src 'self'`, font-src 미선언) **셀프호스트가 유일한 경로**다.

- `pretendardvariable-dynamic-subset.css` — unicode-range 로 92조각을 선언, 화면에 있는
  글자 범위만 내려받는다(전체 3.1MB 중 통상 100~300KB).
- 갱신: `npm i pretendard@<버전> --no-save` 후 이 두 경로를 다시 복사하고 이 파일의 버전을 고친다.
