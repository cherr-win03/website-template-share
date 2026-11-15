# 배포 (DEPLOY)

Cloudflare Workers(정적 assets + D1) 배포 절차와 보호 장치다. 실제 배포·로그인·secret 등록·운영 마이그레이션은 모두 **사람(사이트 주인)의 승인 뒤에만** 한다. AI 에이전트는 점검과 dry-run 까지만 한다.

## 0. 도구 한눈에

| 명령 | 하는 일 | 업로드 |
|---|---|---|
| `npm run deploy:check` | 설정 자리표시 값·로그인 설정·`npm test`·version 스탬프·`wrangler deploy --dry-run`·비밀값 모양·`.map` 검사. PASS/WARN/FAIL 표 | 안 함 |
| `npm run deploy:release` | 위 점검 → 계정 대조 → git 확인 → 계획 출력 후 멈춤 | 안 함 |
| `npm run deploy:release -- --yes` | 위 + 실제 `wrangler deploy` + 배포 점검 | **함** |
| `npm run deploy:verify -- --url https://내사이트` | 배포된 주소를 읽기 전용으로 점검(헤더·보호 경로·API·커밋) | 안 함 |
| `npm run deploy:rollback` | 최근 배포 목록 | 안 함 |
| `npm run deploy:rollback -- --to <version-id> --yes` | 이전 버전으로 되돌림 | **함** |

점검 결과는 `FAIL` 이 하나라도 있으면 종료 코드가 0 이 아니고 배포하지 않는다. `WARN` 은 읽고 판단한다.

## 1. 새 사이트 첫 배포 준비 (한 번만)

1. **Cloudflare 계정 정하기.** 배포할 계정의 ID(대시보드 우측 또는 `wrangler whoami`)를 확인한다. 이 PC에 다른 계정(예: 다른 단체)으로 wrangler 로그인이 되어 있으면 사고가 날 수 있으므로 아래 "로그인 폴더 분리"를 켠다.
2. **D1 만들기**(사용자 승인): `npx wrangler d1 create <사이트이름>-db` → 출력의 `database_id` 를 받아 둔다.
3. **`wrangler.jsonc` 채우기**: `name`, `account_id`, `vars.APP_ORIGIN`(최종 주소, `https://` 로 시작·끝 슬래시 없음), `d1_databases[].database_name`·`database_id`, `ratelimits[].namespace_id`(같은 계정의 다른 사이트와 겹치지 않는 정수 문자열). 비밀값은 여기에 쓰지 않는다. `deploy:check` 가 자리표시 값(`my-site`·`https://example.com`·0 으로만 된 database_id·`account_id` 없음)을 FAIL 로 잡는다.
4. **secret 등록**(사용자가 직접, 값은 명령행에 쓰지 않는다). 로그인 기능을 켤 때만 필요하다:
   - `npx wrangler secret put SUPABASE_PUBLISHABLE_KEY`
   - `npx wrangler secret put SESSION_ENCRYPTION_KEY` (32바이트 base64. 운영용으로 새로 만든다. `.dev.vars` 의 로컬 가짜 값을 쓰지 않는다)
5. **로그인 기능을 켤 때**: `wrangler.jsonc` 의 `vars.AUTH_ACTIVATION` 을 `"enabled"`, `SUPABASE_URL` 을 `https://…supabase.co` 로. 로컬 주소(`http://127.0.0.1:54321`)는 운영에 쓰면 FAIL.
6. **운영 마이그레이션 적용**(사용자 승인 뒤): `npx wrangler d1 migrations list DB --remote`(읽기 전용)로 미적용 목록을 보고, 승인되면 `npx wrangler d1 migrations apply DB --remote`. **D1 변경은 롤백되지 않는다.** 코드가 새 스키마를 쓰면 배포보다 마이그레이션이 먼저다.
7. `npm run deploy:check` 가 FAIL 없이 끝나는지 확인한다.

### 로그인 폴더 분리(선택)

여러 Cloudflare 계정을 쓰는 PC 에서, 이 사이트는 전용 로그인만 쓰게 한다. 저장소 루트에 `deploy.config.json`(커밋해도 비밀 없음) 또는 환경 변수 `DEPLOY_LOGIN_DIR`:

```json
{ "loginDir": "../runtime/cf-내사이트", "branch": "main" }
```

- `loginDir` 가 있으면 wrangler 자식 프로세스는 그 폴더(`XDG_CONFIG_HOME`)의 로그인만 쓰고, `CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_ACCOUNT_ID` 등 계정 환경 변수는 지워진다.
- 처음 한 번 `node scripts/deploy-guard.mjs login`(브라우저가 열림, 로그인은 사람이), 확인은 `node scripts/deploy-guard.mjs whoami`.
- 설정하지 않으면 wrangler 의 기본 로그인을 그대로 쓴다. 어느 쪽이든 `release` 는 로그인 계정에 `wrangler.jsonc` 의 `account_id` 가 있는지 확인하고, 다르면 중단한다.

## 2. 매 배포 순서

`main` 에 병합·커밋된 상태에서, 작업 트리가 깨끗해야 한다.

