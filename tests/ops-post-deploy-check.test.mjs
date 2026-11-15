// post-deploy-check 의 판정 함수와 전체 흐름 시험(가짜 fetch, 네트워크 없음).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { EXPECTED_CSP, judgeApiNotFound, judgeMembersRedirect, judgeNoOrigin, judgeRoot, judgeVersion, parseVerifyArgs, runChecks, validateOrigin } from '../scripts/post-deploy-check.mjs';

const HEAD = 'a'.repeat(40);
const goodHtmlHeaders = () => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': EXPECTED_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, no-cache, no-transform',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
});
const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...extra });

test('EXPECTED_CSP 는 docs/CONTRACT.md 4절과 글자까지 같다', () => {
  const contract = fs.readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  assert.ok(contract.includes(`Content-Security-Policy: ${EXPECTED_CSP}`));
});

test('validateOrigin: https 와 루프백 http 만, 경로·포트 없는 출처 모양', () => {
  assert.equal(validateOrigin('https://site.example.org'), 'https://site.example.org');
  assert.equal(validateOrigin('http://127.0.0.1:8790'), 'http://127.0.0.1:8790');
  assert.equal(validateOrigin('http://localhost:8798/'), 'http://localhost:8798');
  for (const bad of ['http://site.example.org', 'https://site.example.org/path', 'https://u:p@site.example.org', 'https://site.example.org?x=1', 'ftp://x', 'nope']) {
    assert.throws(() => validateOrigin(bad), TypeError, bad);
  }
});

test('judgeRoot: 정상 응답 통과, 항목별로 어긋나면 FAIL', () => {
  const ok = { status: 200, headers: { ...goodHtmlHeaders(), 'strict-transport-security': 'max-age=31536000' } };
  assert.equal(judgeRoot(ok, { https: true }).status, 'PASS');
  assert.equal(judgeRoot({ status: 200, headers: goodHtmlHeaders() }, { https: false }).status, 'PASS', '로컬 http 는 HSTS 없이 통과');
  assert.match(judgeRoot({ status: 200, headers: goodHtmlHeaders() }, { https: true }).detail, /HSTS/);
  const mut = (patch) => judgeRoot({ status: 200, headers: { ...goodHtmlHeaders(), ...patch } }, { https: false });
  assert.match(mut({ 'content-security-policy': EXPECTED_CSP.replace("'self'", "'unsafe-inline'") }).detail, /CSP/);
  assert.match(mut({ 'x-content-type-options': undefined }).detail, /nosniff/);
  assert.match(mut({ 'cache-control': 'private, no-cache' }).detail, /no-transform/);
  assert.match(judgeRoot({ status: 500, headers: goodHtmlHeaders() }, { https: false }).detail, /500/);
});

