# 화면 ↔ 서버 연결 약속 (CONTRACT)

화면(`public/`)과 서버(`worker/`)가 함께 지키는 약속이다. 한쪽을 바꾸면 이 문서와 양쪽 시험을 같이 바꾼다.

## 1. 경로

| 경로 | 누가 응답 | 내용 |
|---|---|---|
| `/` | 정적(`public/index.html`) | 한 쪽짜리 앱. 해시 라우팅: `#/items`(목록, 기본), `#/items/<id>`(상세) |
| `/login/` | 정적(`public/login/index.html`) | 로그인 화면(이메일 코드 + 소셜 단추). `?returnTo=/경로` 를 받는다 |
| `/members/` | 정적, **로그인 전 차단** | 로그인한 사람만 보는 견본 화면 |
| `/404.html` | 정적 | 없는 경로(정적)는 이 화면을 404 로 |
| `/version.json` | 정적(배포 전 생성, 저장소에 없음) | `{ commit, dirty, builtAt }` |
| `/api/*` | Worker | 아래 3절 |

## 2. 공통 규칙

- 오류 응답 본문은 언제나 `{ "error": "SCREAMING_SNAKE_CODE" }` (+ 필요하면 `retryAfter` 숫자 초). 사람이 읽는 문구는 넣지 않는다. 화면이 코드를 한·일·영 문구로 바꾼다.
- 알 수 없는 오류는 `503 { "error": "SERVICE_UNAVAILABLE" }`. 로그에 본문·쿠키·이메일·토큰을 남기지 않는다. 로그 꼬리표는 `SITE_*`(예: `SITE_CONFIG_INVALID`)로 하고 사용자에게 보이지 않는다.
- 있는 경로에 다른 메서드 → `405 { "error": "METHOD_NOT_ALLOWED" }`. 없는 `/api/*` → `404 { "error": "NOT_FOUND" }`.
- `GET /api/health` → `200 { "ok": true }`(배포 점검·시험 서버 준비 확인용).
- JSON 응답: `content-type: application/json; charset=utf-8`, `cache-control: private, no-store`.
- 상태를 바꾸는 요청(POST·PUT·PATCH·DELETE `/api/*`)은 반드시
  - `Origin` 이 `APP_ORIGIN` 과 같고(다르면 `403 INVALID_ORIGIN`),
  - 머리말 `x-site-request: 1` 이 있어야 한다(없으면 `403 INVALID_REQUEST`).
  - `Sec-Fetch-Site` 가 `cross-site`·`none` 이면 Origin 이 맞아도 `403 INVALID_ORIGIN`.
  - 로그인한 상태의 상태 변경 요청(로그아웃 포함, 이메일 시작·확인 제외)은 `x-csrf-token` 이 세션 값과 같아야 한다(다르면 `403 INVALID_CSRF`).
- 요청 본문은 JSON, 16000바이트까지(넘으면 `413 PAYLOAD_TOO_LARGE`, JSON 아님 `400 INVALID_JSON`).
- 화면의 fetch 는 같은 출처만(`connect-src 'self'`), `credentials: 'same-origin'`.

## 3. API

### 3-1. 항목(목록·상세 견본, D1 `items`·`item_texts`)

- `GET /api/items?lang=ko|ja|en` → `200 { "items": [Item] }`
  - 정렬: 상태 `open`·`closing` 먼저(마감 가까운 순), 그다음 `closed`(최근 순).
- `GET /api/items/<id>?lang=` → `200 { "item": ItemDetail }` / 없으면 `404 { "error": "NOT_FOUND" }`
- `lang` 이 없거나 모르는 값이면 `ko`. 해당 언어 글이 없으면 `ko` 글로 채운다. `ko` 글이 없는 항목은 목록·상세에 나오지 않는다.
- `deadline` 이 null 이면 `endsOn` 23:59:59(+09:00)를 마감으로 보고 상태를 계산한다.

```text
Item = {
  id: string,              // 영문 소문자·숫자·하이픈
  status: "open" | "closing" | "closed",   // 서버가 deadline 과 현재 시각으로 계산(closing = 마감 7일 이내)
  title: string, summary: string, place: string,
  startsOn: "YYYY-MM-DD", endsOn: "YYYY-MM-DD", deadline: "YYYY-MM-DDTHH:mm:ss+09:00" | null,
  accent: "blue" | "aqua" | "lavender" | "coral" | "slate" | "yellow",   // 항목별 테마색(CSS data-accent 값과 같음)
  image: string | null     // 같은 출처 경로(예: /samples/poster-1.svg)
}
ItemDetail = Item & { body: string, link: string | null }   // body: 빈 줄로 문단, "- " 줄은 목록, "## " 줄은 소제목
```

### 3-2. 로그인(Supabase, 선택 모듈)

- `GET /api/auth/config` → `200 { "enabled": boolean, "methods": ["email","google",...] }`
  - `AUTH_ACTIVATION` 이 `enabled` 일 때만 `enabled: true`. 값이 없거나 `disabled` 면 false. 그 밖의 값이면 `503 AUTH_MISCONFIGURED`.
- `GET /api/auth/me` → `200 { "signedIn": false }` 또는 `200 { "signedIn": true, "user": { "id", "email" }, "csrf": string }`
- `POST /api/auth/email/start` `{ "email" }` → `200 { "sent": true }`
  - 오류: `400 INVALID_EMAIL`, `429 RATE_LIMITED`, `503 AUTH_DISABLED`, `503 AUTH_UNAVAILABLE`(Supabase 실패)
