// 보안 머리말·캐시 규칙·no-transform·동적 HTML 압축(CONTRACT 4절, docs/SECURITY.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import worker from '../worker/index.js';
import * as entry from '../worker/index.js';
import { CONTENT_SECURITY_POLICY, gzipHeaders, htmlResponse, staticCacheControl } from '../worker/http.js';
import { authEnv, makeEnv, seededD1, send, SITE, writeHeaders } from './helpers/worker-env.js';

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function assertSecurityHeaders(response, { https = true } = {}) {
  const h = response.headers;
  assert.equal(h.get('content-security-policy'), EXPECTED_CSP);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(h.get('strict-transport-security'), https ? 'max-age=31536000' : null);
}

describe('보안 머리말', () => {
  it('CSP 상수는 CONTRACT 4절 값과 글자까지 같다', () => {
    assert.equal(CONTENT_SECURITY_POLICY, EXPECTED_CSP);
    const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
    assert.ok(contract.includes(`Content-Security-Policy: ${EXPECTED_CSP}`), 'docs/CONTRACT.md 의 CSP 줄과 다르다');
  });

  const cases = [
    ['정적 HTML', '/', {}, 200],
    ['정적 JS', '/app/site.js', {}, 200],
    ['정적 CSS', '/design/base.css', {}, 200],
    ['글꼴', '/design/fonts/pretendard/pretendard-variable-subset-0.woff2', {}, 200],
    ['이미지', '/samples/poster-1.svg', {}, 200],
    ['없는 정적 경로(404 화면)', '/nope', {}, 404],
    ['API JSON', '/api/health', {}, 200],
    ['API 오류(없는 API)', '/api/nope', {}, 404],
    ['API 오류(403 출처)', '/api/auth/logout', { method: 'POST' }, 403],
    ['로그인 전 차단 리다이렉트', '/members/', {}, 302],
    ['로그인 전 차단 401', '/api/members/hello', {}, 401],
    ['페이지 405', '/', { method: 'POST' }, 405],
    ['정적 자산 리다이렉트(끝 슬래시)', '/login', {}, 307],
  ];
  for (const [name, path, init, status] of cases) {
    it(`${name}: ${status} + 머리말 전부`, async () => {
      const response = await send(makeEnv({ DB: seededD1() }), path, init);
      assert.equal(response.status, status);
      assertSecurityHeaders(response);
    });
  }

  it('주 주소 이동(301)에도 붙는다', async () => {
    const response = await send(makeEnv(), 'https://my-site.someone.workers.dev/x?y=1');
    assert.equal(response.status, 301);
    assertSecurityHeaders(response);
  });

  it('알 수 없는 오류(503)에도 붙는다', async () => {
    const response = await send(makeEnv({ ASSETS: { fetch: async () => { throw new Error('boom'); } } }), '/');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
    assertSecurityHeaders(response);
  });

  it('로그인 설정 오류(503 AUTH_MISCONFIGURED)에도 붙는다', async () => {
    const response = await send(authEnv({ AUTH_ACTIVATION: 'yes' }), '/api/auth/config');
    assert.equal(response.status, 503);
    assertSecurityHeaders(response);
  });

  it('HSTS 는 https 일 때만', async () => {
    const env = makeEnv({ APP_ORIGIN: 'http://127.0.0.1:8797' });
    const local = await send(env, 'http://127.0.0.1:8797/api/health');
    assertSecurityHeaders(local, { https: false });
    const secure = await send(makeEnv(), '/api/health');
    assertSecurityHeaders(secure, { https: true });
  });

  it('ASSETS 가 준 같은 이름 머리말도 덮어쓴다', async () => {
    const assets = { fetch: async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src *" } }) };
    const response = await send(makeEnv({ ASSETS: assets }), '/');
    assertSecurityHeaders(response);
  });

  it('진입 모듈은 기본 내보내기(fetch) 하나만 둔다', () => {
    assert.deepEqual(Object.keys(entry), ['default']);
    assert.deepEqual(Object.keys(worker), ['fetch']);
  });
});

describe('캐시 규칙', () => {
  const env = () => makeEnv({ DB: seededD1() });
  it('HTML 200 은 private, no-cache, no-transform', async () => {
    const response = await send(env(), '/');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, no-transform');
  });
  it('404 화면(HTML)도 no-transform, 저장은 안 함', async () => {
    const response = await send(env(), '/missing-page');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
  });
  it('JS·CSS 는 private, no-cache', async () => {
    assert.equal((await send(env(), '/app/site.js')).headers.get('cache-control'), 'private, no-cache');
    assert.equal((await send(env(), '/design/base.css')).headers.get('cache-control'), 'private, no-cache');
  });
  it('woff2 는 public, max-age=604800', async () => {
    const response = await send(env(), '/design/fonts/pretendard/pretendard-variable-subset-0.woff2');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=604800');
  });
  it('이미지는 public, max-age=86400', async () => {
    assert.equal((await send(env(), '/samples/poster-1.svg')).headers.get('cache-control'), 'public, max-age=86400');
  });
  it('그 밖(version.json)은 private, no-store', async () => {
    assert.equal((await send(env(), '/version.json')).headers.get('cache-control'), 'private, no-store');
  });
  it('304 는 200 과 같은 정책(content-type 이 없어도 경로로 판단)', async () => {
    const first = await send(env(), '/app/site.js');
    const etag = first.headers.get('etag');
    const second = await send(env(), '/app/site.js', { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get('cache-control'), 'private, no-cache');
    const home = await send(env(), '/');
    const homeAgain = await send(env(), '/', { headers: { 'if-none-match': home.headers.get('etag') } });
    assert.equal(homeAgain.status, 304);
    assert.equal(homeAgain.headers.get('cache-control'), 'private, no-cache, no-transform');
  });
  it('API JSON 은 private, no-store + JSON 형식', async () => {
    const response = await send(env(), '/api/items');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });
  it('리다이렉트는 private, no-store', async () => {
    assert.equal((await send(env(), '/members/')).headers.get('cache-control'), 'private, no-store');
    assert.equal((await send(env(), '/login')).headers.get('cache-control'), 'private, no-store');
  });
  it('staticCacheControl 표', () => {
    assert.equal(staticCacheControl('/x/', 200, 'text/html'), 'private, no-cache, no-transform');
    assert.equal(staticCacheControl('/x/a.png', 500, 'image/png'), 'private, no-store');
    assert.equal(staticCacheControl('/a.woff2', 304, null), 'public, max-age=604800');
    assert.equal(staticCacheControl('/a.json', 200, 'application/json'), 'private, no-store');
    // 보호 경로는 공유 캐시에 남지 않게
    assert.equal(staticCacheControl('/members/a.png', 200, 'image/png', { protectedPath: true }), 'private, no-store');
    assert.equal(staticCacheControl('/members/', 200, 'text/html', { protectedPath: true }), 'private, no-store, no-transform');
  });
});

describe('동적 HTML 압축(gzipHeaders·htmlResponse)', () => {
  const req = (accept, cf) => {
    const request = new Request(`${SITE}/x`, { headers: accept === undefined ? {} : { 'accept-encoding': accept } });
    if (cf !== undefined) Object.defineProperty(request, 'cf', { value: cf });
    return request;
  };
  it('gzip 을 받으면 content-encoding: gzip', () => {
    assert.deepEqual(gzipHeaders(req('gzip, deflate, br')), { 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
  });
  it('gzip;q=0·*·x-gzip·없음은 압축하지 않는다', () => {
    for (const accept of ['gzip;q=0', '*', 'x-gzip', 'br', undefined]) assert.deepEqual(gzipHeaders(req(accept)), { vary: 'Accept-Encoding' }, String(accept));
  });
  it('cf 가 있으면 clientAcceptEncoding 만 본다(머리말은 엣지가 바꾼 값)', () => {
    assert.deepEqual(gzipHeaders(req('br, gzip', { clientAcceptEncoding: '' })), { vary: 'Accept-Encoding' });
    assert.deepEqual(gzipHeaders(req('br', { clientAcceptEncoding: 'gzip' })), { 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
  });
  it('htmlResponse 는 no-transform + 압축 머리말, HEAD 는 본문 없음', async () => {
    const response = htmlResponse('<p>hi</p>', req('gzip'));
    assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const head = htmlResponse('<p>hi</p>', new Request(`${SITE}/x`, { method: 'HEAD' }));
    assert.equal(await head.text(), '');
  });
});

describe('HEAD', () => {
  it('API HEAD 는 GET 과 같은 상태·머리말, 본문 없음', async () => {
    const response = await send(makeEnv({ DB: seededD1() }), '/api/items', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });
  it('보호 API HEAD 는 401 본문 없음', async () => {
    const response = await send(makeEnv(), '/api/members/hello', { method: 'HEAD' });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), '');
  });
  it('쓰기 요청 오류도 JSON 형식', async () => {
    const response = await send(makeEnv(), '/api/auth/email/start', { method: 'POST', headers: writeHeaders({ origin: 'https://evil.example' }), body: '{}' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'INVALID_ORIGIN' });
  });
});
