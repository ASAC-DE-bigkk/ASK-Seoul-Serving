# qa-lab — 질의 테스트 콘솔 (실험 · 분리형 부가물)

이슈 [#192](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/issues/192)(run_pattern 표현력 확장) 검증을 위한
**독립 실험 콘솔**이다. MCP 6종·REST 게이트웨이를 그대로 요청·검증한다.

## 이 폴더의 성격 — 근간 무수정 · 삭제로 소거

- **게이트웨이 근간 코드(`src/`·`partials/`·`wrangler.toml`·`package.json`)를 한 줄도 고치지 않는다.**
  이 콘솔은 그 API 를 밖에서 쓰는 **소비자**일 뿐이다.
- 자산이 이 폴더 안에서 자기완결이다(`index.html`·`lab.css`·`lab.js`). `site.css`·partials 를
  `<link>` 로 끌어오지 않는다 — 결합을 만들지 않기 위해서다.
- **기능을 없애려면 이 폴더(`marketplace/public/qa-lab/`)를 통째로 삭제**하면 된다. 다른 파일에
  참조가 없어 흔적이 남지 않는다(nav·sync-partials 의 `PAGES` 목록에도 넣지 않았다 → `npm test` 무영향).

## 서빙 경로

`[assets] run_worker_first = ["/api/v1/*","/skill/v1/*","/mcp"]` 이라 `/qa-lab/*` 는 정적으로 서빙된다.

- 로컬: `npm run dev` 후 **http://localhost:8787/qa-lab/**
- 배포: **https://ask-seoul.kr/qa-lab/** (배포 경로는 팀 CD 를 따른다 — 이 폴더 추가만으로 자동 노출)

## 🔴 MCP 는 동일 출처에서만 (CORS)

`/api/v1/*` 응답에는 `Access-Control-Allow-Origin: *` 가 있어 교차 출처도 되지만,
`/mcp` 응답에는 **CORS 헤더가 없다**(게이트웨이 근간이라 이 실험에서 고치지 않았다).
따라서 MCP 를 브라우저로 호출하려면 **게이트웨이와 같은 출처에서** 이 페이지를 열어야 한다
(base 를 비우면 현재 출처를 쓴다). 이 제약은 화면에도 안내로 뜬다.

## 요청 식별자 — `max20_fable`

우리 컴퓨터가 남긴 요청임을 로그에서 알아보게, 모든 요청에 식별자를 싣는다(기본 `max20_fable`,
연결 설정에서 변경 가능):

- MCP: `initialize` 의 `clientInfo.name`(→ `agent_name`) + 툴 인자 `intent`
- REST: `X-ASK-Intent` 헤더(→ `intent` 컬럼)

콘솔(ops-dashboard)의 '이용 행동' 탭에서 `agent_name=max20_fable` / `intent=max20_fable` 로 걸러 볼 수 있다.
