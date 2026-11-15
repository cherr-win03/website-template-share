// 로그인 전 차단(CONTRACT 3-3절). 서버가 막는다(화면에서 숨기는 것만으로 두지 않는다).
// - PROTECTED_PATHS(쉼표로 나눈 접두어, 없으면 기본값)에 걸리는 요청이 로그인 전이면
//   /api/* → 401 SIGN_IN_REQUIRED, 페이지 GET·HEAD → 302 /login/?returnTo=…, 그 밖 → 303 같은 곳.
// - 비교는 정규화 경로끼리, 구간 경계로 한다(path.js). `/members/` 는 `/Members`·`/members//x`·`/%6dembers/` 에도 걸린다.
// - 로그인이 꺼져 있거나 설정이 틀리면 아무도 로그인 상태가 아니므로 보호 경로는 언제나 막힌다(실패 시 닫힘).
// - 설정값 자체가 틀리면(상대 경로, `/` 전체, 로그인 경로를 덮는 값) 모든 요청을 503 으로 닫는다.
import { fail, json, redirect } from '../http.js';
import { normalizePath, pathHasPrefix, safeReturnTo } from '../path.js';
import { signedInUser } from './current.js';

export const DEFAULT_PROTECTED_PATHS = '/members/,/api/members/';
// 막으면 로그인 자체를 할 수 없는 경로. 이것을 덮거나 그 안을 가리키는 접두어는 설정 오류다.
const RESERVED = ['/login', '/api/auth', '/api/health'];

/** PROTECTED_PATHS → 정규화한 접두어 목록. 틀린 값이면 503 SERVICE_UNAVAILABLE. */
export function protectedPrefixes(env) {
  const raw = env?.PROTECTED_PATHS === undefined || env?.PROTECTED_PATHS === null ? DEFAULT_PROTECTED_PATHS : String(env.PROTECTED_PATHS);
  const prefixes = [];
  for (const entry of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const prefix = normalizePath(entry);
    const invalid = !entry.startsWith('/') || prefix === '/' || RESERVED.some((reserved) => pathHasPrefix(reserved, prefix) || pathHasPrefix(prefix, reserved));
    if (invalid) {
      console.error('SITE_CONFIG_INVALID', 'PROTECTED_PATHS');
      fail(503, 'SERVICE_UNAVAILABLE');
    }
    prefixes.push(prefix);
  }
  return [...new Set(prefixes)];
}

export function isProtectedPath(path, prefixes) {
  return prefixes.some((prefix) => pathHasPrefix(path, prefix));
}

/** 로그인 전 요청에 줄 응답. */
export function signInRequired(ctx) {
  if (pathHasPrefix(ctx.path, '/api')) return json({ error: 'SIGN_IN_REQUIRED' }, 401);
  const returnTo = safeReturnTo(`${ctx.url.pathname}${ctx.url.search}`);
  const location = `/login/?${new URLSearchParams({ returnTo })}`;
  return redirect(location, ctx.method === 'GET' || ctx.method === 'HEAD' ? 302 : 303);
}

/**
 * 보호 경로가 아니거나 로그인했으면 null(ctx.user 에 사용자), 아니면 막는 응답.
 * @param {any} ctx 요청 문맥(app.js)
 * @param {string[]} prefixes protectedPrefixes 결과
 */
export async function gate(ctx, prefixes) {
  if (!isProtectedPath(ctx.path, prefixes)) return null;
  ctx.protectedPath = true;
  let user = null;
  try {
    user = await signedInUser(ctx);
  } catch (error) {
    // 세션 확인 중 오류(D1 장애 등)도 로그인 안 한 것으로 본다(닫힌 쪽).
    console.error('SITE_GATE_CHECK_FAILED', error?.name || 'Error');
    user = null;
  }
  if (user) {
    ctx.user = user;
    return null;
  }
  return signInRequired(ctx);
}
