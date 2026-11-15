// 화면 시험 공용 도구. 화면 요소는 역할·이름(getByRole)으로 찾고, 라우트(해시 #/items/<id>)와 API 는 CONTRACT 를 따른다.
import AxeBuilder from '@axe-core/playwright';

export const TEXT_LOGIN_EMAIL = /이메일|email|メール/i;
export const TEXT_CODE = /코드|code|コード/i;

/** 페이지에서 콘솔 오류·CSP 위반·미처리 예외를 모은다. goto 전에 부른다. */
export async function trackProblems(page) {
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window.__csp ||= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return problems;
}

export const cspViolations = (page) => page.evaluate(() => window.__csp || []);

/** 목록의 카드 링크(상세로 가는 #/items/<id>). */
export const cardLinks = (page) => page.getByRole('link').and(page.locator('[href^="#/items/"]'));

/** 언어 전환 컨트롤을 찾아 바꾼다. 네이티브 select(combobox)면 옵션 글자로 값을 고르고, 아니면 button·radio·tab·link·menuitem 순으로 찾는다. */
export async function switchLang(page, label) {
  const select = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: label }) }).first();
  if (await select.count()) {
    const value = await select.evaluate((el, src) => {
      const re = new RegExp(src.source, src.flags);
      return [...el.options].find((o) => re.test(o.textContent.trim()))?.value ?? null;
    }, { source: label.source, flags: label.flags });
    if (value) { await select.selectOption(value); return; }
  }
  for (const role of ['button', 'radio', 'tab', 'link', 'menuitem']) {
    const el = page.getByRole(role, { name: label }).first();
    if (await el.count()) { await el.click(); return; }
  }
  throw new Error(`언어 전환 컨트롤(${label})을 역할·이름으로 찾지 못했습니다. 화면 담당의 마크업을 확인하세요.`);
}

export async function axeSevere(page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`);
}
