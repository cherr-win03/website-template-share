// 경로 정규화와 같은 사이트 returnTo 안전화.

const MAX_DECODE_ROUNDS = 3;

/**
 * 로그인 전 차단·API 라우팅에 쓰는 정규화 경로.
 * 퍼센트 인코딩을 (이중 인코딩까지) 풀고, 백슬래시를 슬래시로, 빈 구간·`.` 은 버리고 `..` 은 한 단계 올리고, 소문자로 바꾼다.
 * 끝 슬래시는 남기지 않는다(`/members/` → `/members`). 잘못된 인코딩은 그 단계의 원문으로 계속 비교한다.
 * 차단 판정과 라우팅이 같은 함수를 써야 우회가 생기지 않는다.
 * @param {string} pathname
 */
export function normalizePath(pathname) {
  let decoded = String(pathname ?? '');
  for (let round = 0; round < MAX_DECODE_ROUNDS && decoded.includes('%'); round += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const segments = [];
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

/**
 * `prefix` 가 정규화 경로 `path` 의 구간 경계 접두어인지. `/members` 는 `/members`·`/members/x` 에 맞고 `/membersx` 에는 안 맞는다.
 * @param {string} path normalizePath 결과
 * @param {string} prefix normalizePath 결과
 */
export function pathHasPrefix(path, prefix) {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

const PLACEHOLDER_ORIGIN = 'https://return-to.invalid';

/**
 * 로그인 뒤 돌아갈 곳. `/` 로 시작하는 같은 사이트 경로만 받고 나머지는 `/`.
 * `//host`, `/\host`, 스킴(`javascript:` 등), 제어 문자, 2048자 넘는 값은 `/` 로 바꾼다.
 * @param {unknown} value
 */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  let parsed;
  try {
    parsed = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return '/';
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return '/';
  const result = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return result.startsWith('/') && !result.startsWith('//') ? result : '/';
}
