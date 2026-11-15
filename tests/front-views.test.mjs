// 목록·상세·머리말·로그인 렌더(jsdom + 가짜 fetch)
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

globalThis.__SITE_TEST__ = true;
const { parseRoute, start } = await import('../public/app/main.js');
const { start: startLogin, socialMethods, socialHref } = await import('../public/app/login.js');
const { start: startMembers } = await import('../public/app/members.js');
const { api, safeReturnTo } = await import('../public/app/api.js');

const ITEMS = [
  { id: 'a-one', status: 'open', title: 'Alpha <img src=x onerror=alert(1)>', summary: 'sum a', place: 'Place A', startsOn: '2026-12-01', endsOn: '2026-12-02', deadline: '2099-12-01T18:00:00+09:00', accent: 'blue', image: '/samples/poster-1.svg' },
  { id: 'b-two', status: 'closing', title: 'Beta', summary: 'sum b', place: 'Place B', startsOn: '2026-12-05', endsOn: '2026-12-05', deadline: '2099-12-02T18:00:00+09:00', accent: 'coral', image: null },
  { id: 'c-three', status: 'closed', title: 'Gamma', summary: 'sum c', place: 'Place C', startsOn: '2026-01-05', endsOn: '2026-01-05', deadline: null, accent: 'yellow', image: null },
];
const DETAIL = { ...ITEMS[0], body: '## Head\npara\n\n- one\n- <script>window.x=1</script>', link: 'https://example.com/x' };

function setup({ hash = '', path = '/', html, fetchImpl }) {
  if (!path.includes('lang=')) path += (path.includes('?') ? '&' : '?') + 'lang=ko';
  const dom = new JSDOM(html || '<!doctype html><html lang="ko"><body><a class="ui-skip" href="#content">skip</a><header data-ui-header></header><main id="content" tabindex="-1"><div data-app-root></div><div data-login-root></div><div data-members-root></div></main><footer data-ui-footer></footer></body></html>', { url: `http://localhost${path}${hash}`, pretendToBeVisual: true });
  const win = dom.window;
  win.scrollTo = () => {};
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  };
  return { win, doc: win.document, calls };
}
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const standardFetch = (opts = {}) => async (url) => {
  if (url.startsWith('/api/items/')) return url.includes('missing') ? ok({ error: 'NOT_FOUND' }, 404) : ok({ item: DETAIL });
  if (url.startsWith('/api/items')) return ok({ items: ITEMS });
  if (url === '/api/auth/config') return ok({ enabled: !!opts.auth, methods: ['email', 'google', 'kakao'] });
  if (url === '/api/auth/me') return ok(opts.signedIn ? { signedIn: true, user: { id: '1', email: 'a@b.co' }, csrf: 'tok' } : { signedIn: false });
  if (url === '/api/members/hello') return ok({ email: 'a@b.co' });
  return ok({ error: 'NOT_FOUND' }, 404);
};

test('parseRoute', () => {
  assert.deepEqual(parseRoute(''), { name: 'list' });
  assert.deepEqual(parseRoute('#/items'), { name: 'list' });
  assert.deepEqual(parseRoute('#/items/abc-1'), { name: 'detail', id: 'abc-1' });
  assert.deepEqual(parseRoute('#/items/ABC'), { name: 'notfound' });
  assert.deepEqual(parseRoute('#/nope'), { name: 'notfound' });
  assert.equal(parseRoute('#content'), null);
});

test('목록: 카드·테마색·상태·포스터 대체·XSS 없음', async () => {
  const { win, doc } = setup({ fetchImpl: standardFetch() });
  start(win);
  await wait();
  const cards = doc.querySelectorAll('.ui-card');
  assert.equal(cards.length, 3);
  assert.deepEqual([...cards].map((c) => c.dataset.accent), ['blue', 'coral', 'yellow']);
  assert.deepEqual([...cards].map((c) => c.querySelector('.ui-status').dataset.status), ['open', 'closing', 'closed']);
  assert.equal(doc.querySelectorAll('.ui-card--featured').length, 0, '3건이면 대표 카드 없음');
  assert.equal(cards[0].querySelector('img.ui-poster').getAttribute('src'), '/samples/poster-1.svg');
  assert.equal(cards[0].querySelector('img').getAttribute('alt'), '');
  assert.equal(cards[1].querySelector('.ui-poster--none').textContent, 'Beta');
  assert.equal(doc.querySelectorAll('img[onerror]').length, 0);
  assert.ok(cards[0].querySelector('h2 a').textContent.includes('<img src=x'));
  assert.equal(cards[0].querySelector('a').getAttribute('href'), '#/items/a-one');
  assert.equal(cards[0].querySelector('.ui-dday').textContent.startsWith('D-'), true);
  assert.equal(cards[2].querySelector('.ui-dday'), null);
  assert.equal(doc.querySelectorAll('h1').length, 1);
  // 걸러 보기
  doc.querySelector('[data-filter="closed"]').click();
  assert.equal(doc.querySelectorAll('.ui-card').length, 1);
  assert.equal(doc.querySelector('[data-filter="closed"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-filter="all"]').getAttribute('aria-pressed'), 'false');
});

