// /404.html — 없는 경로. 머리말·꼬리말과 안내만 그린다.
import { initLocale, getLocale, t } from './i18n.js';
import { SITE, pick } from './site.js';
import { mountShell } from './shell.js';
import { el, clear } from './views/dom.js';

export function start(win = globalThis.window) {
  const doc = win.document;
  initLocale(win);
  const root = doc.querySelector('[data-notfound-root]');
  function draw() {
    doc.title = `${t('page.notFound')} · ${pick(SITE.name, getLocale())}`;
    clear(root);
    root.append(el(doc, 'h1', { class: 'ui-login-title', tabindex: '-1', text: t('notfound.title') }));
    root.append(el(doc, 'p', { class: 'ui-login-lead', text: t('notfound.body') }));
    root.append(el(doc, 'a', { class: 'ui-btn', href: '/', text: t('notfound.home') }));
  }
  mountShell({ doc, page: '', onLocale: draw });
  draw();
  return { draw };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('[data-notfound-root]') && !globalThis.__SITE_TEST__) {
  start(window);
}