1. **점검**: `npm run deploy:check`
   - 확인하는 것: 자리표시 값, 로그인 스위치와 `SUPABASE_URL`, 필수 secret 이름, `npm test`, `public/version.json` 기록, `wrangler deploy --dry-run --outdir ..\qa\deploy-dryrun`(저장소 밖), 묶음과 `public/` 의 비밀값 모양(개인키 머리·`sk_`·`ghp_`·AWS 키·JWT·`.dev.vars` 값 그대로)과 `.map` 파일.
   - SQL 을 바꿨다면 먼저 `npm run check:d1`(D1 제한은 로컬 SQLite 로 안 잡힌다, `docs/D1_RULES.md`).
   - 화면을 바꿨다면 `npm run test:browser` 와 `npm run check:a11y`, 그리고 배포 전 `web-launch-check` 스킬로 관문 점검(`docs/TESTING.md`).
2. **dry-run**: 1 단계에 포함되어 있다. 따로 보려면 `npx wrangler deploy --dry-run --outdir ../qa/deploy-dryrun`. 출력 폴더는 저장소 밖이다.
3. **배포 계획 확인**: `npm run deploy:release`. 로그인 계정·브랜치·작업 트리·운영 미적용 마이그레이션(읽기 전용)·필수 secret 이름을 확인하고, Worker·계정·주소·커밋을 보여 준 뒤 **멈춘다**.
4. **배포**(사용자 승인 뒤): `npm run deploy:release -- --yes`. 업로드 직전 계정을 다시 확인하고 `wrangler deploy` 를 실행한 뒤 배포 점검을 자동으로 돌린다(전파 지연이 있으면 5초 간격으로 3번 재시도). wrangler 출력은 허용 목록 줄만 보여 주고 변수 값은 숨긴다.
5. **배포 점검**: `npm run deploy:verify -- --url https://내사이트`(4 단계에서 이미 돌지만, 나중에 다시 확인할 때 쓴다). 항목:
   - `/` 200, CSP 가 `docs/CONTRACT.md` 4절과 정확히 같음, `nosniff`, HTML `no-transform`, 보안 머리말, https 면 HSTS
   - `/version.json` 의 `commit` 이 로컬 HEAD 와 같음(다르면 FAIL, 작업 트리가 지저분했으면 WARN)
   - `/api/health` 200, `/api/items` 200, `/members/` 302(→ `/login/`), `/api/members/hello` 401 `SIGN_IN_REQUIRED`
   - 없는 API 404 JSON, 없는 페이지 404, Origin 없는 POST 403, `/.dev.vars`·`/wrangler.jsonc`·`.map` 이 공개되지 않음
6. **운영 확인**(사람 눈): 브라우저로 운영 주소에서 **바뀐 화면을 직접** 연다. 목록→상세→뒤로, 언어 전환, 로그인이 켜져 있으면 로그인(로그인은 사람)까지. 배포 점검 통과만으로 화면이 맞다고 단정하지 않는다.
7. 문제가 있으면 아래 롤백.

## 3. 롤백

1. 최근 배포 보기: `npm run deploy:rollback` → 현재와 이전 버전 ID 가 나온다.
2. 계획 보기: `npm run deploy:rollback -- --to <version-id>`(아직 아무것도 바꾸지 않음).
3. 실행(사용자 승인 뒤): `npm run deploy:rollback -- --to <version-id> --yes`. 이어서 배포 점검을 자동으로 돌린다(롤백한 버전은 일부러 옛 커밋이므로 커밋 비교만 건너뜀).

**알아둘 것**
- **D1 데이터와 이미 적용한 마이그레이션은 되돌아가지 않는다.** 새 스키마에 맞춘 코드가 올라간 뒤 옛 코드로 돌아가면 깨질 수 있다. 되돌릴 수 없는 스키마 변경이 들어간 버전 이전으로는 가지 않는다는 기준선을 이 문서의 "기준선" 절에 적어 둔다.
- **변수와 secret 은 버전과 함께 되돌아간다.** 롤백 뒤 로그인 설정(`AUTH_ACTIVATION` 등)이 그 시점 값이 된다.
- 긴급 차단이 필요하면 대시보드(Workers → 해당 Worker → 도메인·workers.dev 끄기)에서 한다. 개인정보가 들어간 D1 은 `wrangler delete` 로 지우지 않는다.
- 대시보드에서 직접 롤백해도 된다(Workers → Deployments → 이전 버전 → Rollback).

## 4. 기준선·실행 기록 (사이트마다 채운다)

- 롤백 기준선: (예: "2026-12-01 `abc1234` 이후로만 되돌린다. 그 커밋에서 `0003` 마이그레이션이 적용됐다")
- 날짜별 기록(표): 날짜 | 커밋 | 한 일(배포·마이그레이션·롤백) | 확인 방법 | 승인한 사람

## 5. 하지 않는 것

- 점검·배포 도구는 `wrangler login`·`secret put`·`d1 migrations apply --remote` 를 대신 실행하지 않는다. 사람이 한다.
- 비밀값은 저장소·`wrangler.jsonc`·로그에 넣지 않는다. 점검 표에도 값은 나오지 않고 규칙 이름과 파일명만 나온다.
- Git 연동 자동 배포(Workers Builds)를 쓰면 이 문서의 점검 단계가 건너뛰어진다. 쓴다면 main 보호 규칙과 `deploy:verify` 를 따로 정한다.
