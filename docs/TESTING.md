# 시험 (TESTING)

## 한눈에

| 무엇 | 명령 | 언제 |
|---|---|---|
| 단위·서버·도구 시험 | `npm test` (`node --test --test-concurrency=4 tests/*.test.mjs`) | 매 변경, 배포 전 |
| 화면 시험(Playwright + axe) | `npm run test:browser` | 화면·서버·API 약속을 바꿨을 때, 배포 전 |
| 접근성 점검(ko·ja·en × 넓은 화면·휴대폰) | `npm run dev` 를 띄운 채 `npm run check:a11y` | 화면 변경 뒤 |
| D1 문장 실행 | `npm run check:d1` | 새 SQL |
| 배포 전 점검 | `npm run deploy:check` | 배포 전 |
| 배포 후 점검 | `npm run deploy:verify -- --url …` | 배포 직후 |

## 1. node --test

- `tests/*.test.mjs` 가 모두 돈다. 부분 실행: `node --test tests/ops-*.test.mjs`.
- 서버(Worker) 시험은 가짜 `env`(메모리 SQLite·가짜 ASSETS)로 `fetch` 핸들러를 직접 부른다. 화면 시험(jsdom)은 CSS·글꼴을 그리지 않으므로 DOM·글자·규칙 목록만 본다. 그려진 모양은 Playwright 와 캡처로 확인한다.
- 시험 문서는 실제 셸 구조를 그대로 복제한다(예: `<html lang data-…><body><main><div id="app">`). 셸 범위 선택자로 덮어쓰는 CSS 변이를 시험이 잡으려면 구조가 같아야 한다.
- 시험 URL·이메일은 가짜(`https://example.invalid`, `tester@example.test`)만 쓴다. 외부 호출을 하지 않는다.
- **운영 도구 시험**(`tests/ops-*.test.mjs`)은 wrangler·네트워크 없이 함수 단위로 돈다: 배포 점검의 자리표시·비밀값 모양·계정 대조·`.map` 거부, 배포 점검 판정(가짜 서버와 변이), 버전 스탬프, 개발 서버 인자, 롤백 인자. `docs/CONTRACT.md` 의 CSP 줄과 `post-deploy-check` 의 기대 값이 같은지도 여기서 대조한다. CONTRACT 의 머리말을 바꾸면 `scripts/post-deploy-check.mjs` 의 `EXPECTED_CSP` 도 같이 바꾼다(안 바꾸면 이 시험이 실패한다).

## 2. Playwright + axe (`tests/browser/*.spec.js`)