test('목록: 빈 상태·오류 상태(다시 시도)', async () => {
  let calls = 0;
  const { win, doc } = setup({ fetchImpl: async (url) => (url.startsWith('/api/items') ? (calls++ === 0 ? ok({ error: 'SERVICE_UNAVAILABLE' }, 503) : ok({ items: [] })) : ok({ enabled: false, methods: [] })) });
  start(win);
  await wait();
  const state = doc.querySelector('.ui-state');
  assert.equal(state.dataset.state, 'error');
  assert.ok(state.textContent.includes('지금은 서비스를 쓸 수 없습니다'));
  state.querySelector('button').click();
  await wait();
  assert.equal(doc.querySelector('.ui-state').dataset.state, 'empty');
});

test('상세: 구조화 본문·링크·고정 바·없는 항목', async () => {
  const { win, doc } = setup({ hash: '#/items/a-one', fetchImpl: standardFetch() });
  start(win);
  await wait();
  assert.equal(doc.querySelector('h1').textContent.startsWith('Alpha'), true);
  assert.equal(doc.querySelector('.ui-detail').dataset.accent, 'blue');
  assert.equal(doc.querySelectorAll('.ui-prose-list li').length, 2);
  assert.equal(doc.querySelector('.ui-prose-sub').textContent, 'Head');
  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.ok(doc.querySelector('.ui-prose-list').textContent.includes('<script>window.x=1</script>'));
  const link = doc.querySelector('.ui-action-bar a.ui-btn');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.ok(doc.documentElement.classList.contains('ui-has-bar'));
  assert.equal(doc.querySelectorAll('.ui-btn:not(.ui-btn--secondary)').length, 1, '주 단추는 화면에 하나');

  const missing = setup({ hash: '#/items/missing', fetchImpl: standardFetch() });
  start(missing.win);
  await wait();
  assert.equal(missing.doc.querySelector('.ui-state').dataset.state, 'error');
  assert.ok(missing.doc.querySelector('.ui-state').textContent.includes('찾을 수 없습니다'));
  assert.equal(missing.doc.querySelector('[data-retry]'), null);
});

test('언어 전환: 문구와 html lang 이 바뀌고 목록을 다시 받는다', async () => {
  const { win, doc, calls } = setup({ path: '/?lang=en', fetchImpl: standardFetch() });
  start(win);
  await wait();
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.querySelector('h1').textContent, 'Items');
  const select = doc.querySelector('[data-lang-select]');
  select.value = 'ja';
  select.dispatchEvent(new win.Event('change'));
  await wait();
  assert.equal(doc.documentElement.lang, 'ja');
  assert.equal(doc.querySelector('h1').textContent, '項目一覧');
  assert.ok(calls.some((c) => c.url === '/api/items?lang=ja'));
  assert.ok(win.location.search.includes('lang=ja'));
});

test('머리말: 로그인 꺼짐이면 단추 없음, 켜짐이면 로그인/로그아웃', async () => {
  let s = setup({ fetchImpl: standardFetch({ auth: false }) });
  start(s.win);
  await wait();
  assert.equal(s.doc.querySelector('[data-login],[data-logout]'), null);
  assert.equal(s.doc.querySelectorAll('.ui-nav-link').length, 1);

  s = setup({ fetchImpl: standardFetch({ auth: true }) });
  start(s.win);
  await wait();
  assert.ok(s.doc.querySelector('[data-login]').getAttribute('href').startsWith('/login/?returnTo='));

  s = setup({ fetchImpl: standardFetch({ auth: true, signedIn: true }) });
  start(s.win);
  await wait();
  assert.ok(s.doc.querySelector('[data-logout]'));
  assert.equal(s.doc.querySelectorAll('.ui-nav-link').length, 2, '회원 메뉴는 로그인 뒤에만');
});

