#!/usr/bin/env node
// 배포 보호 장치. 사용:
//   node scripts/deploy-guard.mjs check [--skip-tests]   오프라인 점검(업로드하지 않음)
//   node scripts/deploy-guard.mjs release [--yes]        점검 → 계정·git 확인 → (--yes 일 때만) 배포 → 배포 점검
//   node scripts/deploy-guard.mjs whoami | login         (선택) 사이트 전용 로그인 폴더를 쓸 때
// 선택 설정: 저장소 루트 deploy.config.json { "loginDir": "../runtime/cf-내사이트", "branch": "main" }
//            또는 환경 변수 DEPLOY_LOGIN_DIR. loginDir 이 있으면 wrangler 는 그 폴더의 로그인만 쓰고
//            CLOUDFLARE_API_TOKEN 등 계정 환경 변수는 자식 프로세스에서 지운다(다른 계정으로 새는 사고 방지).
// 이 스크립트는 wrangler login·secret put·d1 migrations apply 를 하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, countStatus, filterWranglerOutput, formatTable, git, hasFail, isMain, printFiltered, qaDir, readConfig, runNpm, runWrangler } from './lib/ops.mjs';
import { writeStamp } from './version-stamp.mjs';
import { runWithRetries } from './post-deploy-check.mjs';

export const REQUIRED_SECRETS = ['SUPABASE_PUBLISHABLE_KEY', 'SESSION_ENCRYPTION_KEY'];
const ZERO_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const SECRET_KEY_NAME = /(KEY|SECRET|TOKEN|PASSWORD)/i;

const row = (status, name, detail) => ({ status, name, detail });

