# 로그인(선택 모듈, Supabase)

기본은 꺼져 있다(`AUTH_ACTIVATION=disabled`). 꺼져 있으면 아무도 로그인 상태가 될 수 없어 `PROTECTED_PATHS`(기본 `/members/`, `/api/members/`)는 언제나 막힌다. 화면 약속은 `docs/CONTRACT.md` 3-2·3-3절.

| 파일 | 하는 일 |
|---|---|
| `worker/auth/routes.js` | `/api/auth/config·me·email/start·email/verify·logout` |
| `worker/auth/social.js` | `/api/auth/social/start·callback` (PKCE) |
| `worker/auth/current.js` | 설정 읽기, "지금 요청한 사람"(세션 + 토큰 갱신), 세션 발급 |
| `worker/auth/session.js` | D1 `sessions` 표, `__Host-site-session` 쿠키, AES-GCM |
| `worker/auth/supabase.js` | Supabase Auth REST 호출(fetch 주입 가능) |
| `worker/auth/gate.js` | 로그인 전 차단(302/303/401) |
| `migrations/0002_sessions.sql` | 세션 표 |
| `scripts/fake-supabase.mjs` | 로컬 시험용 가짜 Supabase |

## 1. 로그인 켜는 순서

비밀값은 저장소·`wrangler.jsonc`·대화·로그에 쓰지 않는다. 운영 마이그레이션·배포는 사용자 승인 뒤에 한다.

