#!/usr/bin/env node
// 최근 배포를 보여 주고, 승인이 있을 때만 이전 Worker 버전으로 되돌린다.
// 사용: node scripts/deploy-rollback.mjs                      최근 배포 목록만 보기
//       node scripts/deploy-rollback.mjs --to <version-id>    되돌릴 계획만 보기
//       node scripts/deploy-rollback.mjs --to <version-id> --yes   실제로 되돌림(사용자 승인 뒤)
export const ROLLBACK_NOTICE = [
  '주의: 롤백은 Worker 코드·정적 파일·변수·secret 을 그 버전 상태로 되돌립니다(변수와 secret 은 버전과 함께 되돌아갑니다).',
  '      D1 데이터와 이미 적용한 마이그레이션은 되돌아가지 않습니다. 새 스키마를 쓰던 코드에서 옛 코드로 가면 깨질 수 있으니',
  '      "되돌릴 수 없는 스키마 변경이 들어간 버전 이전으로는 가지 않는다"는 기준선을 docs/DEPLOY.md 에 적어 두세요.',
].join('\n');

import { countStatus, formatTable, hasFail, isMain, readConfig, runWrangler } from './lib/ops.mjs';
import { evaluateAccount, loadDeployConfig, wranglerEnv } from './deploy-guard.mjs';
import { runChecks } from './post-deploy-check.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRollbackArgs(argv) {
  const o = { to: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') o.to = argv[++i];
    else if (a === '--yes') o.yes = true;
    else return { error: `알 수 없는 옵션: ${a}` };
  }
  if (o.to !== null && !UUID.test(String(o.to))) return { error: '--to 에는 version-id(UUID)를 주세요. 목록에서 복사하세요.' };
  if (o.yes && o.to === null) return { error: '--yes 는 --to 와 함께만 씁니다.' };
  return o;
}

/** `wrangler deployments list --json` 결과를 사람이 읽을 줄로. 작성자 이메일은 싣지 않는다. */
export function summarizeDeployments(list, limit = 5) {
  if (!Array.isArray(list) || !list.length) return [];
  const sorted = [...list].sort((a, b) => String(b.created_on ?? '').localeCompare(String(a.created_on ?? '')));
  return sorted.slice(0, limit).map((d, i) => {
    const versions = (d.versions ?? []).map((v) => `${v.version_id} (${v.percentage}%)`).join(', ');
    const msg = d.annotations?.['workers/message'];
    return `${i === 0 ? '현재 ' : `  -${i} `} ${d.created_on ?? '?'}  ${versions}${msg ? `  "${String(msg).slice(0, 60)}"` : ''}`;
  });
}

async function main() {
  const o = parseRollbackArgs(process.argv.slice(2));
  if (o.error) { console.error(`오류: ${o.error}`); return 2; }
  const cfg = readConfig();
  const dc = loadDeployConfig();
  const env = wranglerEnv(process.env, { loginDir: dc.loginDir, accountId: cfg.account_id });

  const who = runWrangler(['whoami', '--json'], { env });
  let whoJson = { loggedIn: false };
  try { whoJson = JSON.parse(who.stdout); } catch { /* 아래에서 거부 */ }
  const verdict = evaluateAccount(whoJson, cfg.account_id);
  if (!verdict.ok) { console.error(`거부: ${verdict.reason}`); return 2; }

  const list = runWrangler(['deployments', 'list', '--json', '--name', cfg.name], { env });
  let parsed = null;
  try { parsed = JSON.parse(list.stdout); } catch { /* 아래 */ }
  if (list.status !== 0 || !parsed) { console.error('배포 목록을 읽지 못했습니다. 로그인·Worker 이름을 확인하세요.'); return 1; }
  console.log(`최근 배포(${cfg.name}, 계정 ${verdict.accountName})`);
  for (const line of summarizeDeployments(parsed)) console.log(`  ${line}`);

  if (!o.to) {
    console.log('\n되돌리려면 위 version-id 를 골라 --to <version-id> 를 붙이세요(--yes 가 없으면 계획만 보여 줍니다).');
    console.log(ROLLBACK_NOTICE);
    return 0;
  }
  console.log(`\n계획: ${cfg.name} 을(를) 버전 ${o.to} 로 되돌립니다.`);
  console.log(ROLLBACK_NOTICE);
  if (!o.yes) { console.log('\n멈춤: 사용자 승인 뒤 --yes 를 붙여 실행하세요. 아직 아무것도 바꾸지 않았습니다.'); return 2; }

  const r = runWrangler(['rollback', o.to, '--name', cfg.name, '--message', 'deploy-rollback', '--yes'], { env });
  const text = `${r.stdout}\n${r.stderr}`;
  console.log(text.split(/\r?\n/).filter((l) => /rollback|Current Version ID|Successfully|Worker Version/i.test(l)).map((l) => `  ${l.trim()}`).join('\n'));
  if (r.status !== 0) { console.error(`롤백 실패(종료 코드 ${r.status}).`); return 1; }

  console.log('\n롤백 뒤 점검(version.json 의 commit 은 일부러 옛 값이라 비교하지 않음)');
  const rows = await runChecks(cfg.vars.APP_ORIGIN, { commitCheck: false });
  console.log(formatTable(rows));
  const n = countStatus(rows);
  console.log(`\nPASS ${n.PASS} / WARN ${n.WARN} / FAIL ${n.FAIL}`);
  return hasFail(rows) ? 1 : 0;
}

if (isMain(import.meta.url)) main().then((c) => { process.exitCode = c; });