- `POST /api/auth/email/verify` `{ "email", "code", "returnTo"? }` → `200 { "signedIn": true, "returnTo": "/경로" }` + 세션 쿠키
  - 오류: `400 INVALID_CODE`, `400 INVALID_EMAIL`, `429 RATE_LIMITED`, `503 AUTH_DISABLED`, `503 AUTH_UNAVAILABLE`
- `GET /api/auth/social/start?provider=<이름>&returnTo=/경로` → `302` Supabase 로그인 화면(PKCE)
  - `provider` 가 `AUTH_METHODS` 에 없으면 `302 /login/?error=PROVIDER_NOT_ALLOWED`
  - 로그인 꺼짐·설정 오류면 `302 /login/?error=AUTH_DISABLED` 또는 `AUTH_MISCONFIGURED`
  - 오류 리다이렉트는 `returnTo` 가 `/` 가 아니면 `&returnTo=` 를 함께 붙인다
- `GET /api/auth/social/callback?code=...` → `302 <returnTo>` + 세션 쿠키 / 실패 시 `302 /login/?error=SOCIAL_FAILED`(같은 코드 재사용도 실패)
- 빈도 제한(`AUTH_RATE_LIMITER`)은 `POST /api/auth/*` 와 소셜 콜백 GET(코드 교환이 일어나는 요청)에 건다.
- `POST /api/auth/logout` → `200 { "signedIn": false }` + 쿠키 지움(CSRF 필요)
- `returnTo` 는 `/` 로 시작하는 같은 사이트 경로만(`//`, `/\`, 스킴 포함은 `/` 로 바꿈).
- 세션 쿠키: `__Host-site-session`(HttpOnly, Secure, SameSite=Lax, Path=/, 7일). 로컬 http 개발에서도 같은 이름(브라우저는 localhost 의 Secure 쿠키를 허용).

### 3-3. 로그인 전 차단

- `PROTECTED_PATHS`(쉼표로 나눈 경로 접두어, 기본 `/members/,/api/members/`)에 걸리는 요청이 로그인 전이면
  - 페이지 GET·HEAD → `302 /login/?returnTo=<원래 경로>`, 그 밖의 페이지 요청 → `303` 같은 곳
  - `/api/*` → `401 { "error": "SIGN_IN_REQUIRED" }`
- 비교 전에 경로를 정규화한다(퍼센트 디코딩, 중복 슬래시, 대소문자, `..`). 우회 시험을 둔다.
- 로그인 기능이 꺼져 있으면 아무도 로그인 상태가 될 수 없으므로 보호 경로는 항상 막힌다(실패 시 닫힘).
- `PROTECTED_PATHS` 값이 틀리면(`/` 전체, 상대 경로, `/login`·`/api/auth` 를 덮는 값) 모든 요청을 `503 SERVICE_UNAVAILABLE` 로 닫는다. 로그인 화면은 `/api/auth/config` 를 보고 "로그인 기능이 꺼져 있습니다"를 보여 준다.
- 견본 보호 API: `GET /api/members/hello` → `200 { "email": string }`

## 4. 보안 머리말(모든 응답)

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=31536000   (https 일 때만)
```

- 화면은 인라인 `<script>`, 인라인 `<style>`, `style="..."` 속성, `on*=` 속성을 쓰지 않는다. 동적 값이 필요하면 `data-*` 속성 + CSS, 또는 `element.style.setProperty`(CSSOM)만.
- 캐시: HTML 200 `private, no-cache, no-transform`(엣지 스크립트 삽입 방지), 200 이 아닌 HTML `private, no-store, no-transform`, JS·CSS `private, no-cache`(ETag 재검증), woff2 `public, max-age=604800`, 이미지 `public, max-age=86400`, 그 밖 `private, no-store`. 로그인 전 차단 경로의 정적 파일은 무엇이든 `private, no-store`(공유 캐시에 남지 않게).

## 5. 기능 스위치

- 값이 없거나 `disabled` → 꺼짐. 정해진 값(`enabled`)만 켜짐. 그 밖의 값은 추측하지 않고 503 으로 닫는다.

## 6. 환경 변수

| 이름 | 종류 | 뜻 |
|---|---|---|
| `APP_ORIGIN` | var | 사이트 주소(Origin 검사·리다이렉트 기준) |
| `AUTH_ACTIVATION` | var | 로그인 스위치 |
| `AUTH_METHODS` | var | `email`, 소셜 제공자 이름(`google`, `kakao`, `github` 등 Supabase 제공자 이름) |
| `PROTECTED_PATHS` | var | 로그인 전 차단 접두어 |
| `SUPABASE_URL` | var | Supabase 프로젝트 주소 |
| `SUPABASE_PUBLISHABLE_KEY` | secret | Supabase 공개 키 |
| `SESSION_ENCRYPTION_KEY` | secret | 세션 암호화 키(32바이트 base64) |
| `DB` | D1 바인딩 | 항목·세션 저장 |
| `AUTH_RATE_LIMITER` | ratelimit 바인딩 | 인증 요청 빈도 제한 |
| `ASSETS` | assets 바인딩 | `public/` |
