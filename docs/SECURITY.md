# 보안 규칙 (서버)

화면 ↔ 서버 약속은 `docs/CONTRACT.md`, 이 문서는 그 값의 이유와 서버 구현 위치다. 값을 바꾸면 CONTRACT·`worker/http.js`·`tests/worker-headers.test.mjs`·`scripts/post-deploy-check.mjs` 를 같이 바꾼다.

## 1. 요청 흐름 (`worker/app.js`)

1. 경로 정규화(`worker/path.js`): 퍼센트 인코딩(이중 인코딩까지)·`\`·중복 슬래시·`.`/`..`·대소문자를 정리한다. 차단 판정과 API 라우팅이 같은 정규화 경로를 쓴다.
2. 주 주소 이동(`worker/origin.js`): `*.workers.dev` 로 들어오면 `APP_ORIGIN`(https)으로 301(GET·HEAD)/308(그 밖). `GET /api/health` 만 예외. 로컬은 옮기지 않는다.
3. `/api/*`: 상태 변경 요청의 출처 검사 → 빈도 제한 → 로그인 전 차단 → (로그인 상태면) CSRF → 라우팅.
4. 페이지: 로그인 전 차단 → GET·HEAD 만 → `ASSETS`(public/).
5. 모든 응답(정적·API·오류·리다이렉트)을 `finalize` 가 마무리한다: 보안 머리말, 캐시 규칙, HEAD 본문 제거.

## 2. 머리말 값과 이유

| 머리말 | 값 | 이유 |
|---|---|---|
| Content-Security-Policy | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | 같은 출처 파일만 실행·적용. 인라인 `<script>`·`<style>`·`style=""`·`on*=` 가 막힌다(XSS 가 들어와도 실행되지 않음). `base-uri 'none'` 은 `<base>` 로 상대 주소를 가로채는 공격, `object-src 'none'` 은 플러그인 실행을 막는다. API JSON 에도 붙인다(브라우저가 JSON 을 문서로 열 때도 같은 규칙). |
| X-Content-Type-Options | `nosniff` | 브라우저가 content-type 을 추측해 JSON·텍스트를 스크립트로 실행하지 않게. |
| Referrer-Policy | `no-referrer` | 바깥 링크로 나갈 때 주소(검색어·returnTo 등)를 넘기지 않는다. 외부 분석이 필요하면 `strict-origin-when-cross-origin` 으로 바꿀 수 있다(CONTRACT 함께 수정). |
| Permissions-Policy | `camera=(), microphone=(), geolocation=()` | 쓰지 않는 기기 권한을 처음부터 끈다. |
| X-Frame-Options / `frame-ancestors 'none'` | `DENY` | 다른 사이트가 이 화면을 iframe 에 넣어 누르게 하는 공격(클릭재킹) 방지. 두 머리말을 같이 둔다(옛 브라우저는 XFO 만 본다). |
| Cross-Origin-Opener-Policy | `same-origin` | 다른 출처 창이 `window.opener` 로 이 창을 건드리지 못하게. |
| Strict-Transport-Security | `max-age=31536000` (https 응답에만) | 한 번 https 로 온 브라우저는 1년간 http 로 오지 않는다. 로컬 http 개발에는 붙이지 않는다. `includeSubDomains`·`preload` 는 도메인 전체 정책이라 사이트별로 정한다. |

ASSETS 가 같은 이름 머리말을 주더라도 Worker 가 덮어쓴다(시험: "ASSETS 가 준 같은 이름 머리말도 덮어쓴다").

## 3. 캐시 규칙 (`staticCacheControl`)

| 응답 | Cache-Control |
|---|---|
| HTML 200·304 | `private, no-cache, no-transform` |
| HTML 그 밖(404 화면 등) | `private, no-store, no-transform` |
| JS·CSS 200·304 | `private, no-cache` (ETag 로 매번 재검증, 바뀌지 않으면 304) |
| woff2 | `public, max-age=604800` |
| 이미지(png·jpg·webp·gif·avif·svg·ico) | `public, max-age=86400` |
| 리다이렉트·그 밖·API | `private, no-store` |
| 로그인 전 차단 경로(`PROTECTED_PATHS`)의 정적 응답 | `private, no-store` (HTML 은 + `no-transform`). 공유 캐시에 회원 전용 파일이 남지 않게 |

- 304 는 200 과 같은 정책이다. 304 에 `no-store` 를 붙이면 브라우저가 재검증 뒤 캐시를 버려 매번 전체를 받는다. 304 에는 content-type 이 없을 수 있어 경로 확장자로 종류를 고른다.
- 파일 이름에 해시가 없으므로 `immutable` 은 쓰지 않는다. 빌드 도구로 해시 이름을 쓰게 되면 그 경로만 `public, max-age=31536000, immutable` 을 더할 수 있다.

## 4. no-transform 과 압축

- HTML 응답에는 언제나 `no-transform` 을 붙인다. Cloudflare 엣지가 분석용 스크립트(beacon)를 HTML 에 끼워 넣지 못하게 하려는 것이다. 끼워 넣은 인라인 스크립트는 `script-src 'self'` 에 막혀 콘솔에 CSP 오류가 난다.
- 교훈: **no-transform 을 빼면 압축은 되지만 엣지가 스크립트를 끼워 CSP 오류**가 난다. no-transform 이면 엣지가 압축도 하지 않는다.
- 그래서 Worker 가 직접 만든 동적 HTML 은 `gzipHeaders(request)`·`htmlResponse()`(`worker/http.js`)로 압축을 직접 고른다. Workers 런타임은 `content-encoding: gzip` 머리말이 있으면 본문을 스스로 압축한다. 운영에서는 Cloudflare 가 Worker 에 넘기는 `Accept-Encoding` 을 바꾸므로 `request.cf.clientAcceptEncoding` 만 본다.
- 정적 HTML(ASSETS)은 이 도우미를 쓰지 않는다. 템플릿 기본 화면은 모두 정적이라 지금은 동적 HTML 이 없다.

## 5. 출처·CSRF·본문

- 상태 변경 요청(POST·PUT·PATCH·DELETE `/api/*`): `Origin` = `APP_ORIGIN`(아니면 403 `INVALID_ORIGIN`), `Sec-Fetch-Site` 가 `cross-site`·`none` 이면 403 `INVALID_ORIGIN`, `x-site-request: 1`(아니면 403 `INVALID_REQUEST`). 없는 API 라도 출처부터 본다.
- 로그인 상태의 상태 변경 요청은 `x-csrf-token` = 세션의 csrf(상수 시간 비교, 아니면 403 `INVALID_CSRF`). 이메일 시작·확인만 예외(로그인 전 요청). 새 POST API 를 더해도 `app.js` 가 자동으로 검사한다.
- 본문: `content-type: application/json` 만, 16000바이트까지(`content-length` 를 믿지 않고 읽은 크기로도 자름). 넘으면 413 `PAYLOAD_TOO_LARGE`, JSON 아니면 400 `INVALID_JSON`.

## 6. 빈도 제한 (`worker/rate-limit.js`)

- Cloudflare Workers Rate Limiting 바인딩 `AUTH_RATE_LIMITER`(wrangler.jsonc: IP 당 60초 30회). 범위: `POST /api/auth/*`(로그아웃 제외 — 공용 기기에서 세션을 끝낼 수 있어야 한다) + `GET /api/auth/social/callback`(Supabase 코드 교환이 일어나는 GET).
- 키는 `cf-connecting-ip`. IPv6 는 `/64` 로 묶는다(한 가입자가 보통 /64 전체를 받아 주소만 바꿔 피할 수 있으므로). IPv4-mapped 는 IPv4 로 본다. 로그에 IP 를 남기지 않는다.
- 바인딩이 없거나 호출이 실패하면 허용한다(fail-open). 비용이 드는 기능(유료 AI 호출 등)을 더할 때는 반대로 실패 시 거절(fail-closed)하는 범위를 따로 만든다.
- `X-Forwarded-For` 는 믿지 않는다(누구나 보낼 수 있음).

## 7. 기능 스위치 (`worker/switches.js`)

값이 없거나 `disabled` → 꺼짐, `enabled` → 켜짐, 그 밖(`true`, `on`, `Enabled` …) → 추측하지 않고 503. 값은 요청마다 읽는다. 로그인 스위치는 `AUTH_ACTIVATION`(503 `AUTH_MISCONFIGURED`).

## 8. 로그

- 남기는 것: 고정된 접두어 + 경로 묶음 이름(`api/items`, `api/auth/email` …) + 오류 종류. 예: `SITE_ERROR api/items Error`, `SITE_AUTH_UNAVAILABLE unavailable`.
- 남기지 않는 것: 요청 본문, 쿠키, 이메일, 토큰, IP, 검색어, Supabase·제공자 응답 문구, SQL 값.

## 9. 시험

`node --test tests/worker-*.test.mjs` — 머리말·캐시·no-transform(`worker-headers`), 정규화·차단 우회(`worker-path`), 이동·출처·본문·스위치·빈도 제한(`worker-guards`), 로그인(`worker-auth`), 항목(`worker-items`), D1 제한(`worker-d1`).
