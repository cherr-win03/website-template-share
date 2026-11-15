# 새 웹사이트 시작하기 (START)

이 템플릿으로 새 사이트를 만들 때의 순서다. 위에서부터 차례로 한다.

## 1. 저장소 만들기

```bash
gh repo create <계정>/<새-이름> --private --template <계정>/<이 템플릿 저장소> --clone
```

(또는 GitHub 에서 "Use this template".) 그다음 새 폴더에서:

```bash
npm ci
npm run setup
npm run dev
```

`http://127.0.0.1:8790` 이 열리면 준비 끝이다. 로그인까지 보려면 `npm run dev -- --fake-auth`(가짜 Supabase, 코드 `123456`).

## 2. 바꿀 곳

| 무엇 | 파일 | 메모 |
|---|---|---|
| 사이트 이름·메뉴·꼬리말·시간대 | `public/app/site.js` | 한·일·영을 같이 쓴다 |
| 화면 문구·오류 문구 | `public/app/messages.js` | 세 언어가 모두 있어야 시험이 통과한다 |
| 브랜드 색 | `public/design/tokens.css` 맨 위 "바꿀 곳" | 새 색은 토큰으로만. 바꾼 뒤 `npm test`(대비 계산) |
| `<title>`·설명 | `public/index.html`, `public/login/index.html`, `public/members/index.html`, `public/404.html` | 인라인 script·style 금지 |
| 파비콘 | `public/favicon.svg` | |
| 견본 포스터 | `public/samples/` | 실제 이미지로 바꾸거나 지운다(같은 출처 경로만) |
| 항목 자료 구조 | `migrations/0001_items.sql`, `worker/items.js`, `scripts/seed-local.mjs`, `public/app/views/` | 이름이 "항목"이 아니면 화면 문구도 바꾼다. 새 SQL 은 `npm run check:d1` |
| Worker 이름·주소·D1 | `wrangler.jsonc` | `name`, `account_id`, `vars.APP_ORIGIN`, `database_name`·`database_id`, 빈도 제한 `namespace_id` |
| 로그인 | `wrangler.jsonc` vars + `docs/AUTH.md` | 안 쓰면 `AUTH_ACTIVATION=disabled` 그대로(코드는 남아도 꺼짐) |
| 로그인 전 차단 경로 | `PROTECTED_PATHS` | 기본 `/members/,/api/members/` |

## 3. 안 쓰는 부분 지우기(선택)

- 회원 견본이 필요 없으면: `public/members/`, `public/app/members.js`, `worker/members.js` 와 `worker/app.js` 의 해당 경로, `site.js` 메뉴의 `members`, 관련 시험을 함께 지운다. 지운 뒤 `npm test`·`npm run test:browser`.
- 로그인을 아예 안 쓰면 꺼 두는 것으로 충분하다. 지우려면 `worker/auth/`, `migrations/0002_sessions.sql`, `public/login/`, `public/app/login.js`, 머리말의 로그인 단추와 관련 시험을 같이 지운다.

## 4. 화면을 바꿀 때

- `docs/DESIGN_RULES.md` 의 굳은 규칙(흰 바탕, 새 색 금지, 주 단추 하나, 44px, 대비 4.5:1, 색만으로 알리지 않음)을 지킨다.
- 바꾼 내용은 `docs/design/` 에 `docs/DESIGN_DOC_TEMPLATE.md` 형식으로 남긴다.
- 넓은 화면(1280)·휴대폰(390) × 한·일·영 캡처로 눈으로 확인하고 `npm run check:a11y`.

## 5. 배포

`docs/DEPLOY.md` 순서: 점검(`deploy:check`) → dry-run → 배포(`deploy:release -- --yes`) → 배포 점검(`deploy:verify`) → 운영 확인. 배포 직전에는 Claude 의 `web-launch-check` 스킬로 관문 점검을 한다. 운영 D1 마이그레이션 적용과 배포는 사용자 승인 뒤에만 한다.
