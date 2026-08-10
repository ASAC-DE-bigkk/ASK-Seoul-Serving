# OG 이미지 (`public/og.png`) — 무엇이고, 어떻게 다시 만드나

링크를 공유하는 순간(카카오톡·슬랙·트위터·노션)에 뜨는 카드다. 1200×630 PNG 하나를
전 페이지가 같이 쓴다 — **페이지마다 다른 카드를 만들지 않는다.** 사본이 늘면 반드시
어긋난다(`product-display.json` 이 세 번 겪은 그 문제의 화면판).

## 디자인은 히어로의 시각 언어를 그대로 쓴다

| 요소 | 값 | 근거 |
|---|---|---|
| 바탕 | `#f7f8f8` | 사이트 라이트 `--bg` |
| 워드마크 | `ASK:SEOUL`, 콜론만 `#0b6e60` | 브랜드 규칙(#248) — 자간 -0.03em 은 캔버스에 없어 수동 전진 |
| 헤드라인 | "흩어진 서울 공공데이터를 / 질문 하나로" | **히어로 h1 과 같은 문장·같은 위계**(둘째 줄 muted 400). 히어로 문구가 바뀌면 이 카드도 다시 만든다 |
| 도메인 점 6개 | `--dom-*` 라이트 6값 | 도메인 색 체계(#258)의 대외 노출 |
| 격자 모티프 | 우상단, 시드 426 고정 난수 | 히어로 캔버스와 같은 언어. 시드 고정이라 재생성해도 같은 그림 |

## 왜 캔버스로 그리나

이 저장소엔 이미지 도구가 없고(#0002 — 빌드 단계 없음), 디자인 원천이 전부 코드
(팔레트 토큰·워드마크 규칙)라 **그리는 코드가 곧 정본**이다. 포토샵 원본 파일을
잃어버리는 종류의 문제가 없다.

## 재생성 절차

1. 아래 스크립트를 임시 파일로 저장하고 실행한다(1회성 로컬 서버):

   ```bash
   node og-maker.mjs "<repo>/marketplace/public/og.png"
   ```

2. 브라우저로 `http://127.0.0.1:9910/` 을 연다 — 페이지가 캔버스에 그려 같은 오리진
   `/save` 로 POST 하고, 서버가 파일을 쓰고 스스로 종료한다.

   ⚠️ **마켓플레이스 페이지(:8787) 안에서 그리고 밖으로 POST 하는 방식은 안 된다** —
   사이트 CSP 의 connect-src 가 다른 포트를 막는다(실측, 2026-08-10). 전용 서버가
   페이지까지 서빙하는 이유가 그것이다.

3. 확인: `1200×630` · 100KB 이하 · 워드마크 콜론이 초록인지.

⚠️ 서체: 스크립트는 `Pretendard` 를 로컬 설치에서 찾는다. 없는 머신에서는 맑은 고딕으로
떨어져 **모양이 달라진다** — 재생성 전에 `document.fonts.check("16px Pretendard")` 로
확인하거나 [Pretendard 릴리스](https://github.com/orioncactus/pretendard)를 설치한다.

스크립트 전문은 이 문서와 같은 커밋의 PR(#og-image) 본문 및 아래에 있다.

<details><summary>og-maker.mjs</summary>

```js
// OG 카드 생성기 — GET / 이 그리기 페이지, 페이지가 같은 오리진 /save 로 POST(CSP 없음)
import http from "node:http";
import { writeFileSync } from "node:fs";
const OUT = process.argv[2];
const PAGE = `<!doctype html><meta charset="utf-8"><body>
<script>
(async () => {
  const cv = document.createElement("canvas");
  cv.width = 1200; cv.height = 630;
  const x = cv.getContext("2d");
  x.fillStyle = "#f7f8f8"; x.fillRect(0, 0, 1200, 630);
  // 426격자 모티프 — 우상단, 장식(히어로 캔버스와 같은 언어)
  let s = 426; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let r = 0; r < 12; r++) for (let c = 0; c < 22; c++) {
    const px = 590 + c * 28, py = 40 + r * 28;
    const dist = Math.hypot(1200 - px, py) / 700;
    const a = Math.max(0, 0.16 - dist * 0.14) * (0.5 + rnd());
    if (a <= 0.005) continue;
    x.fillStyle = "rgba(11,110,96," + a.toFixed(3) + ")";
    x.fillRect(px, py, 9, 9);
  }
  // 워드마크 — 콜론만 accent, 자간 -0.03em 수동 전진
  x.textBaseline = "alphabetic";
  x.font = "800 46px Pretendard";
  const ls = -0.03 * 46; let wx = 84;
  const word = (t, color) => { x.fillStyle = color;
    for (const ch of t) { x.fillText(ch, wx, 124); wx += x.measureText(ch).width + ls; } };
  word("ASK", "#0f1b1a"); wx += 3; word(":", "#0b6e60"); wx += 3; word("SEOUL", "#0f1b1a");
  // 헤드라인 — 히어로 h1 그대로(둘째 줄 muted 400)
  x.font = "700 76px Pretendard"; x.fillStyle = "#0f1b1a";
  x.fillText("흩어진 서울 공공데이터를", 80, 320);
  x.font = "400 76px Pretendard"; x.fillStyle = "#55655f";
  x.fillText("질문 하나로", 80, 418);
  // 도메인 6색 점 + 이름
  const doms = [["문화","#8a5878"],["인구","#9a7222"],["교통","#3e6ca6"],
                ["상권","#b05c40"],["날씨","#2f7f9e"],["도로","#6e5ca6"]];
  x.font = "600 27px Pretendard"; let dx = 84;
  for (const [name, color] of doms) {
    x.fillStyle = color; x.beginPath(); x.arc(dx + 6, 552, 6, 0, 7); x.fill();
    x.fillStyle = "#55655f"; x.fillText(name, dx + 21, 562);
    dx += 21 + x.measureText(name).width + 34;
  }
  x.fillStyle = "#0b6e60";
  const url = "ask-seoul.kr";
  x.fillText(url, 1200 - 84 - x.measureText(url).width, 562);
  const b64 = cv.toDataURL("image/png").split(",")[1];
  const res = await fetch("/save", { method: "POST", body: b64 });
  document.title = "SAVED " + await res.text();
})();
<\/script></body>`;
http.createServer((req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    writeFileSync(OUT, Buffer.from(body, "base64"));
    res.end(String(body.length));
    setTimeout(() => process.exit(0), 300);
  });
}).listen(9910, "127.0.0.1", () => console.log("listening 9910"));
setTimeout(() => process.exit(1), 90000);
```

</details>