// ---- 1. 설정 점검 ----
/** wrangler.jsonc(파싱된 객체)의 자리표시 값·로그인 설정을 점검한다. 파일을 읽지 않는 순수 함수. */
export function checkConfig(cfg) {
  const rows = [];
  const vars = cfg?.vars ?? {};
  if (!cfg || typeof cfg !== 'object') return [row('FAIL', '설정 읽기', 'wrangler.jsonc 를 해석하지 못했습니다')];

  rows.push(!cfg.name || cfg.name === 'my-site' ? row('FAIL', 'name', `"${cfg.name ?? ''}" 은 자리표시 값입니다. 사이트 이름으로 바꾸세요`) : row('PASS', 'name', cfg.name));
  if (!cfg.account_id) rows.push(row('FAIL', 'account_id', '없음. 배포할 Cloudflare 계정 ID 를 적으세요(릴리스가 로그인 계정과 대조합니다)'));
  else if (!ACCOUNT_ID.test(String(cfg.account_id))) rows.push(row('FAIL', 'account_id', '32자리 소문자 16진수가 아닙니다'));
  else rows.push(row('PASS', 'account_id', `${String(cfg.account_id).slice(0, 4)}…(대조는 release 에서)`));

  const origin = vars.APP_ORIGIN;
  if (!origin || origin === 'https://example.com') rows.push(row('FAIL', 'APP_ORIGIN', `"${origin ?? ''}" 은 자리표시 값입니다. 실제 사이트 주소로 바꾸세요`));
  else if (!/^https:\/\/[^/?#\s]+$/.test(origin)) rows.push(row('FAIL', 'APP_ORIGIN', 'https:// 로 시작하고 경로·끝 슬래시가 없는 출처여야 합니다'));
  else rows.push(row('PASS', 'APP_ORIGIN', origin));

  const dbs = Array.isArray(cfg.d1_databases) ? cfg.d1_databases : [];
  if (!dbs.length) rows.push(row('FAIL', 'D1', 'd1_databases 가 없습니다'));
  for (const db of dbs) {
    if (!db.database_id || ZERO_ID.test(db.database_id)) rows.push(row('FAIL', `D1 ${db.binding ?? ''}`, 'database_id 가 0 으로만 된 자리표시 값입니다. wrangler d1 create 결과의 ID 를 넣으세요'));
    else rows.push(row('PASS', `D1 ${db.binding ?? ''}`, `database_id 설정됨(${db.database_name ?? ''})`));
    if (db.database_name === 'my-site-db') rows.push(row('WARN', `D1 ${db.binding ?? ''} 이름`, 'database_name 이 템플릿 기본값(my-site-db)입니다'));
  }

  const limiters = Array.isArray(cfg.ratelimits) ? cfg.ratelimits : [];
  for (const l of limiters) if (l.namespace_id === '2001') rows.push(row('WARN', `ratelimit ${l.name}`, 'namespace_id 가 템플릿 기본값 2001 입니다. 같은 계정의 다른 사이트와 겹치지 않는지 확인하세요'));

  // 로그인 스위치: 값이 정해진 것 외이면 서버가 503 으로 닫는다.
  const act = vars.AUTH_ACTIVATION;
  if (act === undefined || act === 'disabled') rows.push(row('PASS', 'AUTH_ACTIVATION', '로그인 꺼짐'));
  else if (act !== 'enabled') rows.push(row('FAIL', 'AUTH_ACTIVATION', `"${act}" 는 enabled 도 disabled 도 아닙니다(서버가 503 으로 닫습니다)`));
  else if (!/^https:\/\/[^/\s]+/.test(String(vars.SUPABASE_URL ?? ''))) rows.push(row('FAIL', 'SUPABASE_URL', 'AUTH_ACTIVATION=enabled 이면 https 주소여야 합니다(로컬 http 주소는 운영에 쓰지 않음)'));
  else rows.push(row('PASS', 'AUTH_ACTIVATION', 'enabled, SUPABASE_URL 은 https'));
  return rows;
}

/** 필수 secret 이름 안내(등록 여부는 오프라인에서 알 수 없다). */
export function secretGuidance(cfg) {
  const enabled = cfg?.vars?.AUTH_ACTIVATION === 'enabled';
  if (!enabled) return row('PASS', 'secret 이름', `로그인이 꺼져 있어 필수 secret 없음(켜면 ${REQUIRED_SECRETS.join(', ')} 필요)`);
  return row('WARN', 'secret 이름', `필수: ${REQUIRED_SECRETS.join(', ')} — wrangler secret put 으로 등록(등록 여부는 release 가 목록으로 확인)`);
}

// ---- 2. 비밀값 모양 검사 ----
const SECRET_RULES = [
  ['개인키 머리', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['sk_ 키', /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/],
  ['sk- 키', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub 토큰', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS 키', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack 토큰', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API 키', /\bAIza[0-9A-Za-z_-]{20,}/],
  ['npm 토큰', /\bnpm_[A-Za-z0-9]{30,}/],
  ['Supabase secret 키', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
];

/** .dev.vars 텍스트에서 비밀 이름을 가진 키의 값(8자 이상)을 모은다. 이름과 값을 돌려주되 값은 호출한 쪽에서 출력하지 않는다. */
export function devVarsSecretValues(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !SECRET_KEY_NAME.test(m[1])) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 8) out.push({ name: m[1], value });
  }
  return out;
}

/** 텍스트 하나를 검사한다. 값은 돌려주지 않고 규칙 이름만 돌려준다. */
export function scanText(name, text, secretValues = []) {
  const hits = [];
  for (const [rule, re] of SECRET_RULES) if (re.test(text)) hits.push({ file: name, rule });
  for (const s of secretValues) if (text.includes(s.value)) hits.push({ file: name, rule: `.dev.vars 값(${s.name})` });
  return hits;
}

const MEDIA = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|pdf)$/i;

/** 폴더 안 파일을 검사한다. .map 은 무조건 거부. 반환 { files, hits, maps, skipped }. */
export function scanDir(dir, { secretValues = [], root = dir } = {}) {
  const res = { files: 0, hits: [], maps: [], skipped: 0 };
  if (!dir || !fs.existsSync(dir)) return res;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (e.isDirectory()) { walk(f); continue; }
      if (/\.map$/i.test(e.name)) { res.maps.push(rel); continue; }
      if (/^(\.dev\.vars|\.env(\..*)?)$/.test(e.name) && e.name !== '.env.example') { res.hits.push({ file: rel, rule: '비밀 파일이 묶음에 들어 있음' }); continue; }
      if (MEDIA.test(e.name)) { res.skipped++; continue; }
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) { res.skipped++; continue; }
      res.files++;
      res.hits.push(...scanText(rel, buf.toString('utf8'), secretValues));
    }
  };
  walk(dir);
  return res;
}

