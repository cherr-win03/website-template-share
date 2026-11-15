// /members/ — 로그인한 사람만 보는 견본. 서버가 로그인 전 접근을 막고, 여기서는 /api/members/hello 결과를 보여 준다.
import { initLocale, getLocale, t } from './i18n.js';
import { SITE, pick } from './site.js';
import { mountShell } from './shell.js';
import { getMembersHello, logout, setCsrf, errorText, ApiError } from './api.js';
import { el, clear } from './views/dom.js';

export function start(win = globalThis.window) {
  const doc = win.document;
  initLocale(win);
  const root = doc.querySelector('[data-members-root]');
  let hello = null; // { email } | { error }

  const shell = mountShell({ doc, page: 'members', onLocale: () => draw() });

  function draw() {
    doc.title = `${t('page.members')} · ${pick(SITE.name, getLocale())}`;
    clear(root);
    root.append(el(doc, 'h1', { class: 'ui-login-title', tabindex: '-1', text: t('members.title') }));
    root.append(el(doc, 'p', { class: 'ui-login-lead', text: t('members.lead') }));
    if (!hello) {
      root.append(el(doc, 'p', { class: 'ui-state', role: 'status', text: t('state.loading') }));
      return;
    }
    if (hello.error) {
      root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'danger', role: 'alert', text: errorText(hello.error) }));
      if (hello.signIn) root.append(el(doc, 'a', { class: 'ui-btn-text', href: '/login/?returnTo=%2Fmembers%2F', text: t('auth.signIn') }));
      return;
    }
    root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'ok', role: 'status', text: t('members.hello', { email: hello.email }) }));
    const button = el(doc, 'button', { class: 'ui-btn ui-btn--secondary', type: 'button', text: t('auth.signOut') });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await logout();
      } catch {
        /* 실패해도 홈으로 가서 세션을 다시 읽는다 */
      }
      setCsrf(null);
      win.location.assign('/');
    });
    root.append(el(doc, 'div', { class: 'ui-login-actions' }, [button]));
  }

  draw();
  shell.ready.then(async (session) => {
    if (!session.enabled || !session.signedIn) {
      hello = { error: session.error || 'SIGN_IN_REQUIRED', signIn: true };
      draw();
      return;
    }
    try {
      const data = await getMembersHello();
      hello = { email: String(data?.email ?? '') };
    } catch (error) {
      hello = { error: error instanceof ApiError ? error.code : 'UNKNOWN', signIn: error instanceof ApiError && error.code === 'SIGN_IN_REQUIRED' };
    }
    draw();
  });
  return { draw };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('[data-members-root]') && !globalThis.__SITE_TEST__) {
  start(window);
}
