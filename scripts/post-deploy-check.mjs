#!/usr/bin/env node
// 배포 뒤(또는 로컬 서버) 읽기 전용 점검. 응답 본문·쿠키는 출력하지 않는다.
// 사용: node scripts/post-deploy-check.mjs --url https://내사이트 [--commit <sha>|skip] [--retries 3] [--wait 5]
//   --url 이 없으면 wrangler.jsonc 의 APP_ORIGIN 을 쓴다. 로컬(http://127.0.0.1:8790)도 된다(HSTS 는 https 일 때만 본다).
//   --commit skip  /version.json 의 commit 비교를 건너뛴다(롤백 직후처럼 일부러 옛 커밋일 때).
// 하나라도 FAIL 이면 종료 코드 1.
import { ROOT, countStatus, formatTable, git, hasFail, isMain, readConfig, sleep } from './lib/ops.mjs';

/** docs/CONTRACT.md 4절과 같아야 한다(시험이 두 곳을 대조한다). */
export const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const EXPECTED_PERMISSIONS = 'camera=(), microphone=(), geolocation=()';
const TIMEOUT_MS = 10000;
const CODE = /^[A-Z][A-Z0-9_]*$/;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** https 출처, 또는 루프백의 http 출처만. 경로·쿼리·인증 정보는 거부한다. */
export function validateOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new TypeError('주소 형식이 올바르지 않습니다.'); }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password && /^https?:\/\/[^/?#@\\\s]+\/?$/.test(String(value));
  const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!bare || !okScheme) throw new TypeError('주소는 경로·쿼리·인증 정보가 없는 https 출처(로컬은 http://127.0.0.1:포트)여야 합니다.');
  return url.origin;
}

const cc = (res) => String(res.headers['cache-control'] ?? '').toLowerCase().split(',').map((s) => s.trim());
const isJson = (res) => /^application\/json\b/i.test(res.headers['content-type'] ?? '');
const result = (problems, ok = '통과') => (problems.length ? { status: 'FAIL', detail: problems.join('; ') } : { status: 'PASS', detail: ok });

// ---- 판정 함수(응답 요약 {status, headers(소문자 키), json?}만 본다) ----
export function judgeRoot(res, { https }) {
  const p = [];
  if (res.status !== 200) p.push(`상태 ${res.status} (200 필요)`);
  if (!/^text\/html\b/i.test(res.headers['content-type'] ?? '')) p.push('content-type 이 text/html 이 아님');
  if (res.headers['content-security-policy'] !== EXPECTED_CSP) p.push('CSP 가 CONTRACT 4절 값과 다름');
  if (res.headers['x-content-type-options'] !== 'nosniff') p.push('X-Content-Type-Options: nosniff 없음');
  if (!cc(res).includes('no-transform')) p.push('HTML cache-control 에 no-transform 없음');
  if (https) {
    const m = /max-age=(\d+)/.exec(res.headers['strict-transport-security'] ?? '');
    if (!m || Number(m[1]) < 31536000) p.push('HSTS(max-age>=31536000) 없음');
  }
  return result(p);
}

export function judgeSecurityHeaders(res) {
  const p = [];
  if (res.headers['referrer-policy'] !== 'no-referrer') p.push('Referrer-Policy: no-referrer 아님');
  if (res.headers['permissions-policy'] !== EXPECTED_PERMISSIONS) p.push('Permissions-Policy 다름');
  if (String(res.headers['x-frame-options'] ?? '').toUpperCase() !== 'DENY') p.push('X-Frame-Options: DENY 아님');
  if (res.headers['cross-origin-opener-policy'] !== 'same-origin') p.push('COOP: same-origin 아님');
  return result(p);
}

export function judgeVersion(res, { localCommit, commitCheck = true }) {
  const p = [];
  if (res.status !== 200) return { status: 'FAIL', detail: `상태 ${res.status} (200 필요)` };
  const v = res.json;
  if (!v || typeof v.commit !== 'string' || typeof v.builtAt !== 'string' || typeof v.dirty !== 'boolean') return { status: 'FAIL', detail: '{commit, dirty, builtAt} 모양이 아님' };
  const short = v.commit.slice(0, 8);
  if (!commitCheck) return { status: 'WARN', detail: `commit ${short} (비교 건너뜀)` };
  if (v.commit === 'unknown') p.push('배포본 commit 이 unknown');
  else if (!localCommit) return { status: 'WARN', detail: `commit ${short} (로컬 HEAD 를 알 수 없어 비교 못 함)` };
  else if (v.commit !== localCommit) p.push(`배포본 ${short} 가 로컬 HEAD ${localCommit.slice(0, 8)} 와 다름`);
  if (p.length) return result(p);
  return v.dirty ? { status: 'WARN', detail: `commit ${short} 일치, 그러나 배포본이 깨끗하지 않은 작업 트리에서 만들어짐` } : { status: 'PASS', detail: `commit ${short} 일치` };
}

