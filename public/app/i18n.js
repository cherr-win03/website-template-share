// 언어 결정과 문구 찾기. 사전 형태: 키 → [ko, ja, en] (messages.js).
// 결정 순서: URL ?lang= → localStorage → navigator.language → ko.
import { MESSAGES } from './messages.js';
import { SITE } from './site.js';

export const LOCALES = ['ko', 'ja', 'en'];
export const DEFAULT_LOCALE = 'ko';
export const LOCALE_NAMES = { ko: '한국어', ja: '日本語', en: 'English' };

export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const short = value.trim().toLowerCase().slice(0, 2);
  return LOCALES.includes(short) ? short : null;
}

// 순수 함수: 입력만으로 언어를 정한다(시험하기 쉽게 window 를 읽지 않는다)
export function initialLocale({ search = '', stored = null, browser = [] } = {}) {
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(search).get('lang');
  } catch {
    fromUrl = null;
  }
  const candidates = [fromUrl, stored, ...(Array.isArray(browser) ? browser : [browser])];
  for (const candidate of candidates) {
    const found = normalizeLocale(candidate);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}

// 순수 함수: tr(사전, 언어, 키, 값). {name} 자리를 vars 로 바꾼다. 없는 키는 키 자체를 돌려준다
export function tr(dict, locale, key, vars) {
  const row = dict[key];
  if (!row) return key;
  const index = Math.max(0, LOCALES.indexOf(locale));
  let text = row[index] ?? row[0] ?? key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  }
  return text;
}

// ---- 현재 언어(화면이 쓰는 상태) ----
let current = DEFAULT_LOCALE;
const listeners = new Set();

function safeStorage(win) {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

export function getLocale() {
  return current;
}

export function t(key, vars) {
  return tr(MESSAGES, current, key, vars);
}

function applyDocument(win) {
  const doc = win?.document;
  if (doc?.documentElement) doc.documentElement.lang = current;
}

export function initLocale(win = globalThis.window) {
  const storage = win ? safeStorage(win) : null;
  let stored = null;
  try {
    stored = storage?.getItem(SITE.storageKey) ?? null;
  } catch {
    stored = null;
  }
  current = initialLocale({
    search: win?.location?.search || '',
    stored,
    browser: [...(win?.navigator?.languages || []), win?.navigator?.language],
  });
  // 주소의 ?lang= 으로 정해졌으면 저장해 둔다. 공유받은 일본어 링크로 들어온 사람이 다른 화면으로 가도 일본어가 유지된다.
  try {
    const fromUrl = normalizeLocale(new URLSearchParams(win?.location?.search || '').get('lang'));
    if (fromUrl && fromUrl !== stored) storage?.setItem(SITE.storageKey, fromUrl);
  } catch {
    /* 저장 실패는 무시 */
  }
  applyDocument(win);
  return current;
}

export function setLocale(locale, win = globalThis.window) {
  const next = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (next === current) return current;
  current = next;
  try {
    safeStorage(win)?.setItem(SITE.storageKey, next);
  } catch {
    /* 저장 실패는 무시: 이번 방문에서만 바뀐다 */
  }
  applyDocument(win);
  // 주소에 ?lang= 이 있으면 다음 새로고침에서 되돌아가지 않게 같이 바꾼다
  try {
    const url = new URL(win.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', next);
      win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
    }
  } catch {
    /* 무시 */
  }
  for (const listener of [...listeners]) listener(next);
  return next;
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
