// Worker 시험 도구: 가짜 env(D1·ASSETS·ratelimit), 요청 보내기, 쿠키 모음.
// 실제 비밀값은 쓰지 않는다. 아래 키·주소는 모두 시험 전용 가짜 값이다.
import { handleRequest } from '../../worker/app.js';
import { buildSeedSql } from '../../scripts/seed-local.mjs';
import { createFakeD1 } from './fake-d1.js';

export const SITE = 'https://site.example';
export const SUPABASE = 'https://project.supabase.example';
// 32바이트 시험용 키(base64). 운영 값이 아니다.
export const TEST_SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
export const OTHER_SESSION_KEY = Buffer.alloc(32, 9).toString('base64');

/** 2026-11-14 12:00 KST 고정 시계(기본값). */
export const FIXED_NOW = Date.parse('2026-11-14T12:00:00+09:00');

const FILES = {
  '/index.html': ['text/html; charset=utf-8', '<!doctype html><title>home</title>'],
  '/login/index.html': ['text/html; charset=utf-8', '<!doctype html><title>login</title>'],
  '/members/index.html': ['text/html; charset=utf-8', '<!doctype html><title>members</title>'],
  '/404.html': ['text/html; charset=utf-8', '<!doctype html><title>not found</title>'],
  '/app/site.js': ['text/javascript; charset=utf-8', 'export {};'],
  '/design/base.css': ['text/css; charset=utf-8', 'body{}'],
  '/design/fonts/pretendard/pretendard-variable-subset-0.woff2': ['font/woff2', 'woff2'],
  '/samples/poster-1.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  '/members/secret.png': ['image/png', 'png'],
  '/version.json': ['application/json', '{"commit":"test"}'],
};

/** Workers 정적 자산 흉내(html_handling auto-trailing-slash, not_found_handling 404-page, ETag·304). */
export function fakeAssets() {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);
      let path = url.pathname;
      if (path.endsWith('/')) path += 'index.html';
      if (!FILES[path] && FILES[`${path}/index.html`]) return new Response(null, { status: 307, headers: { location: `${url.pathname}/` } });
      const file = FILES[path];
      if (!file) return new Response(FILES['/404.html'][1], { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const etag = `"${Buffer.from(path).toString('hex').slice(0, 16)}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(file[1], { status: 200, headers: { 'content-type': file[0], etag, 'cache-control': 'public, max-age=0, must-revalidate' } });
    },
  };
}

/** 키마다 limit 번까지 허용하는 가짜 ratelimit 바인딩. */
export function fakeRateLimiter(limit = 30) {
  const counts = new Map();
  return {
    counts,
    async limit({ key }) {
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

/** 시드 6개를 넣은 가짜 D1. */
export function seededD1(today = '2026-11-14', options = {}) {
  const d1 = createFakeD1(options);
  d1.sqlite.exec(buildSeedSql(today));
  d1.log.length = 0;
  return d1;
}

export function makeEnv(overrides = {}) {
  return {
    APP_ORIGIN: SITE,
    AUTH_ACTIVATION: 'disabled',
    AUTH_METHODS: 'email,google',
    PROTECTED_PATHS: '/members/,/api/members/',
    SUPABASE_URL: '',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_fake_key',
    SESSION_ENCRYPTION_KEY: TEST_SESSION_KEY,
    DB: overrides.DB ?? createFakeD1(),
    ASSETS: overrides.ASSETS ?? fakeAssets(),
    ...overrides,
  };
}

export function authEnv(overrides = {}) {
  return makeEnv({ AUTH_ACTIVATION: 'enabled', SUPABASE_URL: SUPABASE, ...overrides });
}

/**
 * 요청 하나 보내기.
 * @param {Record<string, any>} env
 * @param {string} path 경로 또는 전체 주소
 * @param {RequestInit & {deps?: object, waitUntil?: any[]}} [init]
 */
export async function send(env, path, init = {}) {
  const { deps = {}, waitUntil, ...requestInit } = init;
  const url = /^https?:/.test(path) ? path : `${env.APP_ORIGIN || SITE}${path}`;
  const request = new Request(url, requestInit);
  const pending = waitUntil || [];
  const response = await handleRequest(request, env, { waitUntil: (promise) => pending.push(promise) }, { now: () => FIXED_NOW, ...deps });
  await Promise.allSettled(pending);
  return response;
}

/** 상태 변경 요청에 필요한 머리말(Origin + x-site-request + JSON). */
export function writeHeaders(extra = {}) {
  return { origin: SITE, 'x-site-request': '1', 'content-type': 'application/json', ...extra };
}

/** 아주 단순한 쿠키 모음(Set-Cookie → Cookie). Max-Age=0 이면 지운다. */
export class CookieJar {
  constructor() {
    this.values = new Map();
  }
  take(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (attributes.some((attribute) => /^max-age=0$/i.test(attribute)) || value === '') this.values.delete(name);
      else this.values.set(name, value);
    }
    return response;
  }
  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  get(name) {
    return this.values.get(name);
  }
}
