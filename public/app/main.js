// 목록·상세 한 쪽짜리 앱. 해시 라우팅: #/items (목록, 기본) · #/items/<id> (상세).
import { initLocale, getLocale, t } from './i18n.js';
import { SITE, pick } from './site.js';
import { mountShell } from './shell.js';
import { getItems, getItem, errorText, ApiError } from './api.js';
import { createListView } from './views/list.js';
import { createDetailView } from './views/detail.js';
import { createState } from './views/state.js';
import { clear, el } from './views/dom.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

// 주소의 해시 → 화면. 라우팅과 무관한 해시(#content 등)는 null(화면을 그대로 둔다)
export function parseRoute(hash) {
  const value = String(hash ?? '');
  if (value === '' || value === '#' || value === '#/' || value === '#/items') return { name: 'list' };
  const m = /^#\/items\/([^/?#]+)$/.exec(value);
  if (m) {
    let id = '';
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      id = '';
    }
    return ID_PATTERN.test(id) ? { name: 'detail', id } : { name: 'notfound' };
  }
  if (value.startsWith('#/')) return { name: 'notfound' };
  return null;
}

export function start(win = globalThis.window) {
  const doc = win.document;
  initLocale(win);
  const root = doc.querySelector('[data-app-root]');
  const mainEl = doc.querySelector('main');
  const listCache = new Map();
  let controller = null;
  let renderId = 0;
  let listView = null;

  const shell = mountShell({ doc, page: 'items', onLocale: () => render({ keepFocus: true }) });

  const setTitle = (text) => {
    doc.title = `${text} · ${pick(SITE.name, getLocale())}`;
  };
  const setBar = (on) => doc.documentElement.classList.toggle('ui-has-bar', on);

  // 목록을 떠나기 전에 스크롤·걸러 보기·초점 카드를 이 기록 항목에 저장 → 뒤로 가기에서 복원
  function saveListPosition(focusId) {
    if (!listView) return;
    try {
      win.history.replaceState({ ...(win.history.state || {}), itemsList: { y: win.scrollY, filter: listView.filter, focusId: focusId || null } }, '');
    } catch {
      /* 무시 */
    }
  }
  root.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[data-item-link]');
    if (link && !event.defaultPrevented && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      saveListPosition(link.getAttribute('data-item-link'));
    }
  });

  // 건너뛰기 링크가 해시를 바꿔 라우팅을 흔들지 않게 한다
  doc.querySelector('.ui-skip')?.addEventListener('click', (event) => {
    event.preventDefault();
    mainEl?.focus();
  });

  function showState(opts) {
    setBar(false);
    listView = null;
    clear(root);
    const box = createState(doc, opts);
    root.append(box);
    return box;
  }

  async function render({ keepFocus = false, fresh = false } = {}) {
    const route = parseRoute(win.location.hash);
    if (!route) return;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const myId = ++renderId;
    const locale = getLocale();
    const saved = win.history.state?.itemsList || null;
    const previousFilter = listView ? listView.filter : null;
    shell.render();

    if (route.name === 'notfound') {
      setTitle(t('page.notFound'));
      showState({ kind: 'error', message: errorText('NOT_FOUND') });
      root.append(el(doc, 'a', { class: 'ui-btn-text', href: '#/items', text: t('detail.back') }));
      return;
    }

    try {
      if (route.name === 'list') {
        setTitle(t('page.items'));
        let items = fresh ? null : listCache.get(locale);
        if (!items) {
          showState({ kind: 'loading' });
          items = await getItems(signal);
          if (myId !== renderId) return;
          listCache.set(locale, items);
        }
        setBar(false);
        const filter = (keepFocus && previousFilter) || saved?.filter || 'all';
        listView = createListView(doc, { items, locale, filter });
        clear(root);
        root.append(listView.element);
        if (!keepFocus) {
          if (saved) {
            win.requestAnimationFrame(() => {
              win.scrollTo(0, saved.y || 0);
              const target = saved.focusId && [...root.querySelectorAll('a[data-item-link]')].find((a) => a.getAttribute('data-item-link') === saved.focusId);
              target?.focus({ preventScroll: true });
            });
          } else {
            listView.title.focus({ preventScroll: true });
            win.scrollTo(0, 0);
          }
        }
        return;
      }

      showState({ kind: 'loading' });
      const item = await getItem(route.id, signal);
      if (myId !== renderId) return;
      const view = createDetailView(doc, { item, locale });
      clear(root);
      root.append(view.element);
      setBar(view.hasBar);
      setTitle(item.title);
      if (!keepFocus) {
        view.title.focus({ preventScroll: true });
        win.scrollTo(0, 0);
      }
    } catch (error) {
      if (error?.name === 'AbortError' || myId !== renderId) return;
      const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';
      if (notFound) setTitle(t('page.notFound'));
      const box = showState({ kind: 'error', message: errorText(error), onRetry: notFound ? null : () => render({ fresh: true }) });
      if (notFound) root.append(el(doc, 'a', { class: 'ui-btn-text', href: '#/items', text: t('detail.back') }));
      if (!keepFocus) box.focus({ preventScroll: true });
    }
  }

  win.addEventListener('hashchange', () => render());
  render({ keepFocus: true });
  return { render, shell };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('[data-app-root]') && !globalThis.__SITE_TEST__) {
  start(window);
}
