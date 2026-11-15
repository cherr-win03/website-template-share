#!/usr/bin/env node
// 로컬 개발 서버: version-stamp → .dev.vars 확인 → wrangler dev(127.0.0.1 고정).
// 사용: node scripts/dev.mjs [--port 8790] [--fake-auth] [--setup]
//   --fake-auth  scripts/fake-supabase.mjs(127.0.0.1:54321)를 함께 띄우고 로그인을 켠 채로 연다.
//   --setup      먼저 setup-local(마이그레이션·시드)을 돌린다(시험 서버용).
// 포트가 이미 쓰이면 그 프로세스를 죽이지 않고 안내만 하고 끝낸다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DEFAULT_PORT, FAKE_AUTH_PORT, ROOT, isMain, portBusy, waitForPort, wranglerBin } from './lib/ops.mjs';
import { writeStamp } from './version-stamp.mjs';
import { setupLocal } from './setup-local.mjs';

export function parseDevArgs(argv, env = process.env) {
  const opts = { port: DEFAULT_PORT, fakeAuth: false, setup: false };
  const fromEnv = env.DEV_PORT;
  let raw = fromEnv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake-auth') opts.fakeAuth = true;
    else if (a === '--setup') opts.setup = true;
    else if (a === '--port') raw = argv[++i];
    else if (a.startsWith('--port=')) raw = a.slice(7);
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (raw !== undefined) {
    if (!/^\d+$/.test(String(raw)) || Number(raw) < 1 || Number(raw) > 65535) throw new Error('포트는 1~65535 정수여야 합니다.');
    opts.port = Number(raw);
  }
  return opts;
}

/** wrangler dev 인자. --var 는 .dev.vars 보다 우선한다(wrangler 4.148 에서 확인). APP_ORIGIN 은 Origin 검사 때문에 포트와 항상 맞춘다. */
export function wranglerDevArgs({ port, fakeAuth }) {
  const args = ['dev', '--ip', '127.0.0.1', '--port', String(port), '--var', `APP_ORIGIN:http://127.0.0.1:${port}`];
  if (fakeAuth) args.push('--var', 'AUTH_ACTIVATION:enabled', '--var', `SUPABASE_URL:http://127.0.0.1:${FAKE_AUTH_PORT}`);
  return args;
}

/** 자식 프로세스와 그 하위(wrangler → workerd)를 함께 끝낸다. */
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function main() {
  let opts;
  try { opts = parseDevArgs(process.argv.slice(2)); } catch (e) { console.error(`오류: ${e.message}`); return 2; }

  if (await portBusy(opts.port)) {
    console.error(`포트 ${opts.port} 는 이미 127.0.0.1 에서 쓰이고 있습니다. 기존 프로세스는 그대로 두었습니다.`);
    console.error(`다른 포트로 열려면: node scripts/dev.mjs --port ${port + 1}`);
    return 1;
  }
  if (opts.fakeAuth && await portBusy(FAKE_AUTH_PORT)) {
    console.error(`가짜 로그인 서버 포트 ${FAKE_AUTH_PORT} 가 이미 쓰이고 있습니다. 기존 프로세스는 그대로 두었습니다.`);
    return 1;
  }

  if (opts.setup) { const code = setupLocal(); if (code !== 0) return code; }
  const { stamp } = writeStamp();
  console.log(`version.json: commit ${stamp.commit.slice(0, 8)}, dirty ${stamp.dirty}`);
  if (!fs.existsSync(path.join(ROOT, '.dev.vars'))) {
    console.error('오류: .dev.vars 가 없습니다. 먼저 npm run setup 을 실행하세요(견본을 복사하고 로컬 DB 를 준비합니다).');
    return 1;
  }

  const children = [];
  let stopping = false;
  const stopAll = () => { stopping = true; for (const c of children) killTree(c); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { stopAll(); process.exit(0); });
  process.on('exit', stopAll);

  if (opts.fakeAuth) {
    const fake = path.join(ROOT, 'scripts', 'fake-supabase.mjs');
    if (!fs.existsSync(fake)) { console.error('오류: scripts/fake-supabase.mjs 가 없습니다.'); return 1; }
    const f = spawn(process.execPath, [fake], { cwd: ROOT, stdio: 'inherit' });
    children.push(f);
    f.once('exit', (code) => { if (!stopping) { console.error(`가짜 로그인 서버가 끝났습니다(코드 ${code}). 개발 서버도 끝냅니다.`); stopAll(); process.exit(1); } });
    const up = await waitForPort(FAKE_AUTH_PORT, { timeoutMs: 15000, alive: () => f.exitCode === null });
    if (!up) { console.error(`오류: 가짜 로그인 서버가 127.0.0.1:${FAKE_AUTH_PORT} 에서 열리지 않았습니다.`); stopAll(); return 1; }
    console.log(`가짜 Supabase 준비됨 (127.0.0.1:${FAKE_AUTH_PORT}, 이메일 코드 123456)`);
  }

  const w = spawn(process.execPath, [wranglerBin(), ...wranglerDevArgs(opts)], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  children.push(w);
  return new Promise((resolve) => {
    w.once('exit', (code) => { stopAll(); resolve(code ?? 0); });
    w.once('error', (e) => { console.error(`wrangler 실행 실패: ${e.message}`); stopAll(); resolve(1); });
  });
}

if (isMain(import.meta.url)) main().then((code) => process.exit(code));
