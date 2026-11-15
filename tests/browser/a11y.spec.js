import { expect, test } from '@playwright/test';
import { axeSevere, cardLinks } from './helpers.js';

test.describe('axe: 심각·중대 위반 0', () => {
  for (const lang of ['ko', 'ja', 'en']) {
    test(`목록·상세·로그인·404 (${lang})`, async ({ page }) => {
      await page.goto(`/?lang=${lang}`);
      await expect(cardLinks(page).first()).toBeVisible();
      expect(await axeSevere(page), '목록').toEqual([]);

      await cardLinks(page).first().click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await axeSevere(page), '상세').toEqual([]);

      await page.goto(`/login/?lang=${lang}`);
      await page.waitForLoadState('networkidle');
      expect(await axeSevere(page), '로그인').toEqual([]);

      const res = await page.goto(`/no-such-page-e2e?lang=${lang}`);
      expect(res.status()).toBe(404);
      expect(await axeSevere(page), '404').toEqual([]);
    });
  }
});
