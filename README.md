# website-template-share

Cloudflare Workers 위에서 도는 웹사이트 시작 템플릿이다. 포스터 카드 목록·상세 화면, 보안 머리말(인라인 금지 CSP), 한·일·영, D1, 선택형 Supabase 로그인, 배포 보호 장치와 시험이 들어 있다.

## 들어 있는 것

| 묶음 | 위치 | 내용 |
|---|---|---|
| 디자인 층 | `public/design/` | 토큰(`--ui-*`, 흰 바탕·잉크 #14181C·파랑 강조), 기본 CSS, 컴포넌트(머리말·꼬리말·단추·칩·상태 칩·입력·오류·빈/불러오는 중), 포스터 카드 목록·상세 배치, Pretendard 자체 호스팅. 프레임워크 없는 클래스 기반이라 React 사이트도 그대로 가져다 쓸 수 있다 |
| 화면 | `public/app/` | 바닐라 JS 모듈(빌드 없음). 해시 라우팅 목록·상세, 한·일·영 전환, 로그인·회원 견본 화면 |
| 서버 | `worker/` | 보안 머리말(인라인 금지 CSP)·캐시·no-transform, 경로 정규화·주 주소 이동, 오류 형식 `{error:CODE}`, 빈도 제한, 기능 스위치, D1 도우미·견본 API |
| 로그인(선택, 기본 꺼짐) | `worker/auth/`, `public/login/` | Supabase 이메일 코드·소셜(PKCE), 암호화 D1 세션, CSRF, 로그인 전 차단 |
| D1 | `migrations/`, `scripts/check-d1.mjs` | D1 제한(compound SELECT 5항 등) 정적 검사 + 로컬 D1 엔진 실제 실행 |
| 배포 | `scripts/deploy-*.mjs`, `scripts/post-deploy-check.mjs` | 자리표시 값·비밀 모양 검사, 계정 고정, dry-run, 배포 후 동작 점검, 롤백 |
| 시험 | `tests/` | node --test(jsdom 포함) 255건, Playwright 11건(가짜 Supabase 로그인 흐름 포함), axe |

## 빠른 시작

```bash
npm ci
npm run setup
npm run dev
```

`http://127.0.0.1:8790`. 로그인까지 보려면 `npm run dev -- --fake-auth`(가짜 Supabase, 코드 `123456`).

새 사이트를 만들 때는 [docs/START.md](docs/START.md) 순서를 따른다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `npm test` | node --test 전체(서버·화면·배포 스크립트) |
| `npm run test:browser` | Playwright: 목록·상세·언어·CSP·로그인·axe |
| `npm run check:d1` | D1 제한 정적 검사 + 로컬 D1 실행 |
| `npm run check:a11y` | axe 점검(넓은 화면·휴대폰 × 한·일·영) |
| `npm run deploy:check` | 배포 전 점검(배포하지 않음) |
| `npm run deploy:release -- --yes` | 배포(사용자 승인 뒤) |
| `npm run deploy:verify -- --url <주소>` | 배포 후 동작 점검 |
| `npm run deploy:rollback` | 이전 버전 목록·되돌리기 |

## 문서

- [START](docs/START.md) 새 사이트 시작 순서와 바꿀 곳
- [CONTRACT](docs/CONTRACT.md) 화면 ↔ 서버 약속
- [DESIGN_RULES](docs/DESIGN_RULES.md) 토큰·굳은 규칙·접근성, [DESIGN_DOC_TEMPLATE](docs/DESIGN_DOC_TEMPLATE.md) 화면 변경 기록 틀
- [SECURITY](docs/SECURITY.md) 머리말과 이유, [AUTH](docs/AUTH.md) 로그인 켜는 법, [D1_RULES](docs/D1_RULES.md) D1 제한
- [DEPLOY](docs/DEPLOY.md) 배포 절차, [TESTING](docs/TESTING.md) 시험·변이 시험 절차

## 알려진 한계

- 실제 Supabase 프로젝트로는 확인하지 않았다(가짜 Supabase 로만 확인). 켜기 전에 `docs/AUTH.md` 1절 순서로 한 번 시험한다.
- 운영 배포로는 확인하지 않았다(HSTS·운영 빈도 제한·엣지 압축). 첫 배포 때 `deploy:verify` 로 확인한다.
- 어두운 테마는 없다(방향 B 는 흰 바탕 전제). 확인 브라우저는 Chromium 뿐이다.

## Claude Code 스킬

`skill/website-template/SKILL.md` 를 `~/.claude/skills/website-template/` 에 복사하면 "새 웹사이트 만들어줘" 같은 요청에서 이 템플릿 절차를 따른다.
