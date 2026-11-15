import { expect, test } from '@playwright/test';
import { cardLinks, switchLang } from './helpers.js';

test('언어를 ko→ja→en 으로 바꾸면 html lang 과 화면 문구가 바뀐다', async ({ page }) => {
  await page.goto('/?lang=ko');
  await expect(cardLinks(page).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  const ko = await page.getByRole('heading', { level: 1 }).first().innerText();

  await switchLang(page, /日本語|^ja$/i);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText(ko);
  const ja = await page.getByRole('heading', { level: 1 }).first().innerText();

  await switchLang(page, /English|^en$/i);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const en = await page.getByRole('heading', { level: 1 }).first().innerText();
  expect(new Set([ko, ja, en]).size).toBe(3);
});

test('?lang= 로 시작해도 세 언어가 각각 적용된다', async ({ page }) => {
  for (const lang of ['ko', 'ja', 'en']) {
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
  }
});
