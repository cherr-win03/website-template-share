-- 견본 항목(목록·상세). 화면 약속은 docs/CONTRACT.md 3-1절.
-- 언어별 글은 item_texts 에 둔다. ko 글은 반드시 있어야 목록·상세에 나온다(다른 언어가 없으면 ko 로 채운다).
-- 날짜: starts_on·ends_on = 'YYYY-MM-DD', deadline = 'YYYY-MM-DDTHH:mm:ss+09:00'(언제나 같은 길이·같은 시간대라 문자열 비교 = 시간 비교).
-- 주의(D1): LIKE/GLOB 패턴은 50바이트까지라 날짜 형식 검사를 GLOB 대신 date()·datetime()·length() 로 한다. docs/D1_RULES.md.
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9-]*' AND substr(id, 1, 1) <> '-'),
  link TEXT,
  accent TEXT NOT NULL DEFAULT 'blue'
    CHECK (accent IN ('blue', 'aqua', 'lavender', 'coral', 'slate', 'yellow')),
  image TEXT,
  starts_on TEXT NOT NULL CHECK (date(starts_on) IS starts_on),
  ends_on TEXT NOT NULL CHECK (date(ends_on) IS ends_on AND ends_on >= starts_on),
  deadline TEXT CHECK (
    deadline IS NULL OR (
      length(deadline) = 25
      AND substr(deadline, 11, 1) = 'T'
      AND substr(deadline, 20) = '+09:00'
      AND datetime(substr(deadline, 1, 19)) IS replace(substr(deadline, 1, 19), 'T', ' ')
    )
  )
);

CREATE TABLE item_texts (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'ja', 'en')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (item_id, locale)
);
