// 경로 정규화·로그인 전 차단 우회 시험·returnTo 안전화(CONTRACT 3-3절).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { protectedPrefixes } from '../worker/auth/gate.js';
import { normalizePath, pathHasPrefix, safeReturnTo } from '../worker/path.js';
import { authEnv, makeEnv, send } from './helpers/worker-env.js';

describe('normalizePath', () => {
  const table = [
    ['/', '/'],
    ['/members/', '/members'],
    ['/Members/', '/members'],
    ['/members//x', '/members/x'],
    ['//members', '/members'],
    ['/%6Dembers/', '/members'],
    ['/members%2Fx', '/members/x'],
    ['/members%5Cx', '/members/x'],
    ['/members\\x', '/members/x'],
    ['/public/../members/x', '/members/x'],
    ['/public/%2e%2e/members', '/members'],
    ['/./members/./x', '/members/x'],
    ['/%256Dembers/', '/members'],
    ['/%25256Dembers/', '/members'],
    ['/members/%E0%A4%A', '/members/%e0%a4%a'],
    ['/../../members', '/members'],
  ];
  for (const [input, expected] of table) it(`${input} → ${expected}`, () => assert.equal(normalizePath(input), expected));

  it('구간 경계로만 접두어를 본다', () => {
    assert.equal(pathHasPrefix('/members', '/members'), true);
    assert.equal(pathHasPrefix('/members/x', '/members'), true);
    assert.equal(pathHasPrefix('/membersx', '/members'), false);
    assert.equal(pathHasPrefix('/api/membership', '/api/members'), false);
  });
});

describe('로그인 전 차단 우회 시험(로그인 꺼짐 = 항상 막힘)', () => {
  const pages = [
    '/members/',
    '/members',
    '/Members/',
    '/MEMBERS/index.html',
    '/members//index.html',
    '//members/',
    '/%6Dembers/',
    '/%256Dembers/',
    '/members%2Findex.html',
    '/members%5Cindex.html',
    '/public/../members/',
    '/x/%2e%2e/members/',
    '/members/%E0%A4%A',
    '/members/secret.png',
    `/members/${'a'.repeat(2000)}`,
  ];
  for (const path of pages) {
    it(`페이지 ${path.slice(0, 60)} → 302 로그인`, async () => {
      const env = makeEnv();
      const response = await send(env, path);
      assert.equal(response.status, 302, path);
      assert.match(response.headers.get('location'), /^\/login\/\?returnTo=/);
      assert.equal(env.ASSETS.calls.length, 0, 'ASSETS 를 부르지 않아야 한다');
    });
  }

  const apis = ['/api/members/hello', '/API/MEMBERS/HELLO', '/api//members/hello', '/api/%6Dembers/hello', '/api%2Fmembers%2Fhello', '/api/public/../members/hello', '/api/members/', '/api/members/nope'];
  for (const path of apis) {
    it(`API ${path} → 401 SIGN_IN_REQUIRED`, async () => {
      const response = await send(makeEnv(), path);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: 'SIGN_IN_REQUIRED' });
    });
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`페이지 ${method} /members/ → 303`, async () => {
      const response = await send(makeEnv(), '/members/', { method });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/login/?returnTo=%2Fmembers%2F');
    });
  }

  it('HEAD /members/ → 302', async () => {
    const response = await send(makeEnv(), '/members/', { method: 'HEAD' });
    assert.equal(response.status, 302);
  });

  it('returnTo 에 원래 경로와 검색어를 담는다', async () => {
    const response = await send(makeEnv(), '/members/?tab=2');
    assert.equal(response.headers.get('location'), '/login/?returnTo=%2Fmembers%2F%3Ftab%3D2');
  });

  it('로그인이 켜져 있어도 쿠키가 없으면 막힌다', async () => {
    const response = await send(authEnv(), '/members/');
    assert.equal(response.status, 302);
  });

  it('로그인이 꺼져 있으면 위조 쿠키로도 열리지 않는다', async () => {
    const response = await send(makeEnv(), '/api/members/hello', { headers: { cookie: `__Host-site-session=${'a'.repeat(64)}` } });
    assert.equal(response.status, 401);
  });

  it('로그인 설정이 틀리면(AUTH_ACTIVATION=yes) 보호 경로는 닫힌다', async () => {
    const response = await send(authEnv({ AUTH_ACTIVATION: 'yes' }), '/members/');
    assert.equal(response.status, 302);
  });

  it('비슷하지만 다른 경로는 막지 않는다', async () => {
    const env = makeEnv();
    assert.equal((await send(env, '/membersx')).status, 404);
    assert.equal((await send(env, '/api/membership')).status, 404);
    assert.equal((await send(env, '/login/')).status, 200);
    assert.equal((await send(env, '/')).status, 200);
  });
});

describe('PROTECTED_PATHS 설정', () => {
  it('없으면 기본값, 빈 값이면 아무것도 막지 않는다', () => {
    assert.deepEqual(protectedPrefixes({}), ['/members', '/api/members']);
    assert.deepEqual(protectedPrefixes({ PROTECTED_PATHS: '' }), []);
    assert.deepEqual(protectedPrefixes({ PROTECTED_PATHS: ' /Private/ , /api/private ,/private' }), ['/private', '/api/private']);
  });
  for (const value of ['members/', '/', '/login/', '/api/', '/api/auth/x', '/api/health']) {
    it(`틀린 값 "${value}" → 모든 요청 503`, async () => {
      const env = makeEnv({ PROTECTED_PATHS: value });
      const page = await send(env, '/');
      assert.equal(page.status, 503);
      const api = await send(env, '/api/health');
      assert.deepEqual(await api.json(), { error: 'SERVICE_UNAVAILABLE' });
    });
  }
  it('다른 접두어도 막는다(/private/)', async () => {
    const env = makeEnv({ PROTECTED_PATHS: '/private/' });
    assert.equal((await send(env, '/PRIVATE/a')).status, 302);
    assert.equal((await send(env, '/members/')).status, 200);
  });
});

describe('safeReturnTo', () => {
  const table = [
    ['/members/', '/members/'],
    ['/a?b=1#c', '/a?b=1#c'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['\\\\evil.example', '/'],
    ['https://evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['/\tevil', '/'],
    ['/%0d%0aSet-Cookie:x', '/%0d%0aSet-Cookie:x'],
    ['/\n/evil.example', '/'],
    ['', '/'],
    [null, '/'],
    [42, '/'],
    [`/${'a'.repeat(3000)}`, '/'],
    ['members', '/'],
  ];
  for (const [input, expected] of table) it(`${JSON.stringify(input)?.slice(0, 40)} → ${expected}`, () => assert.equal(safeReturnTo(input), expected));
});