// ---- 3. 계정 ----
/** wrangler whoami --json 결과가 wrangler.jsonc 의 account_id 를 포함하는지. */
export function evaluateAccount(who, accountId) {
  if (!who || who.loggedIn !== true) return { ok: false, reason: '로그인되어 있지 않습니다' };
  if (!ACCOUNT_ID.test(String(accountId ?? ''))) return { ok: false, reason: 'wrangler.jsonc 의 account_id 가 올바르지 않습니다' };
  const account = (Array.isArray(who.accounts) ? who.accounts : []).find((a) => a && a.id === accountId);
  if (!account) return { ok: false, reason: '로그인한 계정 목록에 wrangler.jsonc 의 account_id 가 없습니다(다른 Cloudflare 계정에 로그인된 것 같습니다)' };
  return { ok: true, accountName: account.name };
}

// ---- 4. 로그인 폴더 분리(선택) ----
const DROP_ENV = /^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_BASE_URL|CF_API_TOKEN|CF_API_KEY|CF_ACCOUNT_ID|CF_EMAIL|WRANGLER_HOME|WRANGLER_CONFIG|XDG_CONFIG_HOME)$/i;

export function loadDeployConfig(root = ROOT, env = process.env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(root, 'deploy.config.json'), 'utf8')); } catch { /* 선택 파일 */ }
  const dir = env.DEPLOY_LOGIN_DIR || file.loginDir || null;
  return { loginDir: dir ? path.resolve(root, dir) : null, branch: file.branch || 'main' };
}

/** wrangler 자식 프로세스 환경. loginDir 이 있으면 토큰·계정 변수를 지우고 그 폴더를 로그인 위치로 쓴다. */
export function wranglerEnv(env, { loginDir, accountId } = {}) {
  const out = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
  if (loginDir) {
    for (const k of Object.keys(out)) if (DROP_ENV.test(k)) delete out[k];
    out.XDG_CONFIG_HOME = loginDir;
  }
  if (accountId) out.CLOUDFLARE_ACCOUNT_ID = accountId;
  out.WRANGLER_SEND_METRICS = 'false';
  return out;
}

function whoami(env, root = ROOT) {
  const r = runWrangler(['whoami', '--json'], { root, env });
  if (r.status !== 0 || typeof r.stdout !== 'string') return { loggedIn: false };
  try { return JSON.parse(r.stdout); } catch { return { loggedIn: false }; }
}

// ---- check ----
export function runCheck({ root = ROOT, skipTests = false, log = console.log } = {}) {
  const rows = [];
  let cfg = null;
  try { cfg = readConfig(root); } catch { /* checkConfig 가 FAIL 로 알린다 */ }
  rows.push(...checkConfig(cfg));
  rows.push(secretGuidance(cfg));

  if (skipTests) rows.push(row('WARN', 'npm test', '--skip-tests 로 건너뜀'));
  else {
    log('  npm test 실행 중…');
    const t = runNpm(['test'], { root });
    rows.push(t.status === 0 ? row('PASS', 'npm test', '통과') : row('FAIL', 'npm test', `실패(종료 코드 ${t.status}). npm test 를 직접 실행해 원인을 보세요`));
  }

  let stamp = null;
  try { stamp = writeStamp({ root }).stamp; } catch (e) { rows.push(row('FAIL', 'version-stamp', `기록 실패: ${e.message}`)); }
  if (stamp) rows.push(stamp.commit === 'unknown' ? row('WARN', 'version-stamp', 'git 정보를 얻지 못해 commit 이 unknown') : row(stamp.dirty ? 'WARN' : 'PASS', 'version-stamp', `commit ${stamp.commit.slice(0, 8)}${stamp.dirty ? ' (미커밋 변경 있음: release 는 거부)' : ''}`));

  // dry-run: 업로드하지 않고 묶음만 만든다. 출력은 저장소 밖 qa 폴더에 둔다(고정 이름 덮어쓰기).
  const outdir = path.join(qaDir(), 'deploy-dryrun');
  if (path.basename(outdir) === 'deploy-dryrun') fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outdir), { recursive: true });
  const env = wranglerEnv(process.env, { loginDir: loadDeployConfig(root).loginDir, accountId: cfg?.account_id });
  const dry = runWrangler(['deploy', '--dry-run', '--outdir', outdir], { root, env });
  if (dry.status !== 0) {
    const f = filterWranglerOutput(`${dry.stdout}\n${dry.stderr}`);
    // 오류 문구(ERROR 줄)는 wrangler 가 만든 설명이라 비밀값이 섞이지 않는다. 색 코드만 지워 160자까지 보여 준다.
    const errors = `${dry.stdout}\n${dry.stderr}`.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => /ERROR/.test(l)).slice(0, 2).map((l) => l.slice(0, 160));
    rows.push(row('FAIL', 'wrangler dry-run', `실패. ${f.remoteDiff ? '원격 설정 차이 경고가 있어 출력을 숨김' : (errors.join(' | ') || '허용 목록 밖 출력만 있음')}`));
  } else {
    rows.push(row('PASS', 'wrangler dry-run', `묶음 생성(${outdir})`));
  }

  let secretValues = [];
  try { secretValues = devVarsSecretValues(fs.readFileSync(path.join(root, '.dev.vars'), 'utf8')); } catch { /* .dev.vars 없으면 값 대조만 건너뜀 */ }
  const bundle = scanDir(outdir, { secretValues });
  const publicScan = scanDir(path.join(root, 'public'), { secretValues, root: path.join(root, 'public') });
  const maps = [...bundle.maps.map((m) => `dry-run/${m}`), ...publicScan.maps.map((m) => `public/${m}`)];
  const hits = [...bundle.hits.map((h) => ({ ...h, file: `dry-run/${h.file}` })), ...publicScan.hits.map((h) => ({ ...h, file: `public/${h.file}` }))];
  rows.push(maps.length ? row('FAIL', '.map 거부', `소스맵이 있음: ${maps.slice(0, 5).join(', ')}`) : row('PASS', '.map 거부', '소스맵 없음'));
  rows.push(hits.length ? row('FAIL', '비밀값 모양', hits.slice(0, 5).map((h) => `${h.rule}@${h.file}`).join(', ')) : row('PASS', '비밀값 모양', `검사 ${bundle.files + publicScan.files}개 파일, 발견 없음${secretValues.length ? `(.dev.vars 값 ${secretValues.length}개 대조 포함)` : ''}`));
  return { rows, cfg, stamp };
}

