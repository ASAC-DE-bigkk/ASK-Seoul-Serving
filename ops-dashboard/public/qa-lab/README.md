# qa-lab — 기존형 ↔ 신설형 비교 (실험 · 분리형 부가물)

이슈 [#192](https://github.com/ASAC-DE-bigkk/ASK-Seoul-Serving/issues/192) 검증의 **평가 화면**이다.
기존형(`query_product`)과 신설형(`run_pattern`)의 **요청·답변 범위 · AI 질의 접근성 · 정보 제공
정확성**을 지표로 나란히 비교한다.

## 이 폴더의 성격 — 근간 무수정 · 삭제로 소거

- **콘솔 근간(`src/`·`public/index.html`·`public/ui.css`·`public/ui.js`·`wrangler.toml`)을 한 줄도 고치지 않는다.**
  이 화면은 콘솔의 탭 시스템(`index.html`)에 끼어들지 않는 **독립 페이지**다.
- 자산이 이 폴더 안에서 자기완결이다(`index.html`·`lab.css`·`lab.js`). `ui.css`·`ui.js` 를 끌어오지 않는다.
- **없애려면 이 폴더(`ops-dashboard/public/qa-lab/`)를 통째로 삭제**하면 된다. `check:hidden` 등
  기존 검사는 `index.html` 의 정적 id 만 보므로 이 폴더에 영향받지 않는다.

## 서빙 경로

`[assets] run_worker_first = ["/api/*"]` 이라 `/qa-lab/*` 는 정적으로 서빙된다.

- 로컬: `npm run dev` 후 **http://localhost:8788/qa-lab/**
- 배포: **https://ops.ask-seoul.kr/qa-lab/**

## 비교 근거 — 어떻게 지표를 뽑나

게이트웨이 `/api/v1/catalog`(무인증·교차 출처 허용)의 `usage_patterns` 메타를 읽는다. 각 패턴은
답하는 데 필요한 SQL 능력을 `requires` 로 선언한다(`sort`·`aggregate`·`group_by`·`subquery`·…).
기존형 `query_product` 는 **등가 필터 + 시간축 범위**만 지원하므로, 그 밖의 능력을 요구하는
패턴은 신설형 없이는 답이 안 된다. 이 사실을 **패턴별·능력별 비율**로 집계해 보여준다.

- **라이브 기존형 조회**(`/api/v1/data`, 교차 출처 CORS 허용): 키가 있으면 실제로 호출해 "원시 행"을 받아 온다.
- **신설형 라이브 실행**(`/mcp`): 응답에 CORS 헤더가 없어 교차 출처로는 브라우저가 막힌다. 그래서
  마켓플레이스 랩(`ask-seoul.kr/qa-lab/`, 동일 출처)에서 실행한 결과 JSON 을 붙여넣어 반영한다.

## 식별자 `max20_fable`

모든 게이트웨이 호출에 `X-ASK-Intent: max20_fable` 를 실어, 우리 컴퓨터가 남긴 요청임을 로그에서
알아볼 수 있게 한다.
