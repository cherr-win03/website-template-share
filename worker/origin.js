// 출처 확인: 주 주소 이동, 상태 변경 요청의 Origin·x-site-request 검사, 로그인 상태의 CSRF 검사(CONTRACT 2절).
import { constantTimeEqual, fail, NO_STORE } from './http.js';

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** APP_ORIGIN 을 `scheme://host(:port)` 모양으로. 쓸 수 없는 값이면 null. 로컬 개발용 http 는 루프백 주소만 받는다. */
export function appOrigin(env) {
  const value = typeof env?.APP_ORIGIN === 'string' ? env.APP_ORIGIN.trim().replace(/\/$/, '') : '';
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.protocol === 'https:') return HTTPS_ORIGIN.test(value) ? value : null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return value;
  return null;
}

export function isLoopbackOrigin(origin) {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * 주 주소 이동. `*.workers.dev` 로 들어왔고 APP_ORIGIN(https)의 호스트와 다르면 경로·검색어를 그대로 붙여 옮긴다.
 * GET·HEAD 는 301, 그 밖은 308(메서드·본문 유지). 로컬(127.0.0.1·localhost)·주 주소·사용자 도메인은 그대로 둔다.
 * 예외: GET·HEAD /api/health 는 옛 주소에서도 답한다(배포 뒤 점검용, 자료 없는 고정 응답).
 * 이동은 no-store(도메인을 되돌릴 때 브라우저가 옛 이동을 기억하지 않게).
 * @param {Request} request
 * @param {URL} url
 * @param {Record<string, any>} env
 * @returns {Response | null}
 */
export function canonicalRedirect(request, url, env) {
  const target = appOrigin(env);
  if (!target || !target.startsWith('https://')) return null;
  if (!url.hostname.endsWith('.workers.dev')) return null;
  if (new URL(target).host === url.host) return null;
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  if (readOnly && url.pathname === '/api/health') return null;
  return new Response(null, {
    status: readOnly ? 301 : 308,
    headers: { location: `${target}${url.pathname}${url.search}`, 'cache-control': NO_STORE },
  });
}

/**
 * 상태 변경 요청(POST·PUT·PATCH·DELETE /api/*)의 출처 검사.
 * Origin 이 APP_ORIGIN 과 다르면 403 INVALID_ORIGIN, x-site-request: 1 이 없으면 403 INVALID_REQUEST.
 * Sec-Fetch-Site 가 cross-site·none 이면 Origin 이 맞아도 INVALID_ORIGIN(위조 머리말이 아닌 브라우저의 판정).
 * @param {Request} request
 * @param {Record<string, any>} env
 */
export function assertWriteOrigin(request, env) {
  const expected = appOrigin(env);
  const origin = request.headers.get('origin');
  if (!expected || !origin || origin !== expected) fail(403, 'INVALID_ORIGIN');
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'none') fail(403, 'INVALID_ORIGIN');
  if (request.headers.get('x-site-request') !== '1') fail(403, 'INVALID_REQUEST');
}

/**
 * 로그인 상태의 상태 변경 요청은 x-csrf-token 이 세션의 csrf 와 같아야 한다(다르면 403 INVALID_CSRF).
 * @param {Request} request
 * @param {string} expected 세션에 저장한 csrf
 */
export function assertCsrf(request, expected) {
  const token = request.headers.get('x-csrf-token');
  if (!expected || !token || !constantTimeEqual(token, expected)) fail(403, 'INVALID_CSRF');
}
