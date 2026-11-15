# D1 규칙

Cloudflare D1 은 SQLite 이지만 한도를 낮춰 둔다. **로컬 SQLite·node:sqlite 시험은 이 한도를 지키지 않는다.** 실제 사례로 9항 `UNION ALL` 이 모든 로컬 시험을 통과하고 운영에서 503(`too many terms in compound SELECT`)이 나 30분 만에 되돌린 일이 있다(2026-11-13, PR #130). 그래서 새·바꾼 SQL 은 `npm run check:d1` 로 로컬 D1 엔진(workerd)에서 실제로 실행해 본다.

## 1. 제한

| 항목 | D1 한도 | 검사 |
|---|---|---|
| compound SELECT 항(`UNION`·`UNION ALL`·`INTERSECT`·`EXCEPT`) | 5 | 정적 + 로컬 엔진 |
| SQL 함수 하나의 인자 수 | 32 (로컬 workerd 는 127까지 받음) | 정적 |
| 바인딩 매개변수 수·번호(`?1`…) | 100 | 정적 + 로컬 엔진 |
| 문장 길이 | 100,000바이트 | 정적 |
| LIKE/GLOB 패턴 | 50바이트 (글자 그대로의 패턴, 또는 바인딩 값으로 만든 패턴) | 정적(글자 그대로), 바인딩 값은 실행 시 |
| 표현식 깊이·결과 열·ORDER BY 항 | 엔진 한도 | 로컬 엔진(EXPLAIN) |

출처: https://developers.cloudflare.com/d1/platform/limits/ (값은 2026-11-13 조사 기준. 바뀌었을 수 있으니 큰 SQL 을 쓰기 전에 다시 확인한다.)

- 여러 행 `VALUES (…), (…)` 는 compound 로 세지 않는다.
- CHECK 제약 안의 GLOB 도 50바이트 한도를 받는다. 날짜 형식은 GLOB 대신 `date(x) IS x`, `datetime()`, `length()`, `substr()` 로 검사한다(`migrations/0001_items.sql`).
- D1 은 외래 키를 늘 켠다(`ON DELETE CASCADE` 가 동작한다). 파일·배치 안에 `BEGIN`/`COMMIT` 을 쓰지 않는다(여러 문장을 한 번에 → `db.batch`).

## 2. 쓰는 법

- SQL 은 `worker/` 안의 **문자열 상수**로 쓰고 값은 **바인딩 매개변수**(`?1`, `?2` …)로만 넘긴다(`worker/db.js`). `${}` 로 값을 끼우거나 문자열을 이어 붙이지 않는다(정적 검사가 `${}` 를 잡는다).
- 한 문자열에 한 문장(`prepare` 는 한 문장만 받는다).
- 바인딩 값은 문자열·유한한 숫자·null·바이트만. `undefined`·boolean 은 `db.js` 가 거부한다(D1 이 거부하거나 뜻이 바뀐다) — `null`·`0/1` 로 바꾼다.
- 시각은 정수 ms(`Date.now()`), 날짜는 `YYYY-MM-DD`, 마감은 `YYYY-MM-DDTHH:mm:ss+09:00` 처럼 **한 가지 길이·시간대**로 저장한다. 그러면 문자열 비교가 곧 시간 비교라 SQL 에서 정렬·비교할 수 있다.
- 쓰기 경합: `UPDATE … WHERE id = ? AND <읽었던 값> = ?` 처럼 조건부로 바꾸고 `meta.changes` 로 이겼는지 본다(`worker/auth/session.js` 의 `SESSION_UPDATE_SQL`).

### compound SELECT 대신 쓰는 법

언어별 글을 고를 때 언어마다 `SELECT … UNION ALL SELECT …` 를 이으면 언어가 5개를 넘는 순간 깨진다. 대신 기본 언어를 `JOIN`, 고른 언어를 `LEFT JOIN` 하고 `COALESCE` 로 채운다(`worker/items.js`):

```sql
SELECT i.id,
  COALESCE(NULLIF(t.title, ''), k.title) AS title       -- 고른 언어가 없거나 비면 ko
FROM items AS i
JOIN item_texts AS k ON k.item_id = i.id AND k.locale = 'ko'
LEFT JOIN item_texts AS t ON t.item_id = i.id AND t.locale = ?1
```

그 밖의 경우:
- 고정 목록 여러 개를 합칠 때 → 여러 행 `VALUES` 또는 `IN (…)`.
- 서로 다른 표 집계를 한 번에 → 스칼라 하위 질의 `SELECT (SELECT count(*) FROM a) AS a, (SELECT count(*) FROM b) AS b`.
- 정말 합쳐야 하면 → 문장을 나눠 `db.batch([...])` 로 한 번에 보낸다(왕복 1번).

## 3. 검사

| 명령 | 하는 일 |
|---|---|
| `node --test tests/worker-*.test.mjs` | 가짜 D1(node:sqlite + 마이그레이션)이 보내는 **모든 문장**을 정적 검사에 통과시킨다(`tests/helpers/fake-d1.js`). 저장소 SQL 전체의 정적 검사(`tests/worker-d1.test.mjs`). |
| `npm run check:d1` | (a) `worker/**/*.js` 의 SQL 문자열과 `migrations/*.sql` 정적 검사, 마이그레이션 이름 형식 (b) 빈 임시 로컬 D1 에 `wrangler d1 migrations apply --local` 로 실제 적용 → worker 의 모든 SQL 을 `EXPLAIN` → 항목·세션 모듈을 그 DB 에 대고 실제 실행. 6항 UNION 을 엔진이 거부하는지도 스스로 확인한다. 결과는 `../qa/check-d1/report.json`. |

- `check:d1` 은 로컬 전용이다(원격 계정·토큰·운영 DB 를 쓰지 않는다). 임시 DB 는 `../qa/check-d1/state`(환경 변수 `SITE_QA_DIR` 로 바꿈)에 매번 새로 만들고, 개발용 `.wrangler/state` 는 건드리지 않는다.
- Windows 에서 임시 경로가 길면 workerd 가 "internal error" 로 멈춘다(SQLite 파일 경로 260자). 140자를 넘으면 스크립트가 미리 멈추고 알려 준다.
- 한계: LIKE 패턴 길이(바인딩 값)는 실제 값으로 실행할 때만 정해진다. 함수 인자 32 는 로컬 엔진이 127까지 받아 정적 검사만 지킨다. SQL 을 문자열 상수가 아닌 방식(함수가 조립)으로 만들면 정적 검사가 찾지 못한다 — 그래서 상수로 쓴다.

## 4. 마이그레이션

- 파일: `migrations/0001_items.sql`, `0002_sessions.sql` … (`wrangler d1 migrations create DB <이름>` 형식, 번호 연속). 이미 적용한 파일은 **고치지 않는다**. 바꿀 것은 새 번호 파일로.
- 로컬은 자유: `npm run db:migrate:local`, 시드는 `npm run db:seed:local`(가짜 항목 6개를 지우고 다시 넣음, 다른 행은 그대로).
- **운영 적용은 사용자 승인 뒤**: `npx wrangler d1 migrations list DB --remote`(읽기 전용)로 미적용 목록 확인 → 승인 → `npx wrangler d1 migrations apply DB --remote`.
- **D1 변경은 롤백되지 않는다.** 표·열 삭제는 되돌릴 수 없으니 먼저 열을 더하고(코드가 둘 다 견디게) 배포한 뒤, 나중 마이그레이션에서 지운다. 새 스키마를 쓰는 코드는 마이그레이션이 먼저 적용된 뒤 배포한다(`docs/DEPLOY.md`).
- 적용 전 `npm run check:d1` 이 통과해야 한다.

## 5. 견본 표

- `items`: `id`(영문 소문자·숫자·하이픈), `link`, `accent`(blue·aqua·lavender·coral·slate·yellow), `image`(같은 출처 경로), `starts_on`, `ends_on`, `deadline`(없으면 NULL).
- `item_texts`: `(item_id, locale)` 기본 키, `title`, `summary`, `place`, `body`. **ko 글이 있어야** 목록·상세에 나온다.
- 상태는 서버가 계산한다: 마감이 지났으면 `closed`, 7일 이내면 `closing`, 그 밖 `open`. **마감이 NULL 이면 끝나는 날 23:59:59(+09:00)를 마감으로 본다**(CONTRACT 에 정해지지 않은 부분의 템플릿 결정).
- `sessions`: `docs/AUTH.md` 3-1절.
