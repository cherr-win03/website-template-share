import { expect, test } from '@playwright/test';
import { cardLinks, cspViolations, trackProblems } from './helpers.js';

test('주요 화면을 돌아도 콘솔 오류와 CSP 위반이 0건이다', async ({ page }) => {
  const problems = await trackProblems(page);
  await page.goto('/');
  await expect(cardLinks(page).first()).toBeVisible();
  await cardLinks(page).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  await page.goto('/login/');
  await page.waitForLoadState('networkidle');
  expect(await cspViolations(page)).toEqual([]);
  for (const lang of ['ja', 'en']) {
    await page.goto(`/?lang=${lang}`);
    await page.waitForLoadState('networkidle');
    expect(await cspViolations(page)).toEqual([]);
  }
  expect(problems).toEqual([]);
});

test('응답 머리말은 CONTRACT 값이고 인라인 실행 요소·스타일이 없다', async ({ page, request }) => {
  const res = await request.get('/');
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await page.locator('script:not([src])').count()).toBe(0);
  expect(await page.locator('style').count()).toBe(0);
  expect(await page.locator('[style]').count()).toBe(0);
});
