#!/usr/bin/env node
// 접근성 점검(axe). 지정 주소의 /, #/items/<첫 항목>, /login/, 404 를 넓은 화면·휴대폰 × ko·ja·en 으로 검사한다.
// 사용: node scripts/a11y-audit.mjs [--url http://127.0.0.1:8790] [--out <폴더>]
// 서버는 먼저 띄워 둔다(npm run dev). 결과 JSON 은 저장소 밖 ..\qa\a11y\ 에 고정 이름(a11y-result.json)으로 덮어쓴다.
// 설치된 Playwright chromium 만 쓴다. serious·critical 위반이 있으면 종료 코드 1.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilderModule from '@axe-core/playwright';
import { formatTable, isMain, qaDir } from './lib/ops.mjs';

const AxeBuilder = AxeBuilderModule.default || AxeBuilderModule;
export const LANGS = ['ko', 'ja', 'en'];
export const VIEWPORTS = { wide: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export function parseArgs(argv) {
  const o = { url: 'http://127.0.0.1:8790', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') o.url = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else throw new Error(`알 수 없는 옵션: ${argv[i]}`);
  }
  o.url = o.url.replace(/\/+$/, '');
  return o;
}

/** axe 결과에서 요약 행만 뽑는다(요소 HTML 은 싣지 않는다). */
export function summarizeViolations(violations, ctx) {
  return violations.map((v) => ({ ...ctx, rule: v.id, impact: v.impact ?? 'unknown', nodes: v.nodes?.length ?? 0, help: v.help }));
}

export const isSevere = (row) => row.impact === 'serious' || row.impact === 'critical';

export async function audit({ url, out }) {
  const outDir = out ? path.resolve(out) : path.join(qaDir(), 'a11y');
  fs.mkdirSync(outDir, { recursive: true });

  const probe = await fetch(`${url}/api/items`).catch(() => null);
  if (!probe || !probe.ok) throw new Error(`${url}/api/items 에 닿지 않습니다. 서버를 먼저 띄우세요(npm run dev).`);
  const items = (await probe.json()).items ?? [];
  const firstId = items[0]?.id;

  const pages = [
    { name: '목록', path: '/' },
    ...(firstId ? [{ name: '상세', path: `/#/items/${firstId}` }] : []),
    { name: '로그인', path: '/login/' },
    { name: '404', path: '/no-such-page-a11y' },
  ];

  const browser = await chromium.launch();
  const rows = [];
  let checked = 0;
  try {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      for (const lang of LANGS) {
        const context = await browser.newContext({ viewport, locale: lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US' });
        const page = await context.newPage();
        for (const p of pages) {
          const sep = p.path.includes('#') ? p.path.replace('#', `?lang=${lang}#`) : `${p.path}${p.path.includes('?') ? '&' : '?'}lang=${lang}`;
          await page.goto(`${url}${sep}`, { waitUntil: 'networkidle' });
          // 화면이 그려진 뒤 검사(해시 화면은 데이터 도착까지 짧게 기다림)
          await page.waitForTimeout(300);
          const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          checked++;
          rows.push(...summarizeViolations(result.violations, { page: p.name, viewport: vpName, lang }));
        }
        await context.close();
      }
    }
  } finally { await browser.close(); }

  const file = path.join(outDir, 'a11y-result.json');
  fs.writeFileSync(file, JSON.stringify({ url, checkedAt: new Date().toISOString(), checked, violations: rows }, null, 2));
  return { rows, checked, file };
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`오류: ${e.message}`); return 2; }
  let r;
  try { r = await audit(o); } catch (e) { console.error(`오류: ${e.message}`); return 2; }
  console.log(`axe 점검 ${r.checked}개 화면 조합(${Object.keys(VIEWPORTS).join('·')} × ${LANGS.join('·')}), 위반 ${r.rows.length}건`);
  if (r.rows.length) {
    console.log(formatTable(r.rows.map((v) => ({ status: isSevere(v) ? 'FAIL' : 'WARN', name: `${v.page}/${v.viewport}/${v.lang}`, detail: `${v.rule} (${v.impact}) 요소 ${v.nodes}개` }))));
  }
  console.log(`결과 JSON: ${r.file}`);
  return r.rows.some(isSevere) ? 1 : 0;
}

if (isMain(import.meta.url)) main().then((c) => { process.exitCode = c; });
