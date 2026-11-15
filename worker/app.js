// 요청 처리 흐름(진입점 index.js 가 부른다. 시험은 이 함수를 fetch·시계를 바꿔 부른다).
//   요청 → 경로 정규화 → 주 주소 이동(workers.dev → APP_ORIGIN)
//        → /api/*: 출처 검사(상태 변경) → 빈도 제한 → 로그인 전 차단 → CSRF(로그인 상태의 상태 변경) → 라우팅
//        → 페이지: 로그인 전 차단 → GET·HEAD 만 → ASSETS(public/) 위임
//        → 모든 응답에 보안 머리말·캐시 규칙(finalize)
// 오류는 언제나 { error: CODE }. 모르는 오류는 503 SERVICE_UNAVAILABLE, 로그에는 경로 묶음 이름과 오류 종류만 남긴다.
import { CSRF_EXEMPT_PATHS, handleAuth } from './auth/routes.js';
import { rawSession } from './auth/current.js';
import { gate, protectedPrefixes } from './auth/gate.js';
import { SESSION_COOKIE } from './auth/session.js';
import { errorResponse, fail, HttpError, json, NO_STORE, staticCacheControl, withSecurityHeaders } from './http.js';
import { handleItems } from './items.js';
import { handleMembers } from './members.js';
import { assertCsrf, assertWriteOrigin, canonicalRedirect, WRITE_METHODS } from './origin.js';
import { normalizePath, pathHasPrefix } from './path.js';
import { rateLimitDecision } from './rate-limit.js';

/** 경로 묶음 이름(로그용). 사용자가 넣은 경로 원문·검색어는 로그에 남기지 않는다. */
function routeLabel(path) {
  if (!pathHasPrefix(path, '/api')) return 'page';
  const parts = path.split('/').filter(Boolean).slice(0, 3);
  return /^[a-z-]+$/.test(parts[1] || '') ? parts.slice(0, parts[1] === 'auth' ? 3 : 2).join('/') : 'api';
}

async function health(ctx) {
  if (ctx.path !== '/api/health') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', { headers: { allow: 'GET, HEAD' } });
  return json({ ok: true });
}

// 새 API 는 여기에 더한다. 각 처리기는 자기 경로가 아니면 null 을 돌려준다.
const API_HANDLERS = [health, handleItems, handleAuth, handleMembers];

async function handleApi(ctx, prefixes) {
  const { request, env, method, path } = ctx;
  if (WRITE_METHODS.has(method)) assertWriteOrigin(request, env);
  const rate = await rateLimitDecision(env, { path, method, address: request.headers.get('cf-connecting-ip') });
  if (!rate.allowed) fail(429, 'RATE_LIMITED', { retryAfter: rate.retryAfter });
  const blocked = await gate(ctx, prefixes);
  if (blocked) return blocked;
  if (WRITE_METHODS.has(method) && !CSRF_EXEMPT_PATHS.has(path)) {
    const session = await rawSession(ctx);
    if (session) assertCsrf(request, session.csrf);
  }
  for (const handler of API_HANDLERS) {
    const response = await handler(ctx);
    if (response) return response;
  }
  return fail(404, 'NOT_FOUND');
}

async function handlePage(ctx, prefixes) {
  const blocked = await gate(ctx, prefixes);
  if (blocked) return blocked;
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', { headers: { allow: 'GET, HEAD' } });
  if (!ctx.env?.ASSETS || typeof ctx.env.ASSETS.fetch !== 'function') fail(503, 'SERVICE_UNAVAILABLE');
  ctx.asset = true;
  return ctx.env.ASSETS.fetch(ctx.request);
}

/** 쿠키·캐시·HEAD 본문·보안 머리말을 마무리한다. 어떤 응답도 이 함수를 거치지 않고 나가지 않는다. */
function finalize(response, ctx) {
  const headers = new Headers(response.headers);
  const setsSession = (headers.get('set-cookie') || '').includes(`${SESSION_COOKIE}=`);
  for (const cookie of ctx.setCookies) if (!setsSession) headers.append('set-cookie', cookie);
  if (ctx.asset) {
    headers.set('cache-control', staticCacheControl(ctx.url.pathname, response.status, headers.get('content-type'), { protectedPath: ctx.protectedPath }));
  } else if (!headers.has('cache-control')) {
    headers.set('cache-control', NO_STORE);
  }
  if (/^text\/html/i.test(headers.get('content-type') || '') && !/no-transform/.test(headers.get('cache-control'))) {
    headers.set('cache-control', `${headers.get('cache-control')}, no-transform`);
  }
  const nullBody = ctx.method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
  const shaped = new Response(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers });
  return withSecurityHeaders(shaped, ctx.url);
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{waitUntil?: (promise: Promise<unknown>) => void} | undefined} executionContext
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [deps] 시험에서만 바꾼다
 */
export async function handleRequest(request, env, executionContext, deps = {}) {
  const url = new URL(request.url);
  const ctx = {
    request,
    env: env || {},
    url,
    method: request.method.toUpperCase(),
    path: normalizePath(url.pathname),
    now: (deps.now || Date.now)(),
    fetchImpl: deps.fetchImpl || ((...args) => globalThis.fetch(...args)),
    waitUntil: (promise) => {
      if (typeof executionContext?.waitUntil === 'function') executionContext.waitUntil(promise);
    },
    setCookies: [],
    cache: {},
    protectedPath: false,
    asset: false,
    user: null,
  };
  let response;
  try {
    response = canonicalRedirect(request, url, ctx.env);
    if (!response) {
      const prefixes = protectedPrefixes(ctx.env);
      response = pathHasPrefix(ctx.path, '/api') ? await handleApi(ctx, prefixes) : await handlePage(ctx, prefixes);
    }
  } catch (error) {
    ctx.asset = false;
    if (error instanceof HttpError) {
      response = errorResponse(error);
    } else {
      // 본문·쿠키·이메일·토큰·외부 응답 문구는 남기지 않는다.
      console.error('SITE_ERROR', routeLabel(ctx.path), error?.name || 'Error');
      response = json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }
  return finalize(response, ctx);
}
