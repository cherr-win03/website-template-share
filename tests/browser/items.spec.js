import { expect, test } from '@playwright/test';
import { cardLinks } from './helpers.js';

test.describe('목록과 상세', () => {
  test('목록 카드가 보이고, 누르면 상세로 가고, 뒤로 가면 목록 위치가 복원된다', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 }); // 작게 해서 스크롤이 생기게 한다
    await page.goto('/');
    const cards = cardLinks(page);
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(0);

    // 첫 카드 → 상세 → 뒤로
    const firstHref = await cards.first().getAttribute('href');
    await cards.first().click();
    await expect.poll(() => new URL(page.url()).hash).toBe(firstHref);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goBack();
    await expect(cardLinks(page).first()).toBeVisible();

    // 스크롤 위치 복원: 아래쪽 카드로 내려가 누르고 돌아온다
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    test.skip(scrollable < 200, '항목이 적어 스크롤이 생기지 않으면 위치 복원은 확인할 수 없다');
    const last = cardLinks(page).last();
    await last.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    expect(before).toBeGreaterThan(50);
    await last.click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goBack();
    await expect(cardLinks(page).first()).toBeAttached();
    await expect.poll(() => page.evaluate((b) => Math.abs(scrollY - b), before), { timeout: 5000 }).toBeLessThan(80);
  });

  test('상세 본문의 <script> 문자열은 글자로만 보이고 실행되지 않는다', async ({ page }) => {
    const payload = '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">';
    await page.route('**/api/items/*', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      data.item = { ...data.item, body: `안전 확인\n\n${payload}\n\n- ${payload}` };
      await route.fulfill({ response: res, json: data });
    });
    let dialog = false;
    page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });
    await page.goto('/');
    await cardLinks(page).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('<script>window.__xss=1</script>').first()).toBeVisible();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('main script, #app script, body img[src="x"]').count()).toBe(0);
    expect(dialog).toBe(false);
  });
});