export function judgeHealth(res) {
  const p = [];
  if (res.status !== 200) p.push(`상태 ${res.status} (200 필요)`);
  if (!isJson(res)) p.push('JSON 응답이 아님');
  if (!cc(res).includes('no-store')) p.push('cache-control 에 no-store 없음');
  return result(p);
}

export function judgeItems(res) {
  const p = [];
  if (res.status !== 200) p.push(`상태 ${res.status} (200 필요)`);
  if (!isJson(res)) p.push('JSON 응답이 아님');
  else if (!Array.isArray(res.json?.items)) p.push('items 배열이 없음');
  if (p.length) return result(p);
  return res.json.items.length === 0 ? { status: 'WARN', detail: '항목이 0개입니다(운영 데이터가 비어 있음)' } : { status: 'PASS', detail: `항목 ${res.json.items.length}개` };
}

export function judgeMembersRedirect(res) {
  const p = [];
  if (res.status !== 302) p.push(`상태 ${res.status} (302 필요)`);
  const loc = res.headers.location ?? '';
  let path = '';
  try { path = new URL(loc, 'http://x.invalid').pathname; } catch { /* 아래에서 실패 처리 */ }
  if (path !== '/login/') p.push('Location 이 /login/ 이 아님');
  return result(p);
}

export function judgeSignInRequired(res) {
  const p = [];
  if (res.status !== 401) p.push(`상태 ${res.status} (401 필요)`);
  if (!isJson(res) || res.json?.error !== 'SIGN_IN_REQUIRED') p.push('{ error: "SIGN_IN_REQUIRED" } 가 아님');
  return result(p);
}

export function judgeApiNotFound(res) {
  const p = [];
  if (res.status !== 404) p.push(`상태 ${res.status} (404 필요)`);
  if (!isJson(res)) p.push('JSON 응답이 아님');
  else if (typeof res.json?.error !== 'string' || !CODE.test(res.json.error)) p.push('{ error: "SCREAMING_SNAKE_CODE" } 모양이 아님');
  return result(p);
}

export function judgeNotFoundPage(res) {
  const p = [];
  if (res.status !== 404) p.push(`상태 ${res.status} (404 필요)`);
  if (!/^text\/html\b/i.test(res.headers['content-type'] ?? '')) p.push('content-type 이 text/html 이 아님');
  return result(p);
}

export function judgeNoOrigin(res) {
  if (res.status !== 403) return { status: 'FAIL', detail: `상태 ${res.status} (Origin 없는 상태 변경 요청은 403 이어야 함)` };
  return res.json?.error === 'INVALID_ORIGIN' ? { status: 'PASS', detail: '403 INVALID_ORIGIN' } : { status: 'WARN', detail: '403 이지만 error 코드가 INVALID_ORIGIN 이 아님' };
}

export function judgeNotServed(res) {
  return res.status === 200 ? { status: 'FAIL', detail: '공개되면 안 되는 파일이 200 으로 응답함' } : { status: 'PASS', detail: `상태 ${res.status}` };
}

/** 점검 목록. path 가 배열이면 모두 judge 에 넘긴다(notServed). */
export function buildChecks({ https, localCommit, commitCheck }) {
  return [
    { name: '홈 / 헤더', path: '/', judge: (r) => judgeRoot(r, { https }) },
    { name: '보안 머리말', path: '/', judge: judgeSecurityHeaders },
    { name: '/version.json', path: '/version.json', json: true, judge: (r) => judgeVersion(r, { localCommit, commitCheck }) },
    { name: '/api/health', path: '/api/health', json: true, judge: judgeHealth },
    { name: '/api/items', path: '/api/items', json: true, judge: judgeItems },
    { name: '/members/ 비로그인', path: '/members/', judge: judgeMembersRedirect },
    { name: '/api/members/hello', path: '/api/members/hello', json: true, judge: judgeSignInRequired },
    { name: '없는 API', path: '/api/no-such-endpoint-check', json: true, judge: judgeApiNotFound },
    { name: '없는 페이지', path: '/no-such-page-check', judge: judgeNotFoundPage },
    { name: 'Origin 없는 POST', path: '/api/auth/logout', method: 'POST', body: '{}', headers: { 'x-site-request': '1' }, json: true, judge: judgeNoOrigin },
    { name: '비공개 파일', paths: ['/.dev.vars', '/wrangler.jsonc', '/index.js.map'], judge: judgeNotServed },
  ];
}

