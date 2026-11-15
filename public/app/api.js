// 같은 출처 fetch 한 곳. 오류는 ApiError(code) 로 던진다. 문구는 messages.js 의 error.<CODE>.
import { t, getLocale } from './i18n.js';
import { ERROR_CODES } from './messages.js';

export class ApiError extends Error {
  constructor(code, status = 0, retryAfter = null) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

let csrfToken = null;
export function setCsrf(value) {
  csrfToken = typeof value === 'string' && value ? value : null;
}

// 오류 → 사람이 읽는 문구(현재 언어). 모르는 코드는 UNKNOWN
export function errorText(error) {
  const code = error instanceof ApiError ? error.code : typeof error === 'string' ? error : 'UNKNOWN';
  const key = ERROR_CODES.includes(code) ? `error.${code}` : 'error.UNKNOWN';
  let text = t(key);
  if (error instanceof ApiError && Number.isFinite(error.retryAfter) && error.retryAfter > 0) {
    text += ` ${t('error.retryAfter', { n: Math.ceil(error.retryAfter) })}`;
  }
  return text;
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', signal };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-site-request'] = '1';
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await globalThis.fetch(path, init);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : response.status === 401 ? 'SIGN_IN_REQUIRED' : 'SERVICE_UNAVAILABLE';
    throw new ApiError(code, response.status, typeof data?.retryAfter === 'number' ? data.retryAfter : null);
  }
  return data;
}

const lang = () => encodeURIComponent(getLocale());

export const getItems = (signal) => api(`/api/items?lang=${lang()}`, { signal }).then((d) => d.items);
export const getItem = (id, signal) => api(`/api/items/${encodeURIComponent(id)}?lang=${lang()}`, { signal }).then((d) => d.item);
export const getAuthConfig = (signal) => api('/api/auth/config', { signal });
export const getMe = (signal) => api('/api/auth/me', { signal });
export const startEmail = (email) => api('/api/auth/email/start', { method: 'POST', body: { email } });
export const verifyEmail = (email, code, returnTo) => api('/api/auth/email/verify', { method: 'POST', body: { email, code, returnTo } });
export const logout = () => api('/api/auth/logout', { method: 'POST', body: {} });
export const getMembersHello = (signal) => api('/api/members/hello', { signal });

// returnTo: '/' 로 시작하는 같은 사이트 경로만. 아니면 '/'
export function safeReturnTo(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /^\/[a-z][a-z0-9+.-]*:/i.test(value)) return '/';
  return value;
}