1. **Supabase 프로젝트 만들기**(사람이 대시보드에서). Project URL(`https://<ref>.supabase.co`)과 Publishable key(`sb_publishable_…`, 옛 프로젝트는 anon key)를 확인한다. **Secret key·service_role key 는 쓰지 않는다**(서버가 거부한다).
2. **이메일 코드**: Authentication → Providers → Email 을 켠다. 메일에 6자리 코드가 가도록 Authentication → Email Templates 의 "Magic Link" 템플릿에 `{{ .Token }}` 을 넣는다. 처음 로그인하는 주소는 "Confirm signup" 템플릿이 갈 수 있으니 그쪽에도 `{{ .Token }}` 을 넣는다(추정입니다: Supabase 버전에 따라 첫 로그인에 쓰는 템플릿이 다를 수 있어, 켜기 전에 새 주소로 한 번 확인한다). 새 사용자 가입을 막고 싶으면 "Allow new users to sign up" 을 끈다(그때 모르는 주소는 `AUTH_UNAVAILABLE` 로 답한다 — 주소가 있는지 알려 주지 않기 위해).
3. **소셜 제공자**(쓸 때만): 제공자(Google 등) 개발자 콘솔에서 OAuth 클라이언트를 만들고, 승인된 리디렉션 URI 에 `https://<ref>.supabase.co/auth/v1/callback` 을 넣는다. 받은 Client ID·Secret 은 Supabase Authentication → Providers 에만 넣는다(Worker 에는 넣지 않는다).
4. **리디렉션 주소**: Authentication → URL Configuration 에서 Site URL = `APP_ORIGIN`, Redirect URLs 에 `https://<사이트>/api/auth/social/callback**` 를 더한다(끝의 `**` 는 `?state=…` 검색어까지 맞추려는 것. 추정입니다: 정확한 일치 규칙은 Supabase 문서로 확인).
5. **비밀값 넣기**:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"   # 세션 키 만들기(출력은 곧바로 아래에 붙여 넣고 어디에도 저장하지 않는다)
   npx wrangler secret put SESSION_ENCRYPTION_KEY
   npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
   ```
6. **설정값**(`wrangler.jsonc` vars): `APP_ORIGIN`(https 주 주소), `SUPABASE_URL`, `AUTH_METHODS`(`email` 과 Supabase 제공자 이름, 예 `email,google`), 필요하면 `PROTECTED_PATHS`.
7. **세션 표 만들기**(사용자 승인 뒤, 되돌릴 수 없음): `npx wrangler d1 migrations list DB --remote` 로 확인 → `npx wrangler d1 migrations apply DB --remote`. `docs/D1_RULES.md` 4절.
8. **마지막에 스위치**: `AUTH_ACTIVATION` 을 `enabled` 로 바꾸고 배포한다(`docs/DEPLOY.md`). `enabled` 외의 값(`true`, `on` …)은 503 `AUTH_MISCONFIGURED` 다.
9. **확인**: `GET /api/auth/config` → `{"enabled":true,"methods":[…]}`. 하나라도 틀리면(키 형식, URL, 세션 키 길이, DB 바인딩) 503 `AUTH_MISCONFIGURED` 이고 보호 경로는 계속 막힌다.

끄기: `AUTH_ACTIVATION=disabled` 로 배포. 세션 행은 남지만 쓰이지 않는다. 세션 키를 바꾸면 모든 세션이 풀리지 않아 전원 로그아웃된다(다음 요청에서 행을 지운다).

## 2. 가짜 Supabase 로 로컬 시험

실제 Supabase·메일 없이 로그인 흐름을 끝까지 돌린다. 가짜는 `127.0.0.1` 에서만 뜬다.

가장 쉬운 길: `npm run dev -- --fake-auth` (가짜 Supabase 와 wrangler dev 를 함께 띄우고 로그인을 켠다).

손으로 할 때:

```bash
npm run db:migrate:local
node scripts/fake-supabase.mjs --access-ttl=70      # 127.0.0.1:54321, 액세스 토큰 70초(갱신 시험)
# .dev.vars: APP_ORIGIN=http://127.0.0.1:<포트>, AUTH_ACTIVATION=enabled, SUPABASE_URL=http://127.0.0.1:54321
npx wrangler dev --port <포트> --ip 127.0.0.1
```

- 이메일: 아무 주소 → 코드 `123456` 만 성공. 그 밖은 `INVALID_CODE`.
- 소셜: 제공자 화면 없이 곧바로 콜백으로 돌아오고 `<제공자>.user@example.test` 로 로그인된다.
- 갱신: `--access-ttl=70` 이면 로그인하고 10초 뒤 요청부터 refresh 를 부른다(만료 60초 전부터 갱신).
- `APP_ORIGIN` 은 dev 서버의 포트와 같아야 한다(상태 변경 요청의 Origin 검사).
- http 루프백 Supabase 는 사이트도 루프백일 때만 받는다(운영에 잘못 남으면 `AUTH_MISCONFIGURED`).
- curl 로 볼 때는 `-c jar.txt -b jar.txt` 로 쿠키를 저장하고, POST 에 `-H "Origin: http://127.0.0.1:<포트>" -H "x-site-request: 1" -H "content-type: application/json"`, 로그아웃에는 `/api/auth/me` 의 `csrf` 를 `x-csrf-token` 으로 넣는다.
- 자동 시험(`tests/worker-auth.test.mjs`)은 같은 가짜를 fetch 자리에 넣어 포트 없이 돈다.

## 3. 설계 선택

### 3-1. 세션은 D1 서버 저장(권장안)

- 쿠키에는 무작위 32바이트(hex)만 둔다. D1 행 id 는 그 SHA-256 이라 DB 가 새어도 쿠키를 만들 수 없다.
- 행 내용(사용자 id·이메일·Supabase 토큰)은 `SESSION_ENCRYPTION_KEY` 로 AES-GCM 암호화하고, 추가 인증 데이터에 행 id 를 넣어 다른 행으로 옮기면 풀리지 않는다. 토큰은 브라우저로 나가지 않는다.
- 로그아웃 = 행 삭제. 복사해 둔 쿠키도 즉시 쓸 수 없다(서명 쿠키 방식은 폐기 목록이 따로 필요하다).
- 7일 절대 만료. 유휴 만료는 넣지 않았다(필요하면 `touched_at` 열을 더해 12시간 유휴 만료 같은 규칙을 둘 수 있다).
- 같은 브라우저에서 다시 로그인하면 이전 행을 지운다(세션 고정 방지).
- 감수할 점: 로그인한 요청마다 D1 읽기 1번. 대신 외부 호출은 없다(아래).

### 3-2. 토큰 확인: 로그인·갱신 때 `/auth/v1/user` 호출, 요청마다는 D1 세션만 (선택)

| 방식 | 장점 | 단점 |
|---|---|---|
| 요청마다 `/user` 호출 | Supabase 쪽 차단·삭제가 즉시 반영 | 요청마다 외부 왕복(지연·Supabase 한도), 장애가 곧 로그인 장애 |
| 로컬 JWT 검증(JWKS + jose) | 빠름 | 서명 키 관리·라이브러리 추가, 폐기는 만료까지 반영 안 됨, 결국 세션 저장소가 따로 있어 이중 |
| **로그인·갱신 때만 `/user`, 요청마다 D1 세션** (채택) | 외부 호출은 로그인·갱신 때만, 로그아웃은 행 삭제로 즉시 | Supabase 쪽에서 사용자를 막아도 다음 갱신(액세스 토큰 수명, 기본 1시간)까지는 D1 세션이 유효 |

- 이유: 이 템플릿의 보호 화면은 사용자 id·이메일만 쓰고 Supabase API 를 사용자 대신 부르지 않는다. 세션 행은 서버가 `/user` 로 신원을 확인한 뒤에만 만들어지므로 요청마다 다시 물을 이유가 적다.
- 갱신: 액세스 토큰 만료 60초 전부터 `grant_type=refresh_token` 으로 바꾸고 `/user` 로 같은 사람인지 다시 확인한다. 거부되면 행을 지워 로그아웃 상태, Supabase 에 닿지 못하면(장애·한도) 행은 두고 그 요청만 로그인 안 한 것으로 본다(닫힌 쪽).
- 즉시 반영이 필요한 기능(결제·권한 변경 등)은 그 처리기에서 `supabaseFor(ctx, settings).getUser(accessToken)` 을 한 번 더 부른다.

### 3-3. 그 밖

- 동시 갱신: 두 요청이 같은 리프레시 토큰으로 갱신하면 Supabase 는 재사용 허용 시간(기본 10초) 안에서 같은 새 토큰을 준다. D1 저장은 "읽었던 암호문과 같을 때만" 바꾸고, 진 쪽은 새 행을 다시 읽어 쓴다. 재사용 허용 시간을 0 으로 줄인 프로젝트에서는 드물게 로그아웃될 수 있다(추정입니다).
- 소셜(PKCE): code_verifier 와 state 는 암호화한 10분짜리 `__Host-site-oauth` 쿠키(SameSite=Lax — Supabase 에서 돌아오는 최상위 GET 에 실린다)에만 둔다. 콜백은 state 를 상수 시간 비교하고, 코드 교환은 이 브라우저의 verifier 로만 된다(다른 브라우저의 코드로는 교환 실패). 실패는 언제나 `/login/?error=SOCIAL_FAILED` 이고 제공자·Supabase 문구는 되돌려 보내지 않는다.
- 키: publishable/anon 키만 받는다. `sb_secret_…`·`service_role` JWT 는 거부한다(서버에 관리자 키를 두지 않는다).
- Supabase 호출: 리다이렉트를 따르지 않음, 응답 64KiB, 시간 제한 5초(메일 보내는 `/otp` 10초). 오류는 종류(`rate_limited`·`unavailable`·`rejected`·`invalid_response`)만 쓰고 문구는 버린다.
- 이메일 시작: Supabase 의 거부(가입 막힘 등)도 `AUTH_UNAVAILABLE` 로 답해 주소가 있는지 알려 주지 않는다.
- 빈도 제한: `POST /api/auth/*`(로그아웃 제외)와 소셜 콜백에 IP 당 60초 30회(`docs/SECURITY.md` 6절). Supabase 자체 한도(메일 발송 등)에 걸리면 429 `RATE_LIMITED` + `retryAfter`.

## 4. 오류 코드(로그인)

| 코드 | 상태 | 언제 |
|---|---|---|
| `AUTH_DISABLED` | 503 | 로그인 꺼짐, 또는 `AUTH_METHODS` 에 `email` 없음 |
| `AUTH_MISCONFIGURED` | 503 | 스위치 값이 틀림, 켜졌는데 설정값이 틀림 |
| `AUTH_UNAVAILABLE` | 503 | Supabase 장애·거부(이메일 시작), 확인 단계의 Supabase 장애·응답 이상 |
| `INVALID_EMAIL` | 400 | 이메일 형식(시작·확인), 시작 본문에 다른 키 |
| `INVALID_CODE` | 400 | 코드 형식(6~10자리 숫자)·틀림·만료, 확인 본문에 다른 키 |
| `RATE_LIMITED` | 429 | 빈도 제한(`retryAfter` 초) |
| `INVALID_CSRF` | 403 | 로그인 상태의 상태 변경 요청에 `x-csrf-token` 없음·다름 |
| `SIGN_IN_REQUIRED` | 401 | 보호 API 를 로그인 전에 |
| `/login/?error=PROVIDER_NOT_ALLOWED` | 302 | 소셜 시작: `AUTH_METHODS` 에 없는 제공자·`email`·빈 값 |
| `/login/?error=AUTH_DISABLED` | 302 | 소셜 시작·콜백: 로그인 꺼짐 |
| `/login/?error=AUTH_MISCONFIGURED` | 302 | 소셜 시작: 설정 오류 |
| `/login/?error=SOCIAL_FAILED` | 302 | 소셜 콜백 실패 전부 |

소셜 리다이렉트에는 시작할 때 받은 `returnTo`(안전화한 값)가 `/` 가 아니면 `&returnTo=` 로 붙는다.
