// 로그인 선택 모듈: 세션 암복호화·변조 거부·만료, 이메일 코드 흐름, 소셜 PKCE 흐름, 토큰 갱신, 로그아웃 뒤 같은 쿠키 거부(CONTRACT 3-2절).
// Supabase 는 scripts/fake-supabase.mjs 를 fetch 대신 넣어 쓴다(포트·네트워크 없음).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFakeSupabase } from '../scripts/fake-supabase.mjs';
import { database } from '../worker/db.js';
import {
  createSession,
  decryptJson,
  encryptJson,
  readSession,
  SESSION_COOKIE,
  sessionKeyBytes,
} from '../worker/auth/session.js';
import { normalizeEmail, publishableKey, supabaseOrigin, userFields } from '../worker/auth/supabase.js';
import { createFakeD1 } from './helpers/fake-d1.js';
import { authEnv, CookieJar, FIXED_NOW, OTHER_SESSION_KEY, send, SITE, SUPABASE, TEST_SESSION_KEY, writeHeaders } from './helpers/worker-env.js';

const EMAIL = 'member@example.test';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 로그에 이메일·토큰·Supabase 문구가 남지 않는지 보려고 console.error 를 모은다. */
let logged = [];
let originalError;
beforeEach(() => {
  logged = [];
  originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
});
afterEach(() => {
  console.error = originalError;
});

function setup({ ttl = 3600, env: overrides = {}, fetchWrap } = {}) {
  const clock = { t: FIXED_NOW };
  const fake = createFakeSupabase({ origin: SUPABASE, accessTtlSeconds: ttl, now: () => clock.t });
  const env = authEnv(overrides);
  const jar = new CookieJar();
  const fetchImpl = fetchWrap ? fetchWrap(fake.fetch) : fake.fetch;
  const call = async (path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    const cookie = jar.header();
    if (cookie && !('cookie' in headers)) headers.cookie = cookie;
    return jar.take(await send(env, path, { ...init, headers, deps: { fetchImpl, now: () => clock.t } }));
  };
  const post = (path, body, extra = {}) => call(path, { method: 'POST', headers: writeHeaders(extra), body: JSON.stringify(body) });
  return { clock, fake, env, jar, call, post };
}

async function signIn(t, email = EMAIL) {
  assert.equal((await t.post('/api/auth/email/start', { email })).status, 200);
  const response = await t.post('/api/auth/email/verify', { email, code: '123456', returnTo: '/members/' });
  assert.equal(response.status, 200);
  return response;
}

describe('세션 암호화', () => {
  const key = sessionKeyBytes({ SESSION_ENCRYPTION_KEY: TEST_SESSION_KEY });
  const other = sessionKeyBytes({ SESSION_ENCRYPTION_KEY: OTHER_SESSION_KEY });
  it('.dev.vars.example 의 가짜 키도 32바이트로 읽힌다', () => {
    assert.equal(sessionKeyBytes({ SESSION_ENCRYPTION_KEY: 'bG9jYWwtb25seS1mYWtlLWtleS0zMi1ieXRlcyEhISE=' })?.length, 32);
    assert.equal(sessionKeyBytes({ SESSION_ENCRYPTION_KEY: 'c2hvcnQ=' }), null);
    assert.equal(sessionKeyBytes({}), null);
  });
  it('암호화 → 복호화', async () => {
    const sealed = await encryptJson(key, 'aad', { a: 1, s: '한글' });
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(await decryptJson(key, 'aad', sealed), { a: 1, s: '한글' });
    assert.notEqual(await encryptJson(key, 'aad', { a: 1 }), await encryptJson(key, 'aad', { a: 1 }), 'IV 가 매번 달라야 한다');
  });
  it('변조·다른 aad·다른 키·틀린 형식은 null', async () => {
    const sealed = await encryptJson(key, 'aad', { a: 1 });
    const parts = sealed.split('.');
    const flipped = parts[2].slice(0, -2) + (parts[2].at(-2) === 'A' ? 'B' : 'A') + parts[2].at(-1);
    assert.equal(await decryptJson(key, 'aad', `${parts[0]}.${parts[1]}.${flipped}`), null);
    assert.equal(await decryptJson(key, 'other-aad', sealed), null);
    assert.equal(await decryptJson(other, 'aad', sealed), null);
    for (const bad of ['', 'v2.x.y', 'v1.short.y', `${sealed}.extra`, null]) assert.equal(await decryptJson(key, 'aad', bad), null);
  });
});

