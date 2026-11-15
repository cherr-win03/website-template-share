// 주 주소 이동·출처/CSRF 검사·본문 크기·기능 스위치·속도 제한(CONTRACT 2·5절).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readJsonBody } from '../worker/http.js';
import { rateLimitDecision, rateLimitKey, rateLimitRule } from '../worker/rate-limit.js';
import { switchEnabled } from '../worker/switches.js';
import { authEnv, fakeRateLimiter, makeEnv, send, SITE, writeHeaders } from './helpers/worker-env.js';

describe('주 주소 이동(workers.dev → APP_ORIGIN)', () => {
  it('GET 은 301, 경로·검색어 유지', async () => {
    const response = await send(makeEnv(), 'https://my-site.acct.workers.dev/items?lang=ja');
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), `${SITE}/items?lang=ja`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
  it('POST 는 308(메서드·본문 유지)', async () => {
    const response = await send(makeEnv(), 'https://my-site.acct.workers.dev/api/auth/logout', { method: 'POST' });
    assert.equal(response.status, 308);
  });
  it('GET /api/health 는 옛 주소에서도 답한다', async () => {
    const response = await send(makeEnv(), 'https://my-site.acct.workers.dev/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
  it('로컬·주 주소·다른 도메인은 옮기지 않는다', async () => {
    assert.equal((await send(makeEnv({ APP_ORIGIN: 'http://127.0.0.1:8797' }), 'http://127.0.0.1:8797/api/health')).status, 200);
    assert.equal((await send(makeEnv(), 'http://localhost:8797/api/health')).status, 200);
    assert.equal((await send(makeEnv(), `${SITE}/api/health`)).status, 200);
  });
  it('APP_ORIGIN 이 https 가 아니거나 틀리면 옮기지 않는다', async () => {
    for (const origin of ['http://127.0.0.1:8790', 'not a url', '', 'https://site.example/path']) {
      const response = await send(makeEnv({ APP_ORIGIN: origin }), 'https://my-site.acct.workers.dev/api/health');
      assert.equal(response.status, 200, origin);
    }
  });
  it('APP_ORIGIN 자체가 workers.dev 면 그 주소로 들어온 요청은 그대로', async () => {
    const env = makeEnv({ APP_ORIGIN: 'https://my-site.acct.workers.dev' });
    assert.equal((await send(env, 'https://my-site.acct.workers.dev/api/health')).status, 200);
  });
});

describe('상태 변경 요청의 출처 검사', () => {
  const path = '/api/auth/email/start';
  const body = JSON.stringify({ email: 'a@example.test' });
  it('Origin 없음 → 403 INVALID_ORIGIN', async () => {
    const response = await send(authEnv(), path, { method: 'POST', headers: { 'x-site-request': '1', 'content-type': 'application/json' }, body });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'INVALID_ORIGIN' });
  });
  it('다른 Origin → 403 INVALID_ORIGIN', async () => {
    const response = await send(authEnv(), path, { method: 'POST', headers: writeHeaders({ origin: 'https://site.example.evil.test' }), body });
    assert.deepEqual(await response.json(), { error: 'INVALID_ORIGIN' });
  });
  it('Sec-Fetch-Site: cross-site → 403 INVALID_ORIGIN', async () => {
    const response = await send(authEnv(), path, { method: 'POST', headers: writeHeaders({ 'sec-fetch-site': 'cross-site' }), body });
    assert.deepEqual(await response.json(), { error: 'INVALID_ORIGIN' });
  });
  it('x-site-request 없음 → 403 INVALID_REQUEST', async () => {
    const response = await send(authEnv(), path, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
  });
  it('없는 API 라도 출처부터 본다(PUT·PATCH·DELETE)', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await send(makeEnv(), '/api/anything', { method });
      assert.deepEqual(await response.json(), { error: 'INVALID_ORIGIN' }, method);
    }
  });
  it('출처가 맞으면 다음 단계로(없는 API 404)', async () => {
    const response = await send(makeEnv(), '/api/anything', { method: 'POST', headers: writeHeaders(), body: '{}' });
    assert.equal(response.status, 404);
  });
  it('GET 은 출처를 보지 않는다', async () => {
    const response = await send(makeEnv(), '/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 200);
  });
});

describe('본문 읽기(16000바이트, JSON)', () => {
  const request = (body, headers = { 'content-type': 'application/json' }) => new Request(`${SITE}/x`, { method: 'POST', headers, body });
  it('정상 JSON', async () => assert.deepEqual(await readJsonBody(request('{"a":1}')), { a: 1 }));
  it('content-length 가 16000 넘으면 413', async () => {
    await assert.rejects(readJsonBody(request('{}', { 'content-type': 'application/json', 'content-length': '16001' })), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  });
  it('content-length 없이 실제로 16001바이트면 413', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(16000) });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } });
    const req = new Request(`${SITE}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
    await assert.rejects(readJsonBody(req), { code: 'PAYLOAD_TOO_LARGE' });
  });
  it('정확히 16000바이트는 받는다', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(16000 - 8) });
    assert.equal(new TextEncoder().encode(text).length, 16000);
    assert.equal((await readJsonBody(request(text))).a.length, 15992);
  });
  it('JSON 아님·빈 본문·content-type 다름 → 400 INVALID_JSON', async () => {
    await assert.rejects(readJsonBody(request('{bad')), { code: 'INVALID_JSON', status: 400 });
    await assert.rejects(readJsonBody(request('')), { code: 'INVALID_JSON' });
    await assert.rejects(readJsonBody(request('{"a":1}', { 'content-type': 'text/plain' })), { code: 'INVALID_JSON' });
    await assert.rejects(readJsonBody(request('{"a":1}', { 'content-type': 'application/jsonx' })), { code: 'INVALID_JSON' });
  });
  it('API 를 거쳐도 413·400 이 JSON 오류로 나온다', async () => {
    const env = authEnv();
    const big = await send(env, '/api/auth/email/start', { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ email: 'x'.repeat(17000) }) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: 'PAYLOAD_TOO_LARGE' });
    const bad = await send(env, '/api/auth/email/start', { method: 'POST', headers: writeHeaders(), body: 'not json' });
    assert.deepEqual(await bad.json(), { error: 'INVALID_JSON' });
  });
});

describe('기능 스위치 3상태', () => {
  it('없음·빈 값·disabled → 꺼짐, enabled → 켜짐', () => {
    for (const value of [undefined, null, '', 'disabled']) assert.equal(switchEnabled(value), false, String(value));
    assert.equal(switchEnabled('enabled'), true);
  });
  it('그 밖의 값은 503(추측하지 않는다)', () => {
    for (const value of ['true', 'on', 'Enabled', 'ENABLED', ' enabled', 'approved', '1']) {
      assert.throws(() => switchEnabled(value, 'X_MISCONFIGURED'), { status: 503, code: 'X_MISCONFIGURED' }, value);
    }
  });
  it('/api/auth/config: 꺼짐·켜짐·설정 오류', async () => {
    assert.deepEqual(await (await send(makeEnv(), '/api/auth/config')).json(), { enabled: false, methods: [] });
    assert.deepEqual(await (await send(makeEnv({ AUTH_ACTIVATION: undefined }), '/api/auth/config')).json(), { enabled: false, methods: [] });
    assert.deepEqual(await (await send(authEnv(), '/api/auth/config')).json(), { enabled: true, methods: ['email', 'google'] });
    const bad = await send(authEnv({ AUTH_ACTIVATION: 'on' }), '/api/auth/config');
    assert.equal(bad.status, 503);
    assert.deepEqual(await bad.json(), { error: 'AUTH_MISCONFIGURED' });
  });
  it('켜졌는데 필요한 값이 틀리면 503 AUTH_MISCONFIGURED', async () => {
    const broken = [
      { SUPABASE_URL: '' },
      { SUPABASE_URL: 'http://project.supabase.example' },
      { SUPABASE_URL: 'https://project.supabase.example/rest' },
      { SUPABASE_URL: 'http://127.0.0.1:54321' }, // 사이트가 https 인데 루프백 Supabase
      { SUPABASE_PUBLISHABLE_KEY: '' },
      { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnop' },
      { SUPABASE_PUBLISHABLE_KEY: `x.${Buffer.from('{"role":"service_role"}').toString('base64url')}.y` },
      { SESSION_ENCRYPTION_KEY: '' },
      { SESSION_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') },
      { AUTH_METHODS: '' },
      { AUTH_METHODS: 'email,Google!' },
      { DB: undefined },
      { APP_ORIGIN: 'http://site.example' },
    ];
    for (const override of broken) {
      const env = authEnv(override);
      if ('DB' in override) delete env.DB;
      const response = await send(env, '/api/auth/config');
      assert.equal(response.status, 503, JSON.stringify(override));
      assert.deepEqual(await response.json(), { error: 'AUTH_MISCONFIGURED' });
    }
  });
  it('로컬 개발: 사이트와 Supabase 가 둘 다 루프백이면 http 를 받는다', async () => {
    const env = authEnv({ APP_ORIGIN: 'http://127.0.0.1:8797', SUPABASE_URL: 'http://127.0.0.1:54321' });
    const response = await send(env, 'http://127.0.0.1:8797/api/auth/config');
    assert.deepEqual(await response.json(), { enabled: true, methods: ['email', 'google'] });
  });
});

describe('속도 제한', () => {
  it('범위: POST /api/auth/*(로그아웃 제외) + 소셜 콜백 GET', () => {
    assert.equal(rateLimitRule('/api/auth/email/start', 'POST')?.scope, 'auth');
    assert.equal(rateLimitRule('/api/auth/email/verify', 'POST')?.scope, 'auth');
    assert.equal(rateLimitRule('/api/auth/social/callback', 'GET')?.scope, 'auth');
    assert.equal(rateLimitRule('/api/auth/logout', 'POST'), null);
    assert.equal(rateLimitRule('/api/auth/me', 'GET'), null);
    assert.equal(rateLimitRule('/api/items', 'GET'), null);
  });
  it('바인딩이 없거나 던지면 허용(fail-open)', async () => {
    assert.equal((await rateLimitDecision({}, { path: '/api/auth/email/start', method: 'POST', address: '1.2.3.4' })).allowed, true);
    const throwing = { AUTH_RATE_LIMITER: { limit: async () => { throw new Error('down'); } } };
    assert.equal((await rateLimitDecision(throwing, { path: '/api/auth/email/start', method: 'POST', address: '1.2.3.4' })).allowed, true);
    const broken = { AUTH_RATE_LIMITER: { limit: 'nope' } };
    assert.equal((await rateLimitDecision(broken, { path: '/api/auth/email/start', method: 'POST', address: '1.2.3.4' })).allowed, true);
  });
  it('한도를 넘으면 429 RATE_LIMITED + retryAfter + retry-after 머리말', async () => {
    const limiter = fakeRateLimiter(2);
    const env = makeEnv({ AUTH_RATE_LIMITER: limiter });
    const go = () => send(env, '/api/auth/email/start', { method: 'POST', headers: writeHeaders({ 'cf-connecting-ip': '203.0.113.9' }), body: '{"email":"a@example.test"}' });
    assert.equal((await go()).status, 503); // 로그인 꺼짐 → AUTH_DISABLED(한도 안)
    assert.equal((await go()).status, 503);
    const limited = await go();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'RATE_LIMITED', retryAfter: 60 });
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual([...limiter.counts.keys()], ['auth:203.0.113.9']);
  });
  it('로그아웃은 한도를 받지 않는다', async () => {
    const limiter = fakeRateLimiter(0);
    const env = makeEnv({ AUTH_RATE_LIMITER: limiter });
    const response = await send(env, '/api/auth/logout', { method: 'POST', headers: writeHeaders(), body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(limiter.counts.size, 0);
  });
  it('IPv6 는 /64 로 묶고, IPv4-mapped 는 IPv4 로 본다', () => {
    assert.equal(rateLimitKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(rateLimitKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(rateLimitKey('[2001:db8::1]'), '2001:db8:0:0::/64');
    assert.equal(rateLimitKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(rateLimitKey('198.51.100.7'), '198.51.100.7');
    for (const bad of ['999.1.1.1', 'abc', '1:2:3', '1::2::3', null, undefined, '']) assert.equal(rateLimitKey(bad), 'anonymous', String(bad));
  });
  it('같은 /64 의 다른 주소는 같은 한도를 나눠 쓴다', async () => {
    const limiter = fakeRateLimiter(1);
    const env = { AUTH_RATE_LIMITER: limiter };
    const a = await rateLimitDecision(env, { path: '/api/auth/email/start', method: 'POST', address: '2001:db8:1:2::1' });
    const b = await rateLimitDecision(env, { path: '/api/auth/email/start', method: 'POST', address: '2001:db8:1:2::ffff' });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, false);
    assert.equal('key' in b, false);
  });
});
