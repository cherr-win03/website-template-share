// 응답 공통 도구: 보안 머리말, JSON 응답, 오류 형식, 본문 읽기, 캐시 규칙, 동적 HTML 압축.
// 약속 원본은 docs/CONTRACT.md 2·4절, 이유는 docs/SECURITY.md.

/** CONTRACT 4절의 CSP. 한 글자라도 바꾸면 docs/CONTRACT.md·docs/SECURITY.md·시험을 같이 바꾼다. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 모든 응답(정적·API·오류·리다이렉트)에 붙이는 머리말. HSTS 는 https 일 때만 따로 붙인다. */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
});
export const HSTS_VALUE = 'max-age=31536000';

/** 본문 한도(바이트). CONTRACT 2절. */
export const BODY_LIMIT_BYTES = 16000;

export const NO_STORE = 'private, no-store';

/** 오류 응답으로 바뀌는 예외. code 는 SCREAMING_SNAKE, 사람이 읽는 문구는 넣지 않는다. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {{retryAfter?: number, headers?: Record<string,string>}} [extra]
   */
  constructor(status, code, extra = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter;
    this.headers = extra.headers;
  }
}

/** @returns {never} */
export function fail(status, code, extra) {
  throw new HttpError(status, code, extra);
}

/**
 * JSON 응답. 캐시는 언제나 private, no-store. 429 는 retry-after 머리말을 같이 단다.
 * @param {unknown} data
 * @param {number} [status]
 * @param {HeadersInit} [extraHeaders]
 */
export function json(data, status = 200, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', NO_STORE);
  const retryAfter = data && typeof data === 'object' ? data.retryAfter : undefined;
  if (status === 429 && Number.isFinite(retryAfter)) headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
  return new Response(JSON.stringify(data), { status, headers });
}

/** HttpError → `{ error: CODE (, retryAfter) }` 응답. */
export function errorResponse(error) {
  const body = { error: error.code };
  if (Number.isFinite(error.retryAfter)) body.retryAfter = Math.max(1, Math.ceil(error.retryAfter));
  return json(body, error.status, error.headers);
}

/** 리다이렉트(언제나 no-store). */
export function redirect(location, status = 302, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('location', location);
  headers.set('cache-control', NO_STORE);
  return new Response(null, { status, headers });
}

/**
 * JSON 본문을 16000바이트까지 읽는다. content-type 이 application/json 이 아니거나 JSON 이 아니면 400 INVALID_JSON,
 * 넘으면 413 PAYLOAD_TOO_LARGE. content-length 를 믿지 않고 실제로 읽은 크기로도 자른다.
 * @param {Request} request
 * @param {number} [limit]
 */
export async function readJsonBody(request, limit = BODY_LIMIT_BYTES) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!/^application\/json\s*(?:;|$)/.test(type)) fail(400, 'INVALID_JSON');
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) fail(413, 'PAYLOAD_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_JSON');
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      fail(413, 'PAYLOAD_TOO_LARGE');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail(400, 'INVALID_JSON');
  }
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i;
const CODE_EXT = /\.(?:m?js|css)$/i;

/**
 * 응답 종류: html | code(JS·CSS) | font | image | other.
 * content-type 이 있으면 그것으로, 없으면(304 등) 경로 확장자로 고른다.
 */
export function assetKind(pathname, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type) {
    if (type.startsWith('text/html')) return 'html';
    if (type.startsWith('text/css') || type.includes('javascript')) return 'code';
    if (type.startsWith('font/woff2')) return 'font';
    if (type.startsWith('image/')) return 'image';
    return 'other';
  }
  const path = String(pathname || '');
  if (path.endsWith('/') || /\.html?$/i.test(path)) return 'html';
  if (CODE_EXT.test(path)) return 'code';
  if (/\.woff2$/i.test(path)) return 'font';
  if (IMAGE_EXT.test(path)) return 'image';
  if (!/\.[a-z0-9]+$/i.test(path.split('/').pop() || '')) return 'html';
  return 'other';
}

/**
 * 정적 응답의 Cache-Control (CONTRACT 4절).
 * - 200·304 만 저장 허용. 304 는 200 과 같은 정책(304 에 no-store 를 붙이면 브라우저가 캐시를 버린다). 리다이렉트는 no-store.
 * - HTML: private, no-cache, no-transform (no-transform = 엣지가 스크립트를 끼워 넣지 못하게).
 *   200·304 가 아닌 HTML(404 화면 등)도 no-transform 을 붙인다: private, no-store, no-transform.
 * - JS·CSS: private, no-cache(ETag 재검증). woff2: public, max-age=604800. 이미지: public, max-age=86400. 그 밖: private, no-store.
 * - 로그인 전 차단 경로(protectedPath)의 응답은 공유 캐시에 남지 않게 언제나 private, no-store(HTML 은 + no-transform).
 */
export function staticCacheControl(pathname, status, contentType, { protectedPath = false } = {}) {
  if (status >= 300 && status < 400 && status !== 304) return NO_STORE; // 리다이렉트(끝 슬래시 등)
  const kind = assetKind(pathname, contentType);
  const storable = status === 200 || status === 304;
  if (kind === 'html') return storable && !protectedPath ? 'private, no-cache, no-transform' : 'private, no-store, no-transform';
  if (!storable || protectedPath) return NO_STORE;
  if (kind === 'code') return 'private, no-cache';
  if (kind === 'font') return 'public, max-age=604800';
  if (kind === 'image') return 'public, max-age=86400';
  return NO_STORE;
}

/**
 * 응답에 보안 머리말을 붙인 새 응답. 이미 있던 같은 이름 머리말은 덮는다.
 * @param {Response} response
 * @param {URL} url 요청 주소(https 판단용)
 */
export function withSecurityHeaders(response, url) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', HSTS_VALUE);
  else headers.delete('Strict-Transport-Security');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Worker 가 직접 만든 동적 HTML 에만 쓰는 압축 머리말(정적 자산은 쓰지 않는다).
 * no-transform 이면 엣지가 압축도 하지 않으므로 Worker 가 gzip 을 고른다. Workers 런타임은 content-encoding: gzip 이 있으면
 * 본문을 스스로 압축한다. Cloudflare 는 Worker 에 넘기는 Accept-Encoding 을 바꾸고 원래 값을 request.cf.clientAcceptEncoding 에 두므로
 * cf 가 있으면 그 값만 본다. gzip;q=0 은 거절, '*'·x-gzip 은 압축하지 않는다.
 * @param {Request & {cf?: {clientAcceptEncoding?: string}}} request
 */
export function gzipHeaders(request) {
  const raw = request?.cf ? request.cf.clientAcceptEncoding : request?.headers?.get('accept-encoding');
  const accept = String(raw ?? '').toLowerCase();
  const gzip = accept.split(',').some((part) => {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const q = params.find((p) => p.startsWith('q='));
    return name === 'gzip' && !(q && Number(q.slice(2)) === 0);
  });
  return gzip ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } : { vary: 'Accept-Encoding' };
}

/**
 * 동적 HTML 응답(템플릿 기본 경로에는 없음. 서버에서 HTML 을 만드는 화면을 더할 때 쓴다).
 * no-transform 을 붙이고 압축은 gzipHeaders 로 직접 고른다.
 */
export function htmlResponse(html, request, status = 200) {
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store, no-transform',
      ...gzipHeaders(request),
    },
  });
}

/** 길이가 달라도 앞에서 처음 다른 위치에 따라 시간이 달라지지 않는 비교(CSRF·state). */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