test('api: 상태 변경 요청에 x-site-request 와 csrf, 오류 코드', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return url === '/bad' ? ok({ error: 'RATE_LIMITED', retryAfter: 7 }, 429) : ok({ ok: true });
  };
  await api('/x');
  assert.equal(calls[0].init.headers['x-site-request'], undefined);
  assert.equal(calls[0].init.credentials, 'same-origin');
  await api('/x', { method: 'POST', body: { a: 1 } });
  assert.equal(calls[1].init.headers['x-site-request'], '1');
  const { setCsrf, ApiError } = await import('../public/app/api.js');
  setCsrf('tok');
  await api('/x', { method: 'POST', body: {} });
  assert.equal(calls[2].init.headers['x-csrf-token'], 'tok');
  setCsrf(null);
  await assert.rejects(() => api('/bad', { method: 'POST' }), (e) => e instanceof ApiError && e.code === 'RATE_LIMITED' && e.retryAfter === 7 && e.status === 429);
  globalThis.fetch = async () => { throw new TypeError('x'); };
  await assert.rejects(() => api('/x'), (e) => e.code === 'NETWORK_ERROR');
});

test('safeReturnTo·소셜 링크·방식 목록', () => {
  for (const bad of ['//evil.com', '/\\evil', 'https://evil.com', '/https:evil', 'x', null]) assert.equal(safeReturnTo(bad), '/', String(bad));
  assert.equal(safeReturnTo('/members/?a=1#b'), '/members/?a=1#b');
  assert.deepEqual(socialMethods(['email', 'google', 'kakao', 'bad name!']), ['google', 'kakao']);
  assert.equal(socialHref('google', '/members/'), '/api/auth/social/start?provider=google&returnTo=%2Fmembers%2F');
});

test('로그인 화면: 꺼짐 안내 · 이메일→코드 두 단계 · 소셜 단추 · ?error=', async () => {
  let s = setup({ path: '/login/', fetchImpl: standardFetch({ auth: false }) });
  startLogin(s.win);
  await wait();
  assert.ok(s.doc.querySelector('[data-login-root]').textContent.includes('로그인 기능이 꺼져 있습니다'));
  assert.equal(s.doc.querySelector('form'), null);

  const posts = [];
  const f = standardFetch({ auth: true });
  s = setup({ path: '/login/?returnTo=%2Fmembers%2F&error=SOCIAL_FAILED', fetchImpl: async (url, init) => {
    if (init.method === 'POST') { posts.push({ url, body: JSON.parse(init.body) }); return ok(url.endsWith('/start') ? { sent: true } : { signedIn: true, returnTo: '/members/' }); }
    return f(url, init);
  } });
  startLogin(s.win);
  await wait();
  const root = s.doc.querySelector('[data-login-root]');
  assert.ok(root.textContent.includes('외부 계정으로 로그인하지 못했습니다'));
  const socials = [...root.querySelectorAll('.ui-social a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(socials, ['/api/auth/social/start?provider=google&returnTo=%2Fmembers%2F', '/api/auth/social/start?provider=kakao&returnTo=%2Fmembers%2F']);
  // 잘못된 이메일: 서버에 보내지 않고 오류 표시
  const input = root.querySelector('#login-email');
  input.value = 'not-an-email';
  root.querySelector('form').dispatchEvent(new s.win.Event('submit', { cancelable: true }));
  await wait();
  assert.equal(posts.length, 0);
  assert.equal(root.querySelector('#login-email').getAttribute('aria-invalid'), 'true');
  assert.ok(root.querySelector('.ui-error'));
  // 올바른 이메일 → 코드 단계
  root.querySelector('#login-email').value = 'me@example.com';
  root.querySelector('form').dispatchEvent(new s.win.Event('submit', { cancelable: true }));
  await wait();
  assert.deepEqual(posts[0], { url: '/api/auth/email/start', body: { email: 'me@example.com' } });
  assert.ok(root.querySelector('#login-code'));
  assert.ok(root.textContent.includes('me@example.com'));
});

test('회원 견본: hello 결과와 로그아웃 단추 / 로그인 전 안내', async () => {
  let s = setup({ path: '/members/', fetchImpl: standardFetch({ auth: true, signedIn: true }) });
  startMembers(s.win);
  await wait();
  const root = s.doc.querySelector('[data-members-root]');
  assert.ok(root.textContent.includes('a@b.co'));
  assert.ok(root.querySelector('button'));

  s = setup({ path: '/members/', fetchImpl: standardFetch({ auth: true, signedIn: false }) });
  startMembers(s.win);
  await wait();
  assert.ok(s.doc.querySelector('[data-members-root] a[href^="/login/"]'));
});
