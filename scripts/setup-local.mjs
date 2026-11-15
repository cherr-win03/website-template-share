#!/usr/bin/env node
// 로컬 개발 준비: .dev.vars 만들기(없을 때만) → 로컬 D1 마이그레이션 → 시드 데이터.
// 운영(원격)에는 아무것도 하지 않는다. 몇 번 실행해도 안전하다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, isMain, runWrangler } from './lib/ops.mjs';

/** .dev.vars 가 없으면 견본을 복사한다. 있으면 건드리지 않는다. */
export function ensureDevVars(root = ROOT) {
  const target = path.join(root, '.dev.vars');
  const example = path.join(root, '.dev.vars.example');
  if (fs.existsSync(target)) return 'exists';
  if (!fs.existsSync(example)) return 'missing-example';
  fs.copyFileSync(example, target, fs.constants.COPYFILE_EXCL);
  return 'created';
}

export function setupLocal({ root = ROOT, log = console.log } = {}) {
  const devVars = ensureDevVars(root);
  if (devVars === 'created') log('1/3 .dev.vars 를 .dev.vars.example 에서 만들었습니다(저장소에는 들어가지 않습니다).');
  else if (devVars === 'exists') log('1/3 .dev.vars 가 이미 있어 그대로 둡니다.');
  else { log('오류: .dev.vars 도 .dev.vars.example 도 없습니다.'); return 1; }

  log('2/3 로컬 D1 마이그레이션 적용(--local, 운영에는 닿지 않음)');
  // 입력을 닫아 두면 wrangler 가 확인 질문 없이 진행한다.
  const mig = runWrangler(['d1', 'migrations', 'apply', 'DB', '--local'], { root, capture: false, stdio: ['ignore', 'inherit', 'inherit'] });
  if (mig.status !== 0) { log('오류: 로컬 마이그레이션이 실패했습니다.'); return mig.status ?? 1; }

  const seed = path.join(root, 'scripts', 'seed-local.mjs');
  if (!fs.existsSync(seed)) { log('3/3 scripts/seed-local.mjs 가 없어 시드를 건너뜁니다(경고).'); return 0; }
  log('3/3 로컬 시드 데이터');
  const r = spawnSync(process.execPath, [seed], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { log('오류: 시드가 실패했습니다.'); return r.status ?? 1; }
  log('준비 끝. npm run dev 로 http://127.0.0.1:8790 을 엽니다.');
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = setupLocal();
