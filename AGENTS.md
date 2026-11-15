# 저장소 규칙 (AI·사람 공통)

이 저장소는 웹사이트 시작 템플릿이다. 새 사이트는 이 저장소를 복사해(GitHub "Use this template") 시작하고, `docs/START.md` 순서대로 바꾼다.

## 먼저 읽을 것

- `docs/START.md` — 새 사이트를 만들 때 바꿀 곳과 순서
- `docs/CONTRACT.md` — 화면 ↔ 서버 약속(경로·오류 코드·머리말). 한쪽을 바꾸면 이 문서와 양쪽 시험을 같이 바꾼다
- `docs/DESIGN_RULES.md` — 디자인 토큰과 굳은 규칙
- `docs/D1_RULES.md` — D1 제한(로컬 SQLite 시험으로는 안 잡힌다)

## 하지 말 것

- 인라인 `<script>`·`<style>`·`style="..."`·`on*=` 속성. CSP 가 `script-src 'self'; style-src 'self'` 다.
- 토큰에 없는 새 색. 순흑 `#000`. 명조 글꼴. 공개 화면의 색 상자·장식 막대·이모지.
- 비밀값을 저장소·`wrangler.jsonc`·로그에 넣기. 비밀값은 `wrangler secret put` 으로만.
- `.dev.vars`·`.wrangler/`·`public/version.json` 커밋. `git add -A`.
- 운영 D1 마이그레이션 적용·운영 배포를 사용자 승인 없이 하기.

## 할 것

- 오류 응답은 `{ "error": "SCREAMING_SNAKE_CODE" }`. 사람이 읽는 문구는 화면이 한·일·영 사전으로 만든다.
- 상태를 바꾸는 `/api/*` 요청은 Origin + `x-site-request: 1`(+ 로그인 상태면 `x-csrf-token`).
- 새 SQL 은 `npm run check:d1` 로 로컬 D1 엔진에서 실제 실행해 본다.
- 화면을 바꾸면 `docs/design/` 에 `DESIGN_DOC_TEMPLATE.md` 형식으로 기록하고, 넓은 화면·휴대폰 캡처로 확인한다.
- 시험: `npm test`(node --test), 화면은 `npm run test:browser`(Playwright + axe).
- 배포: `docs/DEPLOY.md` 순서(점검 → dry-run → 배포 → 배포 점검 → 운영 확인).
