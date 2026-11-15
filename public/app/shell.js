// 머리말·꼬리말: 세 화면(/ · /login/ · /members/)과 404 가 같이 쓴다.
// 로그인/로그아웃 단추는 /api/auth/config 가 enabled 일 때만 나온다.
import { el, clear } from './views/dom.js';
import { SITE, pick } from './site.js';
import { t, getLocale, setLocale, LOCALES, LOCALE_NAMES, onLocaleChange } from './i18n.js';
import { getAuthConfig, getMe, logout, setCsrf, ApiError } from './api.js';

// 세션 읽기: { enabled, methods, signedIn, user, csrf, error }
export async function loadSession() {
  let config;
  try {
    config = await getAuthConfig();
  } catch (error) {
    return { enabled: false, methods: [], signedIn: false, user: null, csrf: null, error: error instanceof ApiError ? error.code : 'UNKNOWN' };
  }
  if (!config?.enabled) return { enabled: false, methods: config?.methods || [], signedIn: false, user: null, csrf: null, error: null };
  try {
    const me = await getMe();
    setCsrf(me?.csrf);
    return { enabled: true, methods: config.methods || [], signedIn: Boolean(me?.signedIn), user: me?.user || null, csrf: me?.csrf || null, error: null };
  } catch (error) {
    return { enabled: true, methods: config.methods || [], signedIn: false, user: null, csrf: null, error: error instanceof ApiError ? error.code : 'UNKNOWN' };
  }
}

export function currentPath(win = globalThis.window) {
  return win.location.pathname + win.location.search + win.location.hash;
}

function isCurrent(item, page) {
  return item.match === page;
}

export function mountShell({ doc = globalThis.document, page = '', onLocale } = {}) {
  const headerHost = doc.querySelector('[data-ui-header]');
  const footerHost = doc.querySelector('[data-ui-footer]');
  const state = { session: { enabled: false, methods: [], signedIn: false, user: null, csrf: null, error: null }, ready: null };

  function render() {
    const locale = getLocale();
    if (headerHost) {
      const hadFocusOnLang = doc.activeElement?.matches?.('[data-lang-select]');
      clear(headerHost);
      headerHost.append(el(doc, 'a', { class: 'ui-brand', href: '/', text: pick(SITE.name, locale) }));

      const nav = el(doc, 'nav', { class: 'ui-nav', 'aria-label': t('nav.label') });
      for (const item of SITE.nav) {
        if (item.requiresAuth && !state.session.signedIn) continue;
        nav.append(el(doc, 'a', { class: 'ui-nav-link', href: item.href, 'aria-current': isCurrent(item, page) ? 'page' : false, text: pick(item.label, locale) }));
      }
      headerHost.append(nav);

      const tools = el(doc, 'div', { class: 'ui-header-tools' });
      const select = el(doc, 'select', { class: 'ui-select', 'data-lang-select': '', 'aria-label': t('lang.label') });
      for (const code of LOCALES) select.append(el(doc, 'option', { value: code, lang: code, selected: code === locale, text: LOCALE_NAMES[code] }));
      select.value = locale;
      select.addEventListener('change', () => setLocale(select.value, doc.defaultView));
      tools.append(el(doc, 'label', { class: 'ui-lang' }, [select]));

      if (state.session.enabled) {
        if (state.session.signedIn) {
          const button = el(doc, 'button', { class: 'ui-btn ui-btn--secondary', type: 'button', 'data-logout': '', text: t('auth.signOut') });
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await logout();
            } catch {
              /* 로그아웃 실패여도 아래에서 세션을 다시 읽는다 */
            }
            setCsrf(null);
            doc.defaultView.location.assign('/');
          });
          tools.append(button);
        } else if (page !== 'login') {
          const href = `/login/?returnTo=${encodeURIComponent(currentPath(doc.defaultView))}`;
          tools.append(el(doc, 'a', { class: 'ui-btn ui-btn--secondary', href, 'data-login': '', text: t('auth.signIn') }));
        }
      }
      headerHost.append(tools);
      if (hadFocusOnLang) headerHost.querySelector('[data-lang-select]')?.focus();
    }
    if (footerHost) {
      clear(footerHost);
      footerHost.append(el(doc, 'p', { class: 'ui-footer-text', text: pick(SITE.footer.text, locale) }));
      if (SITE.footer.links.length) {
        footerHost.append(el(doc, 'ul', { class: 'ui-footer-links' }, SITE.footer.links.map((link) => el(doc, 'li', {}, [el(doc, 'a', { href: link.href, text: pick(link.label, locale) })]))));
      }
    }
    const skip = doc.querySelector('.ui-skip');
    if (skip) skip.textContent = t('skip');
  }

  render();
  onLocaleChange(() => {
    render();
    onLocale?.(getLocale());
  });
  state.ready = loadSession().then((session) => {
    state.session = session;
    render();
    return session;
  });

  return {
    state,
    ready: state.ready,
    render,
    get session() {
      return state.session;
    },
  };
}
