// deploy-guard 의 순수 함수 시험(wrangler·네트워크 없음).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkConfig, devVarsSecretValues, evaluateAccount, loadDeployConfig, scanDir, scanText, secretGuidance, wranglerEnv } from '../scripts/deploy-guard.mjs';
import { filterWranglerOutput, parseJsonc, stripJsonc } from '../scripts/lib/ops.mjs';

const GOOD = {
  name: 'acme-site',
  account_id: 'a'.repeat(32),
  vars: { APP_ORIGIN: 'https://acme.example.org', AUTH_ACTIVATION: 'disabled', SUPABASE_URL: '' },
  d1_databases: [{ binding: 'DB', database_name: 'acme-db', database_id: '11111111-2222-3333-4444-555555555555' }],
  ratelimits: [{ name: 'AUTH_RATE_LIMITER', namespace_id: '3141' }],
};
const statusOf = (rows, name) => rows.find((r) => r.name === name)?.status;
const clone = (o) => JSON.parse(JSON.stringify(o));

test('checkConfig: 값을 모두 바꾼 설정은 FAIL 이 없다', () => {
  const rows = checkConfig(GOOD);
  assert.deepEqual(rows.filter((r) => r.status === 'FAIL'), []);
});

test('checkConfig: 자리표시 값은 각각 FAIL', () => {
  const rows = checkConfig({
    name: 'my-site',
    vars: { APP_ORIGIN: 'https://example.com', AUTH_ACTIVATION: 'disabled' },
    d1_databases: [{ binding: 'DB', database_name: 'my-site-db', database_id: '00000000-0000-0000-0000-000000000000' }],
    ratelimits: [{ name: 'AUTH_RATE_LIMITER', namespace_id: '2001' }],
  });
  assert.equal(statusOf(rows, 'name'), 'FAIL');
  assert.equal(statusOf(rows, 'account_id'), 'FAIL');
  assert.equal(statusOf(rows, 'APP_ORIGIN'), 'FAIL');
  assert.equal(statusOf(rows, 'D1 DB'), 'FAIL');
  assert.equal(statusOf(rows, 'D1 DB 이름'), 'WARN');
  assert.equal(statusOf(rows, 'ratelimit AUTH_RATE_LIMITER'), 'WARN');
});

test('checkConfig: account_id 형식, APP_ORIGIN 형식', () => {
  const a = clone(GOOD); a.account_id = 'XYZ';
  assert.equal(statusOf(checkConfig(a), 'account_id'), 'FAIL');
  for (const bad of ['http://acme.example.org', 'https://acme.example.org/', 'acme.example.org']) {
    const b = clone(GOOD); b.vars.APP_ORIGIN = bad;
    assert.equal(statusOf(checkConfig(b), 'APP_ORIGIN'), 'FAIL', bad);
  }
});

test('checkConfig: AUTH_ACTIVATION enabled 는 SUPABASE_URL 이 https 여야 한다', () => {
  const on = (url) => { const c = clone(GOOD); c.vars.AUTH_ACTIVATION = 'enabled'; c.vars.SUPABASE_URL = url; return checkConfig(c); };
  assert.equal(statusOf(on('http://127.0.0.1:54321'), 'SUPABASE_URL'), 'FAIL');
  assert.equal(statusOf(on(''), 'SUPABASE_URL'), 'FAIL');
  assert.equal(statusOf(on('https://abc.supabase.co'), 'AUTH_ACTIVATION'), 'PASS');
  const weird = clone(GOOD); weird.vars.AUTH_ACTIVATION = 'on';
  assert.equal(statusOf(checkConfig(weird), 'AUTH_ACTIVATION'), 'FAIL');
});

test('checkConfig: 해석하지 못한 설정은 FAIL 한 줄', () => {
  assert.equal(checkConfig(null)[0].status, 'FAIL');
});

test('secretGuidance: 로그인이 켜지면 필수 secret 이름을 안내한다', () => {
  assert.match(secretGuidance({ vars: { AUTH_ACTIVATION: 'enabled' } }).detail, /SUPABASE_PUBLISHABLE_KEY.*SESSION_ENCRYPTION_KEY/);
  assert.equal(secretGuidance({ vars: {} }).status, 'PASS');
});

test('scanText: 비밀값 모양을 규칙 이름으로만 알린다(값은 결과에 없음)', () => {
  const samples = {
    // 가짜 값이다. GitHub 비밀 검사에 걸리지 않게 실행할 때 조립한다.
    '개인키 머리': '-----BEGIN ' + 'PRIVATE KEY-----\nabc',
    'sk_ 키': 'const k = "sk_' + 'live_abcdefghij1234567890";',
    'GitHub 토큰': 'token gh' + 'p_abcdefghijklmnopqrstuvwxyz0123',
    'AWS 키': 'AKI' + 'AABCDEFGHIJKLMNOP',
    JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  };
  for (const [rule, text] of Object.entries(samples)) {
    const hits = scanText('x.js', text);
    assert.ok(hits.some((h) => h.rule === rule), rule);
    assert.ok(!JSON.stringify(hits).includes('abcdefghij'), '값이 결과에 섞임');
  }
  assert.deepEqual(scanText('ok.js', 'const a = "local-fake-publishable-key"; // sk 는 약어'), []);
});

