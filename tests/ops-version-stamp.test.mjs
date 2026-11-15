// version-stamp, dev 인자, rollback 인자 시험(git·wrangler 실제 호출 없음).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseDevArgs, wranglerDevArgs } from '../scripts/dev.mjs';
import { parseRollbackArgs, ROLLBACK_NOTICE, summarizeDeployments } from '../scripts/deploy-rollback.mjs';
import { ensureDevVars } from '../scripts/setup-local.mjs';
import { buildStamp, writeStamp } from '../scripts/version-stamp.mjs';

const fakeGit = (head, status) => (args) => (args[0] === 'rev-parse' ? head : status);
const NOW = new Date('2026-11-14T00:00:00.000Z');

test('buildStamp: { commit, dirty, builtAt } 모양', () => {
  const h = 'c'.repeat(40);
  assert.deepEqual(buildStamp({ git: fakeGit(h, ''), now: NOW }), { commit: h, dirty: false, builtAt: NOW.toISOString() });
  assert.equal(buildStamp({ git: fakeGit(h, ' M a.js'), now: NOW }).dirty, true);
});

test('buildStamp: git 이 없으면 commit unknown, dirty true', () => {
  assert.deepEqual(buildStamp({ git: () => null, now: NOW }), { commit: 'unknown', dirty: true, builtAt: NOW.toISOString() });
  assert.equal(buildStamp({ git: fakeGit('not-a-hash', ''), now: NOW }).commit, 'unknown');
});

test('writeStamp: public/version.json 을 쓰고 키는 세 개뿐이다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-stamp-'));
  try {
    const { file } = writeStamp({ root, git: fakeGit('d'.repeat(40), ''), now: NOW });
    assert.equal(file, path.join(root, 'public', 'version.json'));
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(v).sort(), ['builtAt', 'commit', 'dirty']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDevVars: 없을 때만 견본을 복사하고 있으면 건드리지 않는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-setup-'));
  try {
    assert.equal(ensureDevVars(root), 'missing-example');
    fs.writeFileSync(path.join(root, '.dev.vars.example'), 'A=example\n');
    assert.equal(ensureDevVars(root), 'created');
    assert.equal(fs.readFileSync(path.join(root, '.dev.vars'), 'utf8'), 'A=example\n');
    fs.writeFileSync(path.join(root, '.dev.vars'), 'A=mine\n');
    assert.equal(ensureDevVars(root), 'exists');
    assert.equal(fs.readFileSync(path.join(root, '.dev.vars'), 'utf8'), 'A=mine\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseDevArgs · wranglerDevArgs', () => {
  assert.deepEqual(parseDevArgs([], {}), { port: 8790, fakeAuth: false, setup: false });
  assert.deepEqual(parseDevArgs(['--fake-auth', '--port', '8798', '--setup'], {}), { port: 8798, fakeAuth: true, setup: true });
  assert.equal(parseDevArgs([], { DEV_PORT: '9001' }).port, 9001);
  assert.throws(() => parseDevArgs(['--port', 'abc'], {}));
  assert.throws(() => parseDevArgs(['--port', '70000'], {}));
  assert.throws(() => parseDevArgs(['--wat'], {}));

  const plain = wranglerDevArgs({ port: 8790, fakeAuth: false });
  assert.deepEqual(plain.slice(0, 5), ['dev', '--ip', '127.0.0.1', '--port', '8790']);
  assert.ok(plain.includes('APP_ORIGIN:http://127.0.0.1:8790'));
  assert.ok(!plain.some((a) => a.startsWith('AUTH_ACTIVATION')));
  const fake = wranglerDevArgs({ port: 8798, fakeAuth: true });
  assert.ok(fake.includes('AUTH_ACTIVATION:enabled'));
  assert.ok(fake.includes('SUPABASE_URL:http://127.0.0.1:54321'));
  assert.ok(fake.includes('APP_ORIGIN:http://127.0.0.1:8798'));
  assert.ok(!fake.includes('0.0.0.0'));
});

test('parseRollbackArgs: version-id(UUID)만, --yes 는 --to 와 함께만', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(parseRollbackArgs([]), { to: null, yes: false });
  assert.deepEqual(parseRollbackArgs(['--to', id]), { to: id, yes: false });
  assert.deepEqual(parseRollbackArgs(['--to', id, '--yes']), { to: id, yes: true });
  assert.ok(parseRollbackArgs(['--yes']).error);
  assert.ok(parseRollbackArgs(['--to', 'latest']).error);
  assert.ok(parseRollbackArgs(['--to', id, '--force']).error);
});

test('summarizeDeployments: 최신순, 작성자 이메일은 싣지 않는다', () => {
  const lines = summarizeDeployments([
    { created_on: '2026-11-01T00:00:00Z', author_email: 'a@example.com', versions: [{ version_id: 'v-old', percentage: 100 }] },
    { created_on: '2026-11-02T00:00:00Z', author_email: 'b@example.com', versions: [{ version_id: 'v-new', percentage: 100 }], annotations: { 'workers/message': 'deploy abc12345' } },
  ]);
  assert.match(lines[0], /^현재 .*v-new \(100%\).*deploy abc12345/);
  assert.match(lines[1], /v-old/);
  assert.ok(!lines.join('\n').includes('@example.com'));
  assert.deepEqual(summarizeDeployments(null), []);
});

test('롤백 안내문은 D1 이 되돌아가지 않고 변수·secret 은 되돌아간다고 말한다', () => {
  assert.match(ROLLBACK_NOTICE, /D1 데이터와 이미 적용한 마이그레이션은 되돌아가지 않습니다/);
  assert.match(ROLLBACK_NOTICE, /변수와 secret 은 버전과 함께 되돌아갑니다/);
});
