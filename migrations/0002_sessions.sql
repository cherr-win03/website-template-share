-- 로그인 세션(선택 모듈, docs/AUTH.md). 로그인을 켜지 않아도 표는 만들어 두며 비어 있다.
-- id      = 쿠키 값(무작위 32바이트)의 SHA-256 hex. 쿠키 원문은 저장하지 않는다.
-- data    = 세션 내용(사용자·Supabase 토큰)을 SESSION_ENCRYPTION_KEY 로 AES-GCM 암호화한 문자열.
-- csrf    = 상태 변경 요청의 x-csrf-token 비교 값.
-- 시각은 정수 ms(Date.now()). 로그아웃 = 행 삭제.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 64),
  data TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 만료 세션 정리(DELETE ... WHERE expires_at <= ?)가 표 전체를 훑지 않게.
CREATE INDEX sessions_expires_at ON sessions (expires_at);
