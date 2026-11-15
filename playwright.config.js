// 화면 시험(Playwright + axe). 서버는 wrangler dev(로컬 D1·가짜 Supabase)를 포트 8798 로 직접 띄운다.
// 브라우저는 설치된 Playwright chromium(1.65.0 = chromium-1254)만 쓴다. 출력은 저장소 밖 ..\qa\playwright 에 둔다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = path.dirname(fileURLToPath(import.meta.url));
const qa = process.env.SITE_QA_DIR ? path.resolve(process.env.SITE_QA_DIR) : path.resolve(root, '..', 'qa');
const PORT = 8798;
const origin = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.js',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  outputDir: path.join(qa, 'playwright', 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(qa, 'playwright', 'report'), open: 'never' }]],
  use: { baseURL: origin, headless: true, locale: 'ko-KR', viewport: { width: 1280, height: 800 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // --setup: 로컬 마이그레이션·시드를 먼저 적용한다(몇 번 돌려도 안전).
    command: `node scripts/dev.mjs --fake-auth --setup --port ${PORT}`,
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