test('devVarsSecretValues: 비밀 이름의 값만 모으고 짧은 값·일반 변수는 뺀다', () => {
  const found = devVarsSecretValues('APP_ORIGIN=http://127.0.0.1:8790\nSESSION_ENCRYPTION_KEY=abcdefgh12345678\nSOME_TOKEN=short\n# X_SECRET=commented-out-value\nAPI_PASSWORD="quoted-value-9"');
  assert.deepEqual(found.map((f) => f.name), ['SESSION_ENCRYPTION_KEY', 'API_PASSWORD']);
  assert.equal(found[1].value, 'quoted-value-9');
  const hits = scanText('bundle.js', 'x = "abcdefgh12345678"', found);
  assert.deepEqual(hits, [{ file: 'bundle.js', rule: '.dev.vars 값(SESSION_ENCRYPTION_KEY)' }]);
});

test('scanDir: .map 은 거부, 비밀 파일 이름과 비밀값 모양을 잡고, 깨끗한 폴더는 통과', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const x = 1;');
    let r = scanDir(dir);
    assert.deepEqual([r.maps, r.hits], [[], []]);
    assert.equal(r.files, 1);

    fs.writeFileSync(path.join(dir, 'sub', 'a.js.map'), '{}');
    fs.writeFileSync(path.join(dir, '.dev.vars'), 'X=1');
    fs.writeFileSync(path.join(dir, 'b.js'), 'k="sk_test_abcdefghijklmnop"');
    r = scanDir(dir);
    assert.deepEqual(r.maps, ['sub/a.js.map']);
    assert.ok(r.hits.some((h) => h.rule === '비밀 파일이 묶음에 들어 있음'));
    assert.ok(r.hits.some((h) => h.rule === 'sk_ 키' && h.file === 'b.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateAccount: 로그인 계정 목록에 account_id 가 있어야 한다', () => {
  const id = 'b'.repeat(32);
  assert.equal(evaluateAccount({ loggedIn: true, accounts: [{ id, name: 'Acme' }] }, id).ok, true);
  assert.match(evaluateAccount({ loggedIn: true, accounts: [{ id: 'c'.repeat(32), name: 'Other' }] }, id).reason, /account_id/);
  assert.equal(evaluateAccount({ loggedIn: false }, id).ok, false);
  assert.equal(evaluateAccount(null, id).ok, false);
  assert.equal(evaluateAccount({ loggedIn: true, accounts: [{ id, name: 'A' }] }, 'nope').ok, false);
  assert.equal(evaluateAccount({ loggedIn: true }, id).ok, false);
});

test('wranglerEnv: loginDir 이 있으면 계정 변수를 지우고 그 폴더를 쓴다', () => {
  const env = { PATH: 'p', CLOUDFLARE_API_TOKEN: 't', cf_account_id: 'x', XDG_CONFIG_HOME: 'old' };
  const plain = wranglerEnv(env, { accountId: 'a'.repeat(32) });
  assert.equal(plain.CLOUDFLARE_API_TOKEN, 't');
  assert.equal(plain.CLOUDFLARE_ACCOUNT_ID, 'a'.repeat(32));
  const iso = wranglerEnv(env, { loginDir: '/login-dir' });
  assert.equal(iso.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(iso.cf_account_id, undefined);
  assert.equal(iso.XDG_CONFIG_HOME, '/login-dir');
  assert.equal(iso.PATH, 'p');
  assert.equal(iso.WRANGLER_SEND_METRICS, 'false');
});

test('loadDeployConfig: 파일·환경 변수로 loginDir 을 켠다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-cfg-'));
  try {
    assert.deepEqual(loadDeployConfig(dir, {}), { loginDir: null, branch: 'main' });
    fs.writeFileSync(path.join(dir, 'deploy.config.json'), JSON.stringify({ loginDir: '../cf-site', branch: 'release' }));
    const c = loadDeployConfig(dir, {});
    assert.equal(c.loginDir, path.resolve(dir, '../cf-site'));
    assert.equal(c.branch, 'release');
    assert.equal(loadDeployConfig(dir, { DEPLOY_LOGIN_DIR: dir }).loginDir, path.resolve(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSONC: 주석·꼬리 쉼표를 처리하고 문자열 안의 // 는 보존한다', () => {
  const v = parseJsonc('{\n // c\n "a": "https://x.y/z", /* b */ "b": [1,2,],\n}');
  assert.deepEqual(v, { a: 'https://x.y/z', b: [1, 2] });
  assert.equal(stripJsonc('{"k":"//not-comment"}'), '{"k":"//not-comment"}');
});

test('filterWranglerOutput: 변수 값을 숨기고 허용 밖 줄은 줄 수만 알린다, 원격 차이는 전부 숨긴다', () => {
  const out = [
    ' ⛅️ wrangler 4.148.0',
    'Your Worker has access to the following bindings:',
    'env.APP_ORIGIN ("https://secret.example") Environment Variable',
    'env.DB (acme-db) D1 Database',
    'Total Upload: 10.00 KiB / gzip: 3.00 KiB',
    'Author: someone@example.com',
  ].join('\n');
  const f = filterWranglerOutput(out);
  assert.ok(f.shown.some((l) => l.includes('env.APP_ORIGIN (값 숨김)')));
  assert.ok(!JSON.stringify(f.shown).includes('secret.example'));
  assert.ok(!JSON.stringify(f.shown).includes('someone@'));
  assert.equal(f.suppressed, 1);
  const remote = filterWranglerOutput('The local configuration differs from the remote configuration\nenv.DB (x) D1 Database');
  assert.deepEqual([remote.shown, remote.remoteDiff], [[], true]);
});