describe('세션 저장소(D1)', () => {
  const key = sessionKeyBytes({ SESSION_ENCRYPTION_KEY: TEST_SESSION_KEY });
  const data = { userId: '00000000-0000-4000-8000-000000000001', email: EMAIL, provider: 'email', accessToken: 'aaa.bbb.ccc', refreshToken: 'r1', accessExpiresAt: 1 };
  const cookieRequest = (value) => new Request(`${SITE}/`, { headers: { cookie: value } });
  const raw = (cookie) => /=([a-f0-9]{64});/.exec(cookie)[1];

  it('쿠키는 무작위 64 hex, 행 id 는 그 SHA-256, 내용은 암호문', async () => {
    const d1 = createFakeD1();
    const db = database({ DB: d1 });
    const created = await createSession(db, key, data, FIXED_NOW);
    assert.match(created.cookie, /^__Host-site-session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
    const row = d1.sqlite.prepare('SELECT * FROM sessions').get();
    assert.equal(row.id, sha256(raw(created.cookie)));
    assert.equal(row.expires_at, FIXED_NOW + 7 * 24 * 3600 * 1000);
    assert.ok(!row.data.includes(EMAIL) && !row.data.includes('aaa.bbb') && !row.data.includes('r1'), '평문이 저장되면 안 된다');
    const read = await readSession(cookieRequest(`${SESSION_COOKIE}=${raw(created.cookie)}`), db, key, FIXED_NOW);
    assert.equal(read.state, 'ok');
    assert.deepEqual(read.data, data);
    assert.equal(read.csrf, created.csrf);
  });
  it('7일이 지나면 쓸 수 없다', async () => {
    const db = database({ DB: createFakeD1() });
    const created = await createSession(db, key, data, FIXED_NOW);
    const later = await readSession(cookieRequest(`${SESSION_COOKIE}=${raw(created.cookie)}`), db, key, FIXED_NOW + 7 * 24 * 3600 * 1000);
    assert.equal(later.state, 'invalid');
  });
  it('다른 행의 암호문을 옮겨 넣으면(행 바꿔치기) 풀리지 않고 그 행을 지운다', async () => {
    const d1 = createFakeD1();
    const db = database({ DB: d1 });
    const a = await createSession(db, key, data, FIXED_NOW);
    const b = await createSession(db, key, { ...data, userId: '00000000-0000-4000-8000-000000000002' }, FIXED_NOW);
    d1.sqlite.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(a.ciphertext, b.id);
    const read = await readSession(cookieRequest(`${SESSION_COOKIE}=${raw(b.cookie)}`), db, key, FIXED_NOW);
    assert.equal(read.state, 'invalid');
    assert.equal(d1.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE id = ?').get(b.id).n, 0);
  });
  it('키를 바꾸면 이전 세션은 쓸 수 없다', async () => {
    const db = database({ DB: createFakeD1() });
    const created = await createSession(db, key, data, FIXED_NOW);
    const other = sessionKeyBytes({ SESSION_ENCRYPTION_KEY: OTHER_SESSION_KEY });
    assert.equal((await readSession(cookieRequest(`${SESSION_COOKIE}=${raw(created.cookie)}`), db, other, FIXED_NOW)).state, 'invalid');
  });
  it('쿠키 형식이 틀리거나 같은 이름 쿠키가 둘이면 쓸 수 없다', async () => {
    const db = database({ DB: createFakeD1() });
    const created = await createSession(db, key, data, FIXED_NOW);
    const value = raw(created.cookie);
    assert.equal((await readSession(cookieRequest(`${SESSION_COOKIE}=${value.toUpperCase()}`), db, key, FIXED_NOW)).state, 'invalid');
    assert.equal((await readSession(cookieRequest(`${SESSION_COOKIE}=${value}; ${SESSION_COOKIE}=${value}`), db, key, FIXED_NOW)).state, 'invalid');
    assert.equal((await readSession(cookieRequest('other=1'), db, key, FIXED_NOW)).state, 'none');
  });
});

describe('이메일 코드 로그인 흐름', () => {
  it('시작 → 틀린 코드 → 맞는 코드 → me → 보호 API → 로그아웃 → 같은 쿠키 거부', async () => {
    const t = setup();
    // 시작
    assert.deepEqual(await (await t.post('/api/auth/email/start', { email: 'not-an-email' })).json(), { error: 'INVALID_EMAIL' });
    assert.deepEqual(await (await t.post('/api/auth/email/start', { email: EMAIL, extra: 1 })).json(), { error: 'INVALID_EMAIL' });
    const started = await t.post('/api/auth/email/start', { email: ` ${EMAIL.toUpperCase()} ` });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { sent: true });
    assert.ok(t.fake.state.otps.has(EMAIL));
    // 틀린 코드
    const wrong = await t.post('/api/auth/email/verify', { email: EMAIL, code: '000000' });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { error: 'INVALID_CODE' });
    const calls = t.fake.state.requests.length;
    assert.deepEqual(await (await t.post('/api/auth/email/verify', { email: EMAIL, code: '12ab56' })).json(), { error: 'INVALID_CODE' });
    assert.equal(t.fake.state.requests.length, calls, '형식이 틀린 코드는 Supabase 에 보내지 않는다');
    // 맞는 코드(returnTo 는 안전화)
    const verified = await t.post('/api/auth/email/verify', { email: EMAIL, code: '123456', returnTo: '//evil.example/x' });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { signedIn: true, returnTo: '/' });
    const setCookie = verified.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    assert.match(setCookie, /^__Host-site-session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
    const savedCookie = t.jar.header();
    // me
    const me = await (await t.call('/api/auth/me')).json();
    assert.equal(me.signedIn, true);
    assert.equal(me.user.email, EMAIL);
    assert.match(me.user.id, /^[0-9a-f-]{36}$/);
    assert.match(me.csrf, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(me).sort(), ['csrf', 'signedIn', 'user']);
    // 보호 API·화면
    const hello = await t.call('/api/members/hello');
    assert.equal(hello.status, 200);
    assert.deepEqual(await hello.json(), { email: EMAIL });
    const page = await t.call('/members/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store, no-transform');
    // 로그아웃은 CSRF 가 필요하다
    assert.deepEqual(await (await t.post('/api/auth/logout', {})).json(), { error: 'INVALID_CSRF' });
    assert.deepEqual(await (await t.post('/api/auth/logout', {}, { 'x-csrf-token': 'f'.repeat(64) })).json(), { error: 'INVALID_CSRF' });
    const out = await t.post('/api/auth/logout', {}, { 'x-csrf-token': me.csrf });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { signedIn: false });
    assert.ok(out.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE}=;`) && line.includes('Max-Age=0')));
    assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.ok(t.fake.state.requests.some((r) => r.method === 'POST' && r.path === '/logout'), 'Supabase 세션도 끝낸다');
    // 로그아웃 전에 저장해 둔 같은 쿠키를 다시 보낸다
    const replay = await t.call('/api/members/hello', { headers: { cookie: savedCookie } });
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: 'SIGN_IN_REQUIRED' });
    const replayMe = await t.call('/api/auth/me', { headers: { cookie: savedCookie } });
    assert.deepEqual(await replayMe.json(), { signedIn: false });
    assert.ok(replayMe.headers.getSetCookie().some((line) => line.includes('Max-Age=0')), '쓸 수 없는 쿠키는 지운다');
    assert.equal((await t.call('/members/', { headers: { cookie: savedCookie } })).status, 302);
    // 로그에 이메일·토큰이 없다
    assert.ok(!logged.join('\n').includes(EMAIL));
  });

  it('D1 행에는 토큰·이메일 평문이 없다', async () => {
    const t = setup();
    await signIn(t);
    const row = t.env.DB.sqlite.prepare('SELECT * FROM sessions').get();
    assert.ok(!row.data.includes(EMAIL) && !row.data.includes('eyJ'));
    assert.equal(row.id, sha256(t.jar.get(SESSION_COOKIE)));
  });

  it('다시 로그인하면 이전 세션 행을 지운다(세션 고정 방지)', async () => {
    const t = setup();
    await signIn(t);
    const first = t.jar.get(SESSION_COOKIE);
    await signIn(t);
    assert.notEqual(t.jar.get(SESSION_COOKIE), first);
    assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
  });

  it('로그인 상태의 다른 상태 변경 요청도 CSRF 를 본다(이메일 시작·확인은 예외)', async () => {
    const t = setup();
    await signIn(t);
    assert.deepEqual(await (await t.post('/api/anything', {})).json(), { error: 'INVALID_CSRF' });
    const csrf = (await (await t.call('/api/auth/me')).json()).csrf;
    assert.equal((await t.post('/api/anything', {}, { 'x-csrf-token': csrf })).status, 404);
    assert.equal((await t.post('/api/auth/email/start', { email: EMAIL })).status, 200);
  });

  it('로그인 기능이 꺼져 있으면 AUTH_DISABLED, me 는 signedIn:false', async () => {
    const t = setup({ env: { AUTH_ACTIVATION: 'disabled' } });
    const start = await t.post('/api/auth/email/start', { email: EMAIL });
    assert.equal(start.status, 503);
    assert.deepEqual(await start.json(), { error: 'AUTH_DISABLED' });
    assert.deepEqual(await (await t.post('/api/auth/email/verify', { email: EMAIL, code: '123456' })).json(), { error: 'AUTH_DISABLED' });
    assert.deepEqual(await (await t.call('/api/auth/me')).json(), { signedIn: false });
    assert.equal(t.fake.state.requests.length, 0);
  });

  it('AUTH_METHODS 에 email 이 없으면 AUTH_DISABLED', async () => {
    const t = setup({ env: { AUTH_METHODS: 'google' } });
    assert.deepEqual(await (await t.post('/api/auth/email/start', { email: EMAIL })).json(), { error: 'AUTH_DISABLED' });
  });

  it('Supabase 장애·한도·네트워크 오류는 코드로만 알리고 문구를 반사하지 않는다', async () => {
    const reply = (status, headers = {}) => () => async () =>
      new Response(JSON.stringify({ code: status, msg: `secret detail for ${EMAIL}` }), { status, headers: { 'content-type': 'application/json', ...headers } });
    const down = setup({ fetchWrap: reply(500) });
    const r1 = await down.post('/api/auth/email/start', { email: EMAIL });
    assert.equal(r1.status, 503);
    assert.equal(await r1.text(), '{"error":"AUTH_UNAVAILABLE"}');
    const limited = setup({ fetchWrap: reply(429, { 'retry-after': '30' }) });
    const r2 = await limited.post('/api/auth/email/start', { email: EMAIL });
    assert.equal(r2.status, 429);
    assert.deepEqual(await r2.json(), { error: 'RATE_LIMITED', retryAfter: 30 });
    assert.equal(r2.headers.get('retry-after'), '30');
    const rejected = setup({ fetchWrap: reply(422) });
    assert.deepEqual(await (await rejected.post('/api/auth/email/start', { email: EMAIL })).json(), { error: 'AUTH_UNAVAILABLE' });
    const offline = setup({ fetchWrap: () => async () => { throw new TypeError(`connect failed ${SUPABASE}`); } });
    assert.deepEqual(await (await offline.post('/api/auth/email/start', { email: EMAIL })).json(), { error: 'AUTH_UNAVAILABLE' });
    assert.deepEqual(await (await offline.post('/api/auth/email/verify', { email: EMAIL, code: '123456' })).json(), { error: 'AUTH_UNAVAILABLE' });
    const redirecting = setup({ fetchWrap: () => async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) });
    assert.deepEqual(await (await redirecting.post('/api/auth/email/start', { email: EMAIL })).json(), { error: 'AUTH_UNAVAILABLE' });
    const all = logged.join('\n');
    assert.ok(!all.includes(EMAIL) && !all.includes('secret detail') && !all.includes(SUPABASE), all);
  });

  it('/user 가 다른 사람을 돌려주면 로그인하지 않는다', async () => {
    const t = setup({
      fetchWrap: (inner) => async (input, init) => {
        const response = await inner(input, init);
        if (new URL(typeof input === 'string' ? input : input.url).pathname !== '/auth/v1/user') return response;
        const user = await response.json();
        return new Response(JSON.stringify({ ...user, id: '11111111-1111-4111-8111-111111111111' }), { status: 200 });
      },
    });
    await t.post('/api/auth/email/start', { email: EMAIL });
    const response = await t.post('/api/auth/email/verify', { email: EMAIL, code: '123456' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'AUTH_UNAVAILABLE' });
    assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  });
});

describe('액세스 토큰 갱신', () => {
  it('만료가 가까우면 refresh 로 갱신하고 로그인 상태를 유지한다', async () => {
    const t = setup({ ttl: 120 });
    await signIn(t);
    const before = t.env.DB.sqlite.prepare('SELECT data FROM sessions').get().data;
    t.clock.t += 100_000; // 남은 20초 < 여유 60초
    const me = await (await t.call('/api/auth/me')).json();
    assert.equal(me.signedIn, true);
    assert.ok(t.fake.state.requests.some((r) => r.path === '/token'), 'refresh 를 불렀다');
    assert.notEqual(t.env.DB.sqlite.prepare('SELECT data FROM sessions').get().data, before);
    const count = t.fake.state.requests.length;
    assert.equal((await t.call('/api/members/hello')).status, 200);
    assert.equal(t.fake.state.requests.length, count, '새 토큰이 있으면 Supabase 를 다시 부르지 않는다');
  });

  it('갱신이 거부되면 행을 지우고 로그아웃 상태', async () => {
    const t = setup({ ttl: 120 });
    await signIn(t);
    for (const session of t.fake.state.sessions.values()) session.revoked = true;
    t.clock.t += 100_000;
    const response = await t.call('/api/members/hello');
    assert.equal(response.status, 401);
    assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.equal(t.jar.get(SESSION_COOKIE), undefined, '쿠키도 지운다');
  });

  it('Supabase 에 닿지 못하면 이번 요청만 막고 행은 남긴다', async () => {
    let offline = true;
    const t = setup({ ttl: 120, fetchWrap: (inner) => async (input, init) => {
      if (offline && new URL(typeof input === 'string' ? input : input.url).pathname === '/auth/v1/token') throw new TypeError('offline');
      return inner(input, init);
    } });
    await signIn(t);
    t.clock.t += 100_000;
    assert.equal((await t.call('/members/')).status, 302);
    assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    offline = false;
    assert.equal((await t.call('/members/')).status, 200);
  });

  it('두 요청이 동시에 갱신해도 로그아웃되지 않는다', async () => {
    const t = setup({ ttl: 120 });
    await signIn(t);
    t.clock.t += 100_000;
    const [a, b] = await Promise.all([t.call('/api/members/hello'), t.call('/api/members/hello')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await t.call('/api/members/hello')).status, 200);
  });
});

describe('소셜 로그인(PKCE)', () => {
  async function start(t, query = 'provider=google&returnTo=%2Fmembers%2F') {
    return t.call(`/api/auth/social/start?${query}`);
  }

  it('시작 → Supabase authorize → 콜백 → 세션 → returnTo', async () => {
    const t = setup();
    const started = await start(t);
    assert.equal(started.status, 302);
    const location = new URL(started.headers.get('location'));
    assert.equal(location.origin + location.pathname, `${SUPABASE}/auth/v1/authorize`);
    assert.equal(location.searchParams.get('provider'), 'google');
    assert.equal(location.searchParams.get('code_challenge_method'), 's256');
    assert.match(location.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    const redirectTo = new URL(location.searchParams.get('redirect_to'));
    assert.equal(`${redirectTo.origin}${redirectTo.pathname}`, `${SITE}/api/auth/social/callback`);
    assert.match(redirectTo.searchParams.get('state'), /^[a-f0-9]{64}$/);
    const oauth = started.headers.getSetCookie().find((line) => line.startsWith('__Host-site-oauth='));
    assert.match(oauth, /^__Host-site-oauth=v1\.[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    assert.ok(!oauth.includes(location.searchParams.get('code_challenge')), 'verifier·challenge 는 쿠키에 평문으로 없다');
    // 가짜 Supabase 가 곧바로 콜백 주소로 돌려보낸다
    const authorized = await t.fake.fetch(location.href);
    assert.equal(authorized.status, 302);
    const callback = new URL(authorized.headers.get('location'));
    assert.ok(callback.searchParams.get('code'));
    const done = await t.call(callback.pathname + callback.search);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/members/');
    assert.ok(done.headers.getSetCookie().some((line) => line.startsWith('__Host-site-oauth=;') && line.includes('Max-Age=0')));
    assert.match(t.jar.get(SESSION_COOKIE), /^[a-f0-9]{64}$/);
    const me = await (await t.call('/api/auth/me')).json();
    assert.equal(me.signedIn, true);
    assert.equal(me.user.email, 'google.user@example.test');
    // 같은 코드를 다시 쓰면 실패
    const again = await t.call(callback.pathname + callback.search);
    assert.equal(again.headers.get('location'), '/login/?error=SOCIAL_FAILED');
  });

  it('AUTH_METHODS 에 없는 제공자·email·빈 값은 PROVIDER_NOT_ALLOWED', async () => {
    const t = setup();
    for (const query of ['provider=github&returnTo=%2Fmembers%2F', 'provider=email', 'provider=', '', 'provider=google&provider=github', 'provider=GOOGLE']) {
      const response = await start(t, query);
      assert.equal(response.status, 302, query);
      assert.match(response.headers.get('location'), /^\/login\/\?error=PROVIDER_NOT_ALLOWED/, query);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    assert.equal((await start(t, 'provider=github&returnTo=%2Fmembers%2F')).headers.get('location'), '/login/?error=PROVIDER_NOT_ALLOWED&returnTo=%2Fmembers%2F');
  });

  it('로그인 기능이 꺼져 있으면 /login/?error=AUTH_DISABLED', async () => {
    const t = setup({ env: { AUTH_ACTIVATION: 'disabled' } });
    assert.equal((await start(t)).headers.get('location'), '/login/?error=AUTH_DISABLED&returnTo=%2Fmembers%2F');
  });

  async function codeFor(t, query) {
    const started = await start(t, query);
    const authorized = await t.fake.fetch(started.headers.get('location'));
    return new URL(authorized.headers.get('location'));
  }

  it('쿠키 없음·state 다름·error 매개변수·만료·변조는 모두 SOCIAL_FAILED(문구 반사 없음)', async () => {
    // 쿠키 없음
    const t1 = setup();
    const c1 = await codeFor(t1);
    const noCookie = await t1.call(c1.pathname + c1.search, { headers: { cookie: '' } });
    assert.equal(noCookie.headers.get('location'), '/login/?error=SOCIAL_FAILED');
    // state 다름
    const t2 = setup();
    const c2 = await codeFor(t2);
    c2.searchParams.set('state', 'a'.repeat(64));
    assert.match((await t2.call(c2.pathname + c2.search)).headers.get('location'), /^\/login\/\?error=SOCIAL_FAILED/);
    // 제공자 오류(취소) — 설명 문구를 되돌려 보내지 않는다
    const t3 = setup();
    const c3 = await codeFor(t3, 'provider=google&returnTo=%2Fmembers%2F');
    c3.searchParams.set('error', 'access_denied');
    c3.searchParams.set('error_description', '<script>alert(1)</script>');
    const cancelled = await t3.call(c3.pathname + c3.search);
    assert.equal(cancelled.headers.get('location'), '/login/?error=SOCIAL_FAILED&returnTo=%2Fmembers%2F');
    // 10분이 지남
    const t4 = setup();
    const c4 = await codeFor(t4);
    t4.clock.t += 10 * 60 * 1000 + 1;
    assert.match((await t4.call(c4.pathname + c4.search)).headers.get('location'), /^\/login\/\?error=SOCIAL_FAILED/);
    // 쿠키 변조
    const t5 = setup();
    const c5 = await codeFor(t5);
    const sealed = t5.jar.get('__Host-site-oauth');
    t5.jar.values.set('__Host-site-oauth', sealed.slice(0, -3) + (sealed.endsWith('AAA') ? 'BBB' : 'AAA'));
    assert.match((await t5.call(c5.pathname + c5.search)).headers.get('location'), /^\/login\/\?error=SOCIAL_FAILED/);
    // 다른 키로 만든 쿠키(키 교체 뒤)
    const t6 = setup();
    const c6 = await codeFor(t6);
    t6.env.SESSION_ENCRYPTION_KEY = OTHER_SESSION_KEY;
    assert.match((await t6.call(c6.pathname + c6.search)).headers.get('location'), /^\/login\/\?error=SOCIAL_FAILED/);
    for (const t of [t1, t2, t3, t4, t5, t6]) assert.equal(t.env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  });

  it('다른 브라우저의 코드(다른 verifier)로는 교환되지 않는다', async () => {
    const attacker = setup();
    const victim = setup();
    victim.fake.state.flows = attacker.fake.state.flows; // 같은 Supabase 라고 친다
    const attackerCode = await codeFor(attacker);
    const victimStart = await start(victim);
    const victimState = new URL(new URL(victimStart.headers.get('location')).searchParams.get('redirect_to')).searchParams.get('state');
    attackerCode.searchParams.set('state', victimState);
    const response = await victim.call(attackerCode.pathname + attackerCode.search);
    assert.match(response.headers.get('location'), /^\/login\/\?error=SOCIAL_FAILED/);
  });
});

describe('Supabase 연결 값 검사', () => {
  it('supabaseOrigin', () => {
    assert.equal(supabaseOrigin('https://abc.supabase.co', 'https://site.example'), 'https://abc.supabase.co');
    assert.equal(supabaseOrigin('https://abc.supabase.co/', 'https://site.example'), 'https://abc.supabase.co');
    assert.equal(supabaseOrigin('https://auth.custom.example', 'https://site.example'), 'https://auth.custom.example');
    assert.equal(supabaseOrigin('http://127.0.0.1:54321', 'http://127.0.0.1:8797'), 'http://127.0.0.1:54321');
    for (const bad of ['http://abc.supabase.co', 'https://u:p@abc.supabase.co', 'https://abc.supabase.co/x', 'https://abc.supabase.co?x=1', 'ftp://x', '', null]) {
      assert.equal(supabaseOrigin(bad, 'https://site.example'), null, String(bad));
    }
    assert.equal(supabaseOrigin('http://127.0.0.1:54321', 'https://site.example'), null);
  });
  it('publishableKey 는 비밀 키를 거부한다', () => {
    assert.equal(publishableKey('sb_publishable_abc'), 'sb_publishable_abc');
    assert.equal(publishableKey('sb_secret_abc'), null);
    const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    assert.equal(publishableKey(jwt({ role: 'anon' })), jwt({ role: 'anon' }));
    assert.equal(publishableKey(jwt({ role: 'service_role' })), null);
    assert.equal(publishableKey('has space'), null);
  });
  it('userFields 는 익명·인증 안 된 사용자를 거부한다', () => {
    const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', email: 'A@Example.test', is_anonymous: false, app_metadata: { provider: 'google' } };
    assert.deepEqual(userFields(user), { id: user.id, email: 'a@example.test', provider: 'google' });
    assert.throws(() => userFields({ ...user, is_anonymous: true }));
    assert.throws(() => userFields({ ...user, aud: 'anon' }));
    assert.throws(() => userFields({ ...user, id: 'nope' }));
    assert.equal(userFields({ ...user, email: undefined }).email, '');
  });
  it('normalizeEmail', () => {
    assert.equal(normalizeEmail('  A@B.test '), 'a@b.test');
    for (const bad of ['a@b', 'a b@c.test', '<a>@b.test', `${'a'.repeat(250)}@b.test`, '', null]) assert.equal(normalizeEmail(bad), null, String(bad));
  });
});