test('judgeVersion: 로컬 HEAD 와 비교한다', () => {
  const res = (commit, dirty = false) => ({ status: 200, headers: {}, json: { commit, dirty, builtAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(judgeVersion(res(HEAD), { localCommit: HEAD }).status, 'PASS');
  assert.equal(judgeVersion(res('b'.repeat(40)), { localCommit: HEAD }).status, 'FAIL');
  assert.equal(judgeVersion(res('unknown'), { localCommit: HEAD }).status, 'FAIL');
  assert.equal(judgeVersion(res(HEAD, true), { localCommit: HEAD }).status, 'WARN');
  assert.equal(judgeVersion(res(HEAD), { localCommit: null }).status, 'WARN');
  assert.equal(judgeVersion(res('b'.repeat(40)), { localCommit: HEAD, commitCheck: false }).status, 'WARN', '롤백 직후엔 비교 건너뜀');
  assert.equal(judgeVersion({ status: 200, headers: {}, json: { commit: 1 } }, { localCommit: HEAD }).status, 'FAIL');
});

test('judgeMembersRedirect · judgeApiNotFound · judgeNoOrigin', () => {
  assert.equal(judgeMembersRedirect({ status: 302, headers: { location: '/login/?returnTo=%2Fmembers%2F' } }).status, 'PASS');
  assert.equal(judgeMembersRedirect({ status: 302, headers: { location: 'https://x.example/login/?returnTo=/members/' } }).status, 'PASS');
  assert.equal(judgeMembersRedirect({ status: 200, headers: {} }).status, 'FAIL');
  assert.equal(judgeMembersRedirect({ status: 302, headers: { location: '/' } }).status, 'FAIL');
  assert.equal(judgeApiNotFound({ status: 404, headers: jsonHeaders(), json: { error: 'NOT_FOUND' } }).status, 'PASS');
  assert.equal(judgeApiNotFound({ status: 404, headers: { 'content-type': 'text/html' } }).status, 'FAIL');
  assert.equal(judgeApiNotFound({ status: 404, headers: jsonHeaders(), json: { error: '못 찾음' } }).status, 'FAIL');
  assert.equal(judgeNoOrigin({ status: 403, headers: jsonHeaders(), json: { error: 'INVALID_ORIGIN' } }).status, 'PASS');
  assert.equal(judgeNoOrigin({ status: 403, headers: jsonHeaders(), json: { error: 'X' } }).status, 'WARN');
  assert.equal(judgeNoOrigin({ status: 200, headers: {} }).status, 'FAIL');
});

/** 계약을 지키는 가짜 서버. override 로 한 군데만 망가뜨려 변이를 만든다. */
function fakeServer(override = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const key = `${method} ${u.pathname}`;
    const make = (status, headers, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    if (override[key]) return override[key]();
    if (key === 'GET /') return new Response('<html></html>', { status: 200, headers: goodHtmlHeaders() });
    if (key === 'GET /version.json') return make(200, jsonHeaders(), { commit: HEAD, dirty: false, builtAt: '2026-01-01T00:00:00.000Z' });
    if (key === 'GET /api/health') return make(200, jsonHeaders(), { ok: true });
    if (key === 'GET /api/items') return make(200, jsonHeaders(), { items: [{ id: 'a' }] });
    if (key === 'GET /members/') return new Response(null, { status: 302, headers: { location: '/login/?returnTo=%2Fmembers%2F' } });
    if (key === 'GET /api/members/hello') return make(401, jsonHeaders(), { error: 'SIGN_IN_REQUIRED' });
    if (key === 'GET /api/no-such-endpoint-check') return make(404, jsonHeaders(), { error: 'NOT_FOUND' });
    if (key === 'GET /no-such-page-check') return new Response('x', { status: 404, headers: { 'content-type': 'text/html' } });
    if (key === 'POST /api/auth/logout') return make(403, jsonHeaders(), { error: 'INVALID_ORIGIN' });
    return new Response('no', { status: 404 });
  };
}

test('runChecks: 계약대로 응답하는 서버는 모두 PASS', async () => {
  const rows = await runChecks('http://127.0.0.1:8790', { fetchImpl: fakeServer(), localCommit: HEAD });
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.filter((r) => r.status !== 'PASS'), []);
});

test('runChecks: 변이(보호 경로 열림·Origin 검사 없음·.dev.vars 공개·상태 오류)는 FAIL', async () => {
  const mutants = {
    '/members/ 비로그인': { 'GET /members/': () => new Response('<html></html>', { status: 200 }) },
    'Origin 없는 POST': { 'POST /api/auth/logout': () => new Response('{}', { status: 200, headers: jsonHeaders() }) },
    '비공개 파일': { 'GET /.dev.vars': () => new Response('X=1', { status: 200 }) },
    '/api/items': { 'GET /api/items': () => new Response('{}', { status: 503, headers: jsonHeaders() }) },
    '/version.json': { 'GET /version.json': () => new Response(JSON.stringify({ commit: 'b'.repeat(40), dirty: false, builtAt: 'x' }), { status: 200, headers: jsonHeaders() }) },
  };
  for (const [name, override] of Object.entries(mutants)) {
    const rows = await runChecks('http://127.0.0.1:8790', { fetchImpl: fakeServer(override), localCommit: HEAD });
    assert.equal(rows.find((r) => r.name === name).status, 'FAIL', name);
    assert.equal(rows.filter((r) => r.status === 'FAIL').length, 1, `${name}: 다른 항목은 영향 없음`);
  }
});

test('runChecks: 요청 실패는 본문 없이 FAIL 로만 알린다', async () => {
  const rows = await runChecks('http://127.0.0.1:8790', { fetchImpl: async () => { throw new Error('secret-in-error'); } });
  assert.ok(rows.every((r) => r.status === 'FAIL'));
  assert.ok(!JSON.stringify(rows).includes('secret-in-error'));
});

test('parseVerifyArgs', () => {
  assert.deepEqual(parseVerifyArgs(['--url', 'https://a.b', '--commit', 'skip', '--retries', '2', '--wait', '1']), { url: 'https://a.b', commit: 'skip', retries: 2, wait: 1 });
  assert.throws(() => parseVerifyArgs(['--nope']));
  assert.throws(() => parseVerifyArgs(['--retries', '-1']));
});