async function fetchSummary(origin, path, { method = 'GET', body, headers, json, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}${path}`, {
      method, redirect: 'manual', credentials: 'omit', signal: controller.signal,
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json', ...headers } }),
      ...(body === undefined && headers ? { headers } : {}),
    });
    const h = {};
    for (const [k, v] of res.headers.entries()) h[k.toLowerCase()] = v;
    let parsed;
    if (json || /^application\/json\b/i.test(h['content-type'] ?? '')) {
      try { parsed = await res.json(); } catch { parsed = undefined; }
    } else {
      await res.body?.cancel();
    }
    return { status: res.status, headers: h, json: parsed };
  } finally { clearTimeout(timer); }
}

export async function runChecks(origin, { fetchImpl = globalThis.fetch, localCommit = null, commitCheck = true } = {}) {
  const target = validateOrigin(origin);
  const https = target.startsWith('https:');
  const rows = [];
  for (const check of buildChecks({ https, localCommit, commitCheck })) {
    try {
      if (check.paths) {
        const bad = [];
        for (const p of check.paths) {
          const r = await fetchSummary(target, p, { fetchImpl });
          if (check.judge(r).status === 'FAIL') bad.push(p);
        }
        rows.push({ status: bad.length ? 'FAIL' : 'PASS', name: check.name, detail: bad.length ? `공개됨: ${bad.join(', ')}` : `${check.paths.length}개 모두 200 아님` });
      } else {
        const r = await fetchSummary(target, check.path, { ...check, fetchImpl });
        rows.push({ name: check.name, ...check.judge(r) });
      }
    } catch (e) {
      // 본문·오류 문구는 옮기지 않는다.
      rows.push({ status: 'FAIL', name: check.name, detail: e?.name === 'AbortError' ? '요청 시간 초과(10초)' : '요청 또는 응답 처리 실패' });
    }
  }
  return rows;
}

/** 실패하면 wait 초 간격으로 다시 시도한다(배포 직후 전파 지연 대비). */
export async function runWithRetries(origin, opts = {}, { retries = 0, waitSeconds = 5, log = console.log } = {}) {
  let rows = await runChecks(origin, opts);
  for (let i = 0; i < retries && hasFail(rows); i++) {
    log(`FAIL 이 있어 ${waitSeconds}초 뒤 다시 확인합니다(${i + 1}/${retries}).`);
    await sleep(waitSeconds * 1000);
    rows = await runChecks(origin, opts);
  }
  return rows;
}

export function parseVerifyArgs(argv) {
  const o = { url: null, commit: undefined, retries: 0, wait: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--commit') o.commit = argv[++i];
    else if (a === '--retries') o.retries = Number(argv[++i]);
    else if (a === '--wait') o.wait = Number(argv[++i]);
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (!Number.isInteger(o.retries) || o.retries < 0 || !(o.wait >= 0)) throw new Error('--retries 는 0 이상 정수, --wait 는 0 이상 숫자여야 합니다.');
  return o;
}

async function main() {
  let o;
  try { o = parseVerifyArgs(process.argv.slice(2)); } catch (e) { console.error(`오류: ${e.message}`); return 2; }
  let origin = o.url;
  if (!origin) {
    try { origin = readConfig().vars?.APP_ORIGIN; } catch { /* 아래에서 안내 */ }
    if (!origin || origin === 'https://example.com') { console.error('오류: --url 을 주세요(wrangler.jsonc 의 APP_ORIGIN 이 자리표시 값입니다).'); return 2; }
  }
  const commitCheck = o.commit !== 'skip';
  const localCommit = o.commit && o.commit !== 'skip' ? o.commit : git(['rev-parse', 'HEAD'], ROOT);
  let rows;
  try { rows = await runWithRetries(origin, { localCommit, commitCheck }, { retries: o.retries, waitSeconds: o.wait }); } catch (e) { console.error(`오류: ${e.message}`); return 2; }
  console.log(`배포 점검: ${origin}`);
  console.log(formatTable(rows));
  const n = countStatus(rows);
  console.log(`\nPASS ${n.PASS} / WARN ${n.WARN} / FAIL ${n.FAIL}`);
  return hasFail(rows) ? 1 : 0;
}

if (isMain(import.meta.url)) main().then((c) => { process.exitCode = c; });
