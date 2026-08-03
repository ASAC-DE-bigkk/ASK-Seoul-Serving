# 0002 — 로컬 전용, 공개 배포는 멘토 게이트

- 상태: **채택** (2026-07)
- 관련: 팀 결정 #476 ①, ASAC-DAG#521-(B)

## 맥락

`wrangler deploy` 한 번이면 공개 URL 이 생긴다. 팀 결정(#476 ①)은 **공개 URL 신설을
멘토 게이트**로 묶었다. 또 로컬 프로토타입에는 팀 D1 쓰기 권한이 없다.

## 결정

- 구동은 `wrangler dev` (로컬 Miniflare sqlite D1)뿐. **`wrangler deploy` 금지.**
- package.json 에 deploy 스크립트를 두지 않는다 — 실수로 누를 버튼 자체를 없앤다.
- 모든 시드·로더(`npm run seed`, `scripts/load_slo.py`)는 **로컬 상태만** 만진다.
  `config/local/wrangler.toml` 의 `database_id` 는 로컬 모드에서 사용되지 않는다.

## 대가

- 팀원과 화면 공유가 어렵다 → 로컬 시연·스크린샷으로 대체한다.
- "실제로 돌아가는 공개 서비스"라는 증명은 미룬다.

## 재검토 조건

멘토 게이트 통과. 그 순간 이 문서만 개정해서 끝나지 않는다 —
**[0004](0004-read-open-write-token.md)(인증 승격)와 [0007](0007-schema-single-file-reset.md)
(증분 마이그레이션 전환)이 같이 움직여야 한다.** 순서는 [direction.md](../direction.md) 참조.
