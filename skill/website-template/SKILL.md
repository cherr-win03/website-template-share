---
name: website-template
description: 새 웹사이트·웹앱을 처음부터 만들지 않고 이 템플릿 저장소(Cloudflare Workers + 포스터 카드 목록·상세 화면 + 인라인 금지 CSP + 한·일·영 + D1 + 선택형 Supabase 로그인 + 배포 보호·시험)로 시작하는 절차. "새 웹사이트 만들어줘", "행사 페이지 만들어줘", "랜딩 페이지", "사이트 새로 시작", "템플릿으로 시작"이라고 하거나, 다른 사이트에 이 디자인 층만 가져다 쓸 때 쓴다. 이미 운영 중인 다른 사이트의 기능 수정에는 쓰지 않는다.
---

# website-template — 새 웹사이트는 템플릿으로 시작

새 사이트를 처음부터 짜지 않는다. 템플릿 저장소를 복사해 바꿀 곳만 바꾼다. 근거·규칙은 저장소 안 문서(`AGENTS.md`, `docs/`)가 원본이고, 이 스킬은 순서와 판단만 맡는다.

설치: 이 폴더(`skill/website-template`)를 `~/.claude/skills/website-template/` 에 복사한다. 아래 `<템플릿 저장소>` 는 이 저장소를 내 계정에 복사(또는 fork)한 주소로 바꾼다.

## 0. 먼저 정할 것 (사용자에게 묻기 전에 요청에서 찾는다)

1. 저장소 위치: `<계정>/<이름>`.
2. 로그인이 필요한가: 필요 없으면 `AUTH_ACTIVATION=disabled` 그대로. 필요하면 `docs/AUTH.md` 순서(Supabase 프로젝트·제공자·redirect URL·secret). Supabase 계정·요금은 사용자 결정.
3. 자료 모양: 견본은 "항목"(제목·요약·장소·일정·마감·테마색·포스터·본문) 목록·상세다. 맞으면 이름과 문구만 바꾸고, 다르면 `migrations/`·`worker/items.js`·`public/app/views/`를 함께 바꾼다.

## 1. 만들기

```bash
gh repo create <계정>/<이름> --private --template <템플릿 저장소> --clone
```

그다음 `npm ci` → `npm run setup` → `npm run dev`(http://127.0.0.1:8790, 겹치면 `-- --port <번호>`).

## 2. 바꾸기

`docs/START.md` 2절 표를 위에서부터 따른다. 자주 놓치는 것:

- `public/app/site.js`(이름·메뉴·꼬리말)와 `public/app/messages.js`(문구)는 한·일·영을 같이 바꾼다. 빠지면 `npm test` 가 실패한다.
- 브랜드 색은 `public/design/tokens.css` 맨 위 "바꿀 곳"만(기본은 중립 파랑). 화면 CSS 에 새 색을 직접 쓰지 않는다. 바꾼 뒤 `npm test`(대비 계산).
- `wrangler.jsonc` 자리표시 값(`my-site`, `https://example.com`, 0 으로 된 database_id, account_id 없음)은 `deploy:check` 가 FAIL 로 막는다.
- 새 SQL 은 `npm run check:d1`(D1 은 compound SELECT 5항 등 로컬 SQLite 가 못 잡는 한도가 있다).

## 3. 지킬 디자인·보안 규칙

- 흰 바탕, 절제. 이모지·색 상자·장식 막대 없음, 새 색 금지, 순흑 금지, 주 단추 한 화면에 하나, 누름 영역 44px, 대비 4.5:1, 색만으로 알리지 않음.
- CSP 가 `script-src 'self'; style-src 'self'` 다. 인라인 `<script>`·`<style>`·`style=`·`on*=` 금지, 동적 값은 `data-*` + CSS 또는 `style.setProperty`.
- 오류 응답은 `{ "error": "SCREAMING_SNAKE" }`, 문구는 화면 사전이 만든다.

## 4. 확인 (완료 선언 전에 반드시)

1. `npm test`, `npm run test:browser`, `npm run check:a11y`.
2. 화면 캡처를 직접 본다: 넓은 화면 1280 · 휴대폰 390 × 한·일·영, 목록·상세·로그인·404. 캡처·시험 출력은 저장소 밖에 둔다.
3. 커밋은 파일을 지정해서(`git add -A` 금지), `.dev.vars`·키 제외.

## 5. 배포 (사용자 승인 뒤에만)

`docs/DEPLOY.md`: `deploy:check` → dry-run → `deploy:release -- --yes` → `deploy:verify -- --url <주소>` → 브라우저로 운영 확인. 운영 D1 마이그레이션·Cloudflare 계정·도메인·secret 등록은 사용자 승인 사항이다. wrangler 로그인 계정이 여러 개면 `DEPLOY_LOGIN_DIR`(또는 `deploy.config.json` 의 `loginDir`)로 나누고, `deploy:release` 의 account_id 대조를 끄지 않는다.

## 6. 디자인 층만 가져다 쓸 때 (예: React 사이트)

`public/design/`(tokens·base·components·layouts + fonts/pretendard)를 복사하고 클래스(`ui-*`)로 마크업한다. React 는 `style={...}` 대신 `data-accent` 같은 속성과 CSS 로 처리한다. 순수 함수(`public/app/i18n.js`의 `tr`·`initialLocale`, `views/describe.js`)만 가져간다.
