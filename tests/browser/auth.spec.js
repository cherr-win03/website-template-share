import { expect, test } from '@playwright/test';

// 가짜 Supabase(scripts/fake-supabase.mjs)는 이메일 코드 123456 을 받는다. 라벨·단추 이름은 ko·ja·en 어느 쪽이든 찾는다.
const EMAIL = /이메일|email|メール/i;
const CODE = /코드|code|コード/i;
const SEND = /코드.*(받|보내|전송)|send|送信|메일.*보내/i;
const VERIFY = /확인|로그인|verify|sign in|log in|ログイン|認証/i;
const LOGOUT = /로그아웃|log ?out|sign out|ログアウト/i;

test('로그인 전에는 /members/ 가 /login/ 으로 간다', async ({ page }) => {
  await page.goto('/members/');
  await expect(page).toHaveURL(/\/login\//);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/members/');
});

test('이메일 코드 로그인 → /members/ 에 이메일 → 로그아웃 → 다시 막힘', async ({ page }) => {
  const email = 'tester@example.test';
  await page.goto('/members/');
  await expect(page).toHaveURL(/\/login\//);
  await page.getByLabel(EMAIL).first().fill(email);
  await page.getByRole('button', { name: SEND }).click();
  await page.getByLabel(CODE).first().fill('123456');
  await page.getByRole('button', { name: VERIFY }).last().click();
  await expect(page).toHaveURL(/\/members\//);
  await expect(page.getByText(email)).toBeVisible();

  // 머리말과 본문(회원 견본) 양쪽에 로그아웃 단추가 있다. 머리말 것을 누른다.
  await page.getByRole('banner').getByRole('button', { name: LOGOUT }).click();
  // 로그아웃은 서버 요청이 끝난 뒤 첫 화면(/)으로 옮긴다. 그 이동이 끝나야 다음 이동이 끊기지 않는다.
  await page.waitForURL((u) => new URL(u).pathname === '/');
  await page.goto('/members/');
  await expect(page).toHaveURL(/\/login\//);
  const hello = await page.request.get('/api/members/hello');
  expect(hello.status()).toBe(401);
});
