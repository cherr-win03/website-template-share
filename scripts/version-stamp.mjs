#!/usr/bin/env node
// public/version.json 에 { commit, dirty, builtAt } 를 쓴다. 파일은 .gitignore 대상이라 저장소에 넣지 않는다.
// 배포 뒤 /version.json 의 commit 이 배포한 커밋과 같은지 deploy:verify 가 확인한다.
// git 이 없거나 이 폴더가 독립 저장소가 아니면 commit 은 "unknown", dirty 는 true(깨끗함을 확인하지 못했으므로).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, git as realGit, isMain } from './lib/ops.mjs';

/** 순수 함수: git 호출을 주입받아 스탬프 객체를 만든다. */
export function buildStamp({ git = realGit, now = new Date() } = {}) {
  const head = git(['rev-parse', 'HEAD']);
  const commit = /^[0-9a-f]{40}$/.test(head || '') ? head : 'unknown';
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const dirty = commit === 'unknown' || status === null ? true : status !== '';
  return { commit, dirty, builtAt: now.toISOString() };
}

export function writeStamp({ root = ROOT, git = realGit, now = new Date() } = {}) {
  const stamp = buildStamp({ git, now });
  const file = path.join(root, 'public', 'version.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stamp)}\n`);
  return { file, stamp };
}

if (isMain(import.meta.url)) {
  const { file, stamp } = writeStamp();
  console.log(`version.json 기록: commit ${stamp.commit === 'unknown' ? 'unknown' : stamp.commit.slice(0, 8)}, dirty ${stamp.dirty}, builtAt ${stamp.builtAt}`);
  console.log(`  ${file}`);
}