function printRows(rows) {
  console.log(formatTable(rows));
  const n = countStatus(rows);
  console.log(`\nPASS ${n.PASS} / WARN ${n.WARN} / FAIL ${n.FAIL}`);
}

// ---- release ----
function gitState(root) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const status = git(['status', '--porcelain', '--untracked-files=no'], root);
  return { branch, clean: status === '' , known: status !== null };
}

export async function release({ yes = false, skipTests = false, root = ROOT } = {}) {
  console.log('1/4 배포 전 점검');
  const { rows, cfg, stamp } = runCheck({ root, skipTests });
  printRows(rows);
  if (hasFail(rows)) { console.error('\n거부: 점검에 FAIL 이 있습니다. 배포하지 않았습니다.'); return 2; }

  const dc = loadDeployConfig(root);
  const env = wranglerEnv(process.env, { loginDir: dc.loginDir, accountId: cfg.account_id });
  console.log('\n2/4 계정·git 확인');
  const extra = [];
  const verdict = evaluateAccount(whoami(env, root), cfg.account_id);
  extra.push(verdict.ok ? row('PASS', 'Cloudflare 계정', `${verdict.accountName} 로 로그인됨(account_id 일치)`) : row('FAIL', 'Cloudflare 계정', verdict.reason));
  const g = gitState(root);
  if (!g.known) extra.push(row('FAIL', 'git', 'git 상태를 읽지 못했습니다(독립 저장소가 아니거나 git 이 없음)'));
  else {
    extra.push(g.branch === dc.branch ? row('PASS', 'git 브랜치', g.branch) : row('FAIL', 'git 브랜치', `${g.branch} (배포는 ${dc.branch} 에서만)`));
    extra.push(g.clean ? row('PASS', 'git 작업 트리', '깨끗함') : row('FAIL', 'git 작업 트리', '미커밋 변경이 있습니다. 커밋한 뒤 다시 실행하세요'));
  }
  if (verdict.ok) {
    const db = cfg.d1_databases?.[0]?.binding ?? 'DB';
    const m = runWrangler(['d1', 'migrations', 'list', db, '--remote'], { root, env });
    const out = `${m.stdout}${m.stderr}`;
    if (m.status !== 0) extra.push(row('WARN', '운영 마이그레이션', '목록을 읽지 못했습니다(D1 이 아직 없거나 권한 문제). 확인한 뒤 진행하세요'));
    else extra.push(/No migrations to apply/i.test(out) ? row('PASS', '운영 마이그레이션', '미적용 없음') : row('WARN', '운영 마이그레이션', '미적용 마이그레이션이 있을 수 있습니다. 코드가 새 스키마를 쓰면 apply(사용자 승인)가 먼저입니다'));
    if (cfg.vars?.AUTH_ACTIVATION === 'enabled') {
      const s = runWrangler(['secret', 'list', '--name', cfg.name, '--format', 'json'], { root, env });
      let names = null;
      try { names = JSON.parse(s.stdout).map((x) => x.name); } catch { /* 아래 WARN */ }
      if (!names) extra.push(row('WARN', '운영 secret', 'secret 목록을 읽지 못했습니다(Worker 가 아직 없을 수 있음)'));
      else {
        const missing = REQUIRED_SECRETS.filter((n) => !names.includes(n));
        extra.push(missing.length ? row('FAIL', '운영 secret', `없음: ${missing.join(', ')}`) : row('PASS', '운영 secret', '필수 secret 이름이 모두 있음(값은 확인하지 않음)'));
      }
    }
  }
  printRows(extra);
  if (hasFail(extra)) { console.error('\n거부: 위 FAIL 을 해결하기 전에는 배포하지 않습니다.'); return 2; }

  console.log('\n3/4 배포 계획');
  console.log(`  Worker      ${cfg.name}`);
  console.log(`  계정        ${verdict.accountName}`);
  console.log(`  주소        ${cfg.vars.APP_ORIGIN}`);
  console.log(`  커밋        ${stamp.commit.slice(0, 8)} (${g.branch})`);
  if (!yes) {
    console.log('\n멈춤: 사용자 승인 뒤 `npm run deploy:release -- --yes` 로 실행하세요. 아직 아무것도 배포하지 않았습니다.');
    return 2;
  }

  // 업로드 직전 계정 재확인(로그인이 그 사이 바뀌지 않았는지)
  const again = evaluateAccount(whoami(env, root), cfg.account_id);
  if (!again.ok) { console.error(`거부: 업로드 직전 계정 재확인 실패(${again.reason})`); return 2; }
  console.log('\n4/4 wrangler deploy');
  const d = runWrangler(['deploy', '--message', `deploy ${stamp.commit.slice(0, 8)}`], { root, env });
  printFiltered(`${d.stdout}\n${d.stderr}`);
  if (d.status !== 0) { console.error(`배포 실패(종료 코드 ${d.status}). 위 출력과 대시보드 Deployments 를 확인하세요.`); return 1; }
  console.log('\n배포 점검(post-deploy-check)');
  const post = await runWithRetries(cfg.vars.APP_ORIGIN, { localCommit: stamp.commit }, { retries: 3, waitSeconds: 5 });
  printRows(post);
  if (hasFail(post)) { console.error('배포 점검 FAIL. 운영을 브라우저로 확인하고 필요하면 npm run deploy:rollback 을 쓰세요.'); return 1; }
  console.log('배포와 배포 점검이 끝났습니다. 다음: 브라우저로 바뀐 화면을 직접 확인하세요.');
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') {
    console.log('배포 전 점검(업로드하지 않음)');
    const { rows } = runCheck({ skipTests: rest.includes('--skip-tests') });
    printRows(rows);
    return hasFail(rows) ? 2 : 0;
  }
  if (cmd === 'release') return release({ yes: rest.includes('--yes'), skipTests: rest.includes('--skip-tests') });
  if (cmd === 'whoami' || cmd === 'login') {
    const dc = loadDeployConfig();
    if (!dc.loginDir) { console.error('사이트 전용 로그인 폴더가 설정되지 않았습니다(deploy.config.json 의 loginDir 또는 DEPLOY_LOGIN_DIR).'); return 2; }
    fs.mkdirSync(dc.loginDir, { recursive: true });
    const env = wranglerEnv(process.env, { loginDir: dc.loginDir });
    if (cmd === 'login') return runWrangler(['login'], { env, capture: false, stdio: 'inherit' }).status ?? 1;
    const who = whoami(env);
    if (!who.loggedIn) { console.log('로그인되어 있지 않습니다. npm run deploy:release 전에 node scripts/deploy-guard.mjs login'); return 1; }
    for (const a of who.accounts ?? []) console.log(`- ${a.name}  ${a.id}`);
    return 0;
  }
  console.error('사용: deploy-guard.mjs check [--skip-tests] | release [--yes] [--skip-tests] | whoami | login');
  return 2;
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
