# K-Skill 데모 사용자 중심 재구성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일반 방문자가 서울 전체 대상 K-Skill의 결과와 시작 방법을 먼저 이해하고, 필요한 기술 검증 근거는 펼쳐 볼 수 있게 한다.

**Architecture:** 정적 데모 페이지의 문구·정보 계층만 바꾼다. `skill-demo.js`의 API 요청과 메모리 전용 Key 처리는 유지하고, HTML의 성공 결과를 사용자용 안내와 검증 상세로 분리한다.

**Tech Stack:** Static HTML, CSS custom properties, vanilla browser JavaScript, Node test runner.

## Global Constraints

- `/skill/v1` bundle → product → data 검증 순서와 readiness·row-count gate는 변경하지 않는다.
- Key를 저장소·URL·로그·클립보드에 쓰지 않는다.
- 이 작업에서는 사용자 승인 전 commit·push·PR을 만들지 않는다.
- 공통 light/dark 디자인 토큰만 사용한다.

---

### Task 1: 사용자 중심 정보 구조를 테스트로 고정

**Files:**
- Modify: `marketplace/scripts/skill-demo.test.mjs`

**Interfaces:**
- Consumes: `marketplace/public/skill-demo.html`
- Produces: 사용자용 제목·진행 단계·검증 상세의 정적 계약

- [x] **Step 1: 실패하는 정적 테스트를 작성한다.**

```js
assert.match(HTML, /서울, 언제 날씨를 조심해야 할까/);
assert.match(HTML, /<details class="verification-details">/);
assert.match(HTML, /데이터·검증 정보 보기/);
assert.doesNotMatch(HTML, /ASK 서울의 실제 publication을 읽어/);
```

- [x] **Step 2: 테스트가 현재 문구에서 실패하는지 확인한다.**

Run: `node --test scripts/skill-demo.test.mjs`

Expected: 새 제목과 details 요소가 없다는 assertion failure.

### Task 2: 일반 사용자용 카피와 progressive disclosure 구현

**Files:**
- Modify: `marketplace/public/skill-demo.html`
- Modify: `marketplace/public/skill-demo.js`

**Interfaces:**
- Consumes: `runSkillDemo()`의 `publicationId`, `rowCount`, `requestIds`, `sample`
- Produces: 성공 시 `#liveHandoff`와 `#verificationDetails`에 각각 사용자 행동과 검증 근거를 표시

- [x] **Step 1: 첫 화면을 결과 중심 카피로 교체한다.**

```html
<h1>서울, 언제 날씨를 조심해야 할까?</h1>
<p class="lede">서울 행정동 이름으로 물어보면, 더위·비·강풍에 주의할 시간대를 알려드려요.</p>
```

- [x] **Step 2: 세 단계의 제목과 버튼을 행동 중심으로 바꾼다.**

```html
<h2>AI에서 사용 준비하기</h2>
<h2>내 API 키 연결하기</h2>
<button id="verifySkill">연결 상태 확인</button>
```

- [x] **Step 3: 기술 검증 정보를 details로 접는다.**

```html
<details class="verification-details" id="verificationDetails" hidden>
  <summary>데이터·검증 정보 보기</summary>
</details>
```

- [x] **Step 4: 성공 처리에서 details만 표시하고 Key 처리·gate는 그대로 둔다.**

```js
verificationDetails.hidden = false;
result.hidden = false;
liveHandoff.hidden = false;
```

- [x] **Step 5: Task 1의 테스트와 `npm test`를 실행한다.**

Run: `node --test scripts/skill-demo.test.mjs && npm test`

Expected: 모든 정적·동작 테스트 통과.

### Task 3: Figma-ready handoff와 반응형 확인

**Files:**
- Create: `docs/superpowers/specs/2026-08-10-skill-demo-audience-first-design.md`

**Interfaces:**
- Consumes: 최종 HTML의 화면·상태·카피
- Produces: desktop/mobile frame 및 상태 전환 명세

- [x] **Step 1: Figma-ready 프레임과 상태를 문서화한다.**

Frame 01 기본 화면, Frame 02 설치, Frame 03 키·연결 상태, Frame 04 성공, Frame 05 검증 상세를 같은 문구로 기록한다.

- [x] **Step 2: CSS가 light/dark 공통 토큰만 쓰는지 확인한다.**

Run: `node --test scripts/skill-demo.test.mjs`

Expected: inline style에 private hex color가 없고 responsive contract가 유지된다.

- [x] **Step 3: local page에서 desktop와 mobile을 점검한다.**

Run: `npm run dev` 후 1280px와 390px viewport에서 `skill-demo.html`을 확인한다.

Expected: 가로 overflow가 없고, 긴 설치 명령·버튼·details가 모두 읽힌다.
