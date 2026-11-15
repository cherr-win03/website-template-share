// /login/ — 이메일 → 코드 두 단계 + 소셜 단추. 로그인이 꺼져 있으면 안내만 보여 준다.
import { initLocale, getLocale, t } from './i18n.js';
import { SITE, pick } from './site.js';
import { mountShell } from './shell.js';
import { startEmail, verifyEmail, errorText, safeReturnTo } from './api.js';
import { ERROR_CODES } from './messages.js';
import { el, clear } from './views/dom.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER_NAMES = { google: 'Google', kakao: 'Kakao', naver: 'Naver', github: 'GitHub', apple: 'Apple', facebook: 'Facebook' };

export function providerName(id) {
  return PROVIDER_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

export function socialHref(provider, returnTo) {
  return `/api/auth/social/start?provider=${encodeURIComponent(provider)}&returnTo=${encodeURIComponent(returnTo)}`;
}

export function socialMethods(methods) {
  return (Array.isArray(methods) ? methods : []).filter((m) => typeof m === 'string' && m !== 'email' && /^[a-z0-9_-]{1,40}$/i.test(m));
}

export function start(win = globalThis.window) {
  const doc = win.document;
  initLocale(win);
  const root = doc.querySelector('[data-login-root]');
  const params = new URLSearchParams(win.location.search);
  const returnTo = safeReturnTo(params.get('returnTo') || '/');
  const urlError = params.get('error');
  let step = 'email'; // email | code
  let email = '';
  let pendingMessage = null; // { tone, text }

  const shell = mountShell({ doc, page: 'login', onLocale: () => draw() });

  function setTitle() {
    doc.title = `${t('page.login')} · ${pick(SITE.name, getLocale())}`;
  }

  function field({ id, label, hint, type, autocomplete, inputmode, errorText: err, value }) {
    const hintId = `${id}-hint`;
    const errId = `${id}-error`;
    const input = el(doc, 'input', { class: 'ui-input', id, name: id, type, autocomplete, inputmode, required: true, value: value || '', 'aria-describedby': err ? `${hintId} ${errId}` : hintId, 'aria-invalid': err ? 'true' : false, spellcheck: 'false' });
    const wrap = el(doc, 'div', { class: 'ui-field' }, [el(doc, 'label', { class: 'ui-label', for: id, text: label }), el(doc, 'p', { class: 'ui-hint', id: hintId, text: hint }), input]);
    if (err) wrap.append(el(doc, 'p', { class: 'ui-error', id: errId, role: 'alert', text: err }));
    return { wrap, input };
  }

  function emailForm(error) {
    const { wrap, input } = field({ id: 'login-email', label: t('login.email'), hint: t('login.emailHint'), type: 'email', autocomplete: 'email', inputmode: 'email', errorText: error, value: email });
    const submit = el(doc, 'button', { class: 'ui-btn ui-btn--block', type: 'submit', text: t('login.sendCode') });
    const form = el(doc, 'form', { class: 'ui-login-form', novalidate: true }, [wrap, submit]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      email = input.value.trim();
      if (!EMAIL_PATTERN.test(email)) return draw({ emailError: t('login.emailInvalid'), focus: 'login-email' });
      submit.disabled = true;
      submit.textContent = t('login.sending');
      try {
        await startEmail(email);
        step = 'code';
        pendingMessage = { tone: 'ok', text: t('login.sent') };
        draw({ focus: 'login-code' });
      } catch (e) {
        draw({ emailError: errorText(e), focus: 'login-email' });
      }
    });
    return form;
  }

  function codeForm(error) {
    const { wrap, input } = field({ id: 'login-code', label: t('login.code'), hint: t('login.codeHint', { email }), type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', errorText: error });
    const submit = el(doc, 'button', { class: 'ui-btn ui-btn--block', type: 'submit', text: t('login.verify') });
    const back = el(doc, 'button', { class: 'ui-btn-text', type: 'button', text: t('login.changeEmail') });
    back.addEventListener('click', () => {
      step = 'email';
      pendingMessage = null;
      draw({ focus: 'login-email' });
    });
    const form = el(doc, 'form', { class: 'ui-login-form' }, [wrap, submit, back]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code) return draw({ codeError: t('login.codeRequired'), focus: 'login-code' });
      submit.disabled = true;
      submit.textContent = t('login.verifying');
      try {
        const result = await verifyEmail(email, code, returnTo);
        win.location.assign(safeReturnTo(result?.returnTo || returnTo));
      } catch (e) {
        draw({ codeError: errorText(e), focus: 'login-code' });
      }
    });
    return form;
  }

  function socialButtons(methods) {
    const list = socialMethods(methods);
    if (!list.length) return null;
    const box = el(doc, 'div', { class: 'ui-social', role: 'group', 'aria-label': t('login.socialGroup') }, [el(doc, 'p', { class: 'ui-hint ui-social-or', text: t('login.or') })]);
    for (const provider of list) {
      box.append(el(doc, 'a', { class: 'ui-btn ui-btn--secondary ui-btn--block', href: socialHref(provider, returnTo), text: t('login.social', { name: providerName(provider) }) }));
    }
    return box;
  }

  function draw(opts = {}) {
    setTitle();
    clear(root);
    const session = shell.session;
    const heading = el(doc, 'h1', { class: 'ui-login-title', tabindex: '-1', text: t('login.title') });
    root.append(heading);

    if (urlError) {
      const code = ERROR_CODES.includes(urlError) ? urlError : 'UNKNOWN';
      root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'danger', role: 'alert', text: errorText(code) }));
    }
    if (!session.loaded) {
      root.append(el(doc, 'p', { class: 'ui-state', role: 'status', text: t('state.loading') }));
      return;
    }
    if (session.error && !session.enabled) {
      root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'danger', role: 'alert', text: errorText(session.error) }));
      return;
    }
    if (!session.enabled) {
      root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'warn', role: 'status', text: t('login.disabled') }));
      root.append(el(doc, 'p', { class: 'ui-hint', text: t('login.disabledHelp') }));
      root.append(el(doc, 'a', { class: 'ui-btn-text', href: '/', text: t('login.home') }));
      return;
    }
    if (session.signedIn) {
      root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': 'ok', role: 'status', text: t('login.already') }));
      root.append(el(doc, 'a', { class: 'ui-btn', href: returnTo, text: t('login.continue') }));
      return;
    }
    root.append(el(doc, 'p', { class: 'ui-login-lead', text: t('login.lead') }));
    if (pendingMessage && step === 'code') root.append(el(doc, 'p', { class: 'ui-notice', 'data-tone': pendingMessage.tone, role: 'status', text: t('login.sent') }));
    root.append(step === 'email' ? emailForm(opts.emailError) : codeForm(opts.codeError));
    const social = socialButtons(session.methods);
    if (social) root.append(social);
    if (opts.focus) doc.getElementById(opts.focus)?.focus();
  }

  shell.ready.then((session) => {
    session.loaded = true;
    draw();
  });
  draw();
  return { draw };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('[data-login-root]') && !globalThis.__SITE_TEST__) {
  start(window);
}