- 설정: `playwright.config.js`. 시험 서버는 `node scripts/dev.mjs --fake-auth --setup --port 8798` 를 직접 띄운다(로컬 D1 마이그레이션·시드를 먼저 적용, 가짜 Supabase 127.0.0.1:54321, 이메일 코드 `123456`). 이미 8798 이나 54321 을 쓰는 프로세스가 있으면 죽이지 않고 실패한다.
- 브라우저는 설치된 Playwright chromium(Playwright 1.65.0 = chromium-1254)만 쓴다. 다른 브라우저를 설치·다운로드하지 않는다.
- 확인 내용: 목록 카드 → 상세 → 뒤로 가면 목록 스크롤 위치 복원 / 언어 ko·ja·en 전환과 `html lang` / 상세 본문의 `<script>` 문자열이 글자로만 보임(API 응답을 바꿔 시험) / 주요 화면에서 콘솔 오류·CSP 위반 0건 / `/members/` 비로그인 → `/login/` / 이메일 코드 로그인 → `/members/` 에 이메일 → 로그아웃 → 다시 막힘 / axe 심각·중대 위반 0.
- 요소는 역할·이름(`getByRole`·`getByLabel`)으로 찾는다. 마크업 세부(클래스·구조)에 묶지 않는다. 언어 전환·로그인 단추를 못 찾으면 이름 정규식(`tests/browser/*.spec.js` 맨 위)이나 화면 라벨을 맞춘다.
- 결과는 저장소 밖 `..\qa\playwright\`(`results`, `report`)에 쓰인다. `SITE_QA_DIR` 로 위치를 바꿀 수 있다.
- 부분 실행: `npx playwright test csp.spec.js`, 목록만: `npx playwright test --list`.

### 접근성 점검 스크립트

`npm run dev`(8790)를 띄운 뒤 `npm run check:a11y [-- --url http://127.0.0.1:8790]`. `/`, `#/items/<첫 항목>`, `/login/`, 404 를 넓은 화면(1280)·휴대폰(390) × ko·ja·en 으로 axe 검사하고, 위반 표를 출력한다. 결과 JSON 은 `..\qa\a11y\a11y-result.json`(고정 이름, 덮어씀). serious·critical 위반이 있으면 종료 코드 1. axe 는 자동으로 잡히는 것만 본다 — 키보드 이동·초점 표시·글자 확대는 사람이 직접 한 번 본다.

## 3. D1 시험

D1 은 `UNION` 항 수 등 낮은 제한이 있어 메모리 SQLite 시험이 통과해도 운영에서 503 이 날 수 있다(`docs/D1_RULES.md`). 새·바꾼 SQL 은 `npm run check:d1` 로 로컬 D1 엔진(workerd)에서 실제로 실행한다. 배포 전에 반드시.

## 4. 변이 시험 (수작업 절차)

도구형 변이 프레임워크는 쓰지 않는다. 시험이 정말 회귀를 막는지 **사람이 코드를 일부러 망가뜨려 확인**한다.

1. 막아야 할 회귀를 나열한다(예: "보호 경로에 `.` 으로 우회하면 열린다", "상태 변경 요청에서 Origin 검사가 빠진다", "목록 카드가 버튼 대신 div 가 된다").
2. 변이 하나를 코드에 넣는다(임시 브랜치나 워크트리에서. 원본을 직접 고치지 않는다).
3. **새 시험**을 돌린다 → 실패해야 한다. 통과하면 시험이 약한 것이니 보강한다.
4. 같은 변이에서 **옛 시험**(변경 전 버전의 시험)을 돌린다 → 통과해야 한다(변이가 옛 시험으로는 안 잡혔다는 증거 = 새 시험이 새로 막아 주는 것).
5. 변이를 되돌리고 새 시험이 통과하는지 확인한다.
6. 기록을 남긴다. 표 한 줄: `변이 ID | 변이 내용 | 새 시험 결과(실패여야 함) | 옛 시험 결과(통과) | 되돌린 뒤 결과`. 파일은 `..\qa\mutations\변이_결과.txt`(저장소 밖, 작업 폴더 하나)에 두고, 설계 문서(`docs/design/`)의 "시험" 절에서 위치를 적는다.

`tests/ops-post-deploy-check.test.mjs` 의 "변이" 시험이 이 방식의 자동 예다(가짜 서버를 한 군데씩 망가뜨려 해당 점검만 FAIL 이 되는지 본다).

## 5. 시험 출력은 저장소 밖에

- 시험·점검 출력(`deploy-dryrun`, `a11y`, `playwright`, 캡처, 변이 기록)은 저장소 밖 `..\qa\` 에 둔다(`SITE_QA_DIR` 로 변경). 같은 종류는 고정 이름으로 덮어쓰고 버전 파일을 늘리지 않는다.
- 저장소 안에 남는 임시 출력은 `.gitignore` 의 `test-results/`·`playwright-report/`·`qa-output/` 뿐이다. 끝나면 지운다.
- `public/version.json`·`.dev.vars`·`.wrangler/` 는 커밋하지 않는다.

## 6. 배포 전 관문 점검

배포 전에 `web-launch-check` 스킬(Workers 하드 규칙·보안·SEO·접근성 점검표)을 한 번 돌려 FAIL 이 없는지 본다. 이 저장소의 `deploy:check` 는 설정·비밀값·번들을, 스킬은 코드·화면 관문을 본다 — 서로 대신하지 않는다.

배포 순서 전체는 `docs/DEPLOY.md`.
