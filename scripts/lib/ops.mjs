// 운영 스크립트(setup·dev·deploy·verify·rollback·a11y)가 함께 쓰는 작은 도구 모음.
// 이 파일은 로컬 도구 전용이다. Worker·화면 코드에서 가져오지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 저장소 루트(이 파일은 scripts/lib/ 아래). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 시험·점검 출력은 저장소 밖 ..\qa 에 둔다. SITE_QA_DIR 로 바꿀 수 있다. */
export const qaDir = (env = process.env) => (env.SITE_QA_DIR ? path.resolve(env.SITE_QA_DIR) : path.resolve(ROOT, '..', 'qa'));

export const DEFAULT_PORT = 8790;
export const FAKE_AUTH_PORT = 54321;

/** 이 파일이 `node 파일` 로 직접 실행됐는지(가져온 것이 아닌지). Windows 대소문자·구분자 차이를 흡수한다. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const norm = (p) => path.resolve(p).toLowerCase();
  return norm(argv1) === norm(fileURLToPath(metaUrl));
}

/** JSONC(주석·꼬리 쉼표 허용) → 순수 JSON 문자열. 문자열 안의 // 는 건드리지 않는다. */
export function stripJsonc(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  let out = '';
  let quote = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; out += ch; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  // 꼬리 쉼표 제거(문자열 밖의 `, }` `, ]` 만).
  let res = '';
  quote = false;
  escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (quote) {
      res += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; res += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    res += ch;
  }
  return res;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

export function readConfig(root = ROOT) {
  return parseJsonc(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
}

/**
 * 이 폴더가 독립된 git 저장소일 때만 git 결과를 쓴다.
 * 템플릿을 .git 없이 복사해 다른 저장소 안에 두면 바깥 저장소의 커밋이 섞이므로 null 로 처리한다.
 */
export function git(args, root = ROOT) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (top.status !== 0) return null;
  const norm = (p) => path.resolve(p.trim()).toLowerCase();
  if (norm(String(top.stdout)) !== norm(root)) return null;
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  return String(r.stdout).trim();
}

export const wranglerBin = (root = ROOT) => path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** wrangler 를 셸 없이 부른다(Windows 에서 .cmd 문제와 인자 해석 문제를 피함). */
export function runWrangler(args, { root = ROOT, env = process.env, input, stdio, capture = true } = {}) {
  const options = { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, shell: false };
  if (capture) Object.assign(options, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (stdio) options.stdio = stdio;
  return spawnSync(process.execPath, [wranglerBin(root), ...args], options);
}

/** npm 을 부른다. Windows 에서는 npm.cmd 라 셸이 필요하다(인자는 고정 문자열만 넣는다). */
export function runNpm(args, { root = ROOT, env = process.env, capture = true } = {}) {
  return spawnSync('npm', args, { cwd: root, env, shell: process.platform === 'win32', encoding: capture ? 'utf8' : undefined, stdio: capture ? undefined : 'inherit', maxBuffer: 64 * 1024 * 1024 });
}

// ---- wrangler 출력 허용 목록 필터 ----
const ALLOW = [
  /^\s*env\.[A-Za-z0-9_]+\s+\(.*\)\s+(D1 Database|Rate Limit|Assets|KV Namespace|R2 Bucket|Queue)\s*$/,
  /^\s*env\.(DB|ASSETS)\b/,
  /^\s*env\.[A-Z0-9_]+_RATE_LIMITER \(\d+ requests\/\d+s\)\s+Rate Limit\s*$/,
  /^\s*Your Worker has access to the following bindings:?\s*$/,
  /^\s*Binding\s+Resource\s*$/,
  /^\s*Total Upload: /,
  /^\s*Worker Startup Time: \d+ ms\s*$/,
  /^\s*Uploaded [a-z0-9-]+ \(/,
  /^\s*Deployed [a-z0-9-]+ triggers \(/,
  /^\s*https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev\s*$/,
  /^\s*(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63} \(custom domain\)\s*$/,
  /^\s*Current Version ID: [0-9a-f-]{36}\s*$/,
  /^\s*--dry-run: exiting now\.\s*$/,
  /^\s*No updated asset files to upload/,
  /^\s*Uploading \d+ new assets?/,
  /^\s*(✨|🌀) /,
  /^\s*⛅️ wrangler \d/,
  /^\s*─+\s*$/,
  /^\s*$/,
];
// 변수 줄은 이름만 보여 준다(값은 숨김).
const VAR_LINE = /^(\s*)env\.([A-Za-z0-9_]+)\s+\(.*\)\s+Environment Variable\s*$/;
const REMOTE_DIFF = /differs from the remote|remote configuration|dashboard/i;

/** wrangler 출력에서 허용된 줄만 남긴다. 원격 설정 차이 경고가 있으면 전부 버린다(사용자가 직접 확인). */
export function filterWranglerOutput(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  if (REMOTE_DIFF.test(raw)) return { shown: [], suppressed: lines.filter((l) => l.trim()).length, remoteDiff: true };
  const shown = [];
  let suppressed = 0;
  for (const line of lines) {
    const v = VAR_LINE.exec(line);
    if (v) { shown.push(`${v[1]}env.${v[2]} (값 숨김) Environment Variable`); continue; }
    if (ALLOW.some((re) => re.test(line))) shown.push(line);
    else if (line.trim()) suppressed++;
  }
  const compact = shown.filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  return { shown: compact, suppressed, remoteDiff: false };
}

export function printFiltered(text, out = console.log) {
  const f = filterWranglerOutput(text);
  if (f.remoteDiff) out('  (wrangler 가 원격 설정 차이를 알렸습니다. 출력을 숨겼습니다. 대시보드 설정을 확인한 뒤 직접 실행하세요.)');
  for (const l of f.shown) if (l.trim()) out(`  ${l.trim()}`);
  if (f.suppressed) out(`  (허용 목록 밖의 ${f.suppressed}줄은 출력하지 않았습니다)`);
}

// ---- 표 출력 ----
/** 터미널 표시 폭(한글·일본어 전각은 2칸). */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - displayWidth(s)));

/** rows: [{ status: 'PASS'|'WARN'|'FAIL', name, detail }] → 표 문자열. */
export function formatTable(rows) {
  const w1 = 4;
  const w2 = Math.max(4, ...rows.map((r) => displayWidth(r.name)));
  const lines = [`${pad('결과', 6)}${pad('항목', w2 + 2)}내용`, `${'-'.repeat(6)}${'-'.repeat(w2 + 2)}${'-'.repeat(40)}`];
  for (const r of rows) lines.push(`${pad(r.status, 6)}${pad(r.name, w2 + 2)}${r.detail ?? ''}`);
  void w1;
  return lines.join('\n');
}

export function countStatus(rows) {
  const n = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of rows) n[r.status] = (n[r.status] ?? 0) + 1;
  return n;
}

export const hasFail = (rows) => rows.some((r) => r.status === 'FAIL');

// ---- 포트 ----
/** 127.0.0.1:port 에 누가 듣고 있는지(연결되면 사용 중). */
export function portInUse(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 위 연결 확인 + 실제 listen 시도. 어느 쪽이든 쓰는 중이면 true. */
export async function portBusy(port) {
  if (await portInUse(port)) return true;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 포트가 열릴 때까지 기다린다. */
export async function waitForPort(port, { timeoutMs = 15000, intervalMs = 200, alive = () => true } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!alive()) return false;
    if (await portInUse(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}
