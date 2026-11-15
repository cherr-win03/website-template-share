// 목록 화면: 머리(제목·설명·건수) · 걸러 보기 칩 · 포스터 카드 목록.
import { el, clear } from './dom.js';
import { createPoster } from './poster.js';
import { createState } from './state.js';
import { ddayInfo, formatRange, formatDeadline } from './format.js';
import { t } from '../i18n.js';
import { SITE } from '../site.js';

export const FILTERS = ['all', 'open', 'closed'];

export function filterItems(items, filter) {
  if (filter === 'open') return items.filter((item) => item.status !== 'closed');
  if (filter === 'closed') return items.filter((item) => item.status === 'closed');
  return items;
}

export function buildCard(doc, item, { locale, now, featured, headingId }) {
  const card = el(doc, 'li', { class: `ui-card${featured ? ' ui-card--featured' : ''}`, 'data-accent': item.accent, 'data-status': item.status, 'data-item-id': item.id });
  card.append(createPoster(doc, item));

  const meta = el(doc, 'div', { class: 'ui-card-meta' }, [el(doc, 'span', { class: 'ui-status', 'data-status': item.status, text: t(`status.${item.status}`) })]);
  const dday = ddayInfo(item, now, SITE.timeZone);
  if (dday) {
    meta.append(el(doc, 'span', { class: 'ui-dday', 'aria-hidden': 'true', text: dday.text }));
    meta.append(el(doc, 'span', { class: 'ui-sr-only', text: t(dday.key, { n: dday.days }) }));
  }
  card.append(meta);

  const link = el(doc, 'a', { class: 'ui-card-link', href: `#/items/${encodeURIComponent(item.id)}`, 'data-item-link': item.id, text: item.title });
  card.append(el(doc, 'h2', { class: 'ui-card-title', id: headingId }, [link]));
  card.append(el(doc, 'p', { class: 'ui-card-summary', text: item.summary }));

  const facts = el(doc, 'ul', { class: 'ui-facts' });
  const addFact = (labelKey, value) => {
    if (!value) return;
    facts.append(el(doc, 'li', { class: 'ui-fact' }, [el(doc, 'span', { class: 'ui-fact-label', text: t(labelKey) }), el(doc, 'span', { class: 'ui-fact-value', text: value })]));
  };
  addFact('fact.dates', formatRange(item.startsOn, item.endsOn, locale, { weekday: false }));
  addFact('fact.place', item.place);
  if (item.status !== 'closed') addFact('fact.deadline', item.deadline ? formatDeadline(item.deadline, locale, SITE.timeZone, { weekday: false }) : '');
  card.append(facts);

  card.append(el(doc, 'div', { class: 'ui-card-foot' }, [el(doc, 'span', { class: 'ui-card-more', 'aria-hidden': 'true', text: t('card.more') })]));
  return card;
}

// 대표 카드: 4건 이상이면 첫 항목, 1~2건이면 전부
export function featuredIndexes(count) {
  if (count >= 4) return new Set([0]);
  if (count > 0 && count <= 2) return new Set(Array.from({ length: count }, (_, i) => i));
  return new Set();
}

export function createListView(doc, { items, locale, filter = 'all', now = new Date(), onFilterChange }) {
  const root = el(doc, 'section', { class: 'ui-list', 'aria-labelledby': 'list-title' });
  const openCount = items.filter((item) => item.status !== 'closed').length;

  const title = el(doc, 'h1', { class: 'ui-hero-title', id: 'list-title', tabindex: '-1', text: t('list.title') });
  const counts = el(doc, 'dl', { class: 'ui-counts' }, [
    el(doc, 'div', {}, [el(doc, 'dt', { text: t('list.countOpen') }), el(doc, 'dd', { text: String(openCount) })]),
    el(doc, 'div', {}, [el(doc, 'dt', { text: t('list.countClosed') }), el(doc, 'dd', { text: String(items.length - openCount) })]),
  ]);
  root.append(el(doc, 'div', { class: 'ui-hero' }, [el(doc, 'div', { class: 'ui-hero-text' }, [title, el(doc, 'p', { class: 'ui-hero-lead', text: t('list.lead') })]), counts]));

  const chipBox = el(doc, 'div', { class: 'ui-chips', role: 'group', 'aria-label': t('filter.label') });
  const chips = new Map();
  const view = { element: root, title, filter };
  for (const name of FILTERS) {
    const chip = el(doc, 'button', { class: 'ui-chip', type: 'button', 'data-filter': name, 'aria-pressed': 'false', text: t(`filter.${name}`) });
    chip.addEventListener('click', () => {
      view.setFilter(name);
      onFilterChange?.(name);
    });
    chips.set(name, chip);
    chipBox.append(chip);
  }
  const status = el(doc, 'p', { class: 'ui-list-count', role: 'status' });
  root.append(el(doc, 'div', { class: 'ui-list-tools' }, [chipBox, status]));

  const body = el(doc, 'div', { 'data-list-body': '' });
  root.append(body);

  view.setFilter = (next) => {
    view.filter = FILTERS.includes(next) ? next : 'all';
    for (const [name, chip] of chips) chip.setAttribute('aria-pressed', String(name === view.filter));
    const shown = filterItems(items, view.filter);
    status.textContent = items.length ? (shown.length === 1 ? t('list.shownOne') : t('list.shown', { n: shown.length })) : '';
    clear(body);
    if (!shown.length) {
      body.append(createState(doc, { kind: 'empty', message: t(items.length ? 'list.emptyFiltered' : 'list.empty') }));
      return;
    }
    const featured = featuredIndexes(shown.length);
    const gallery = el(doc, 'ol', { class: 'ui-gallery' });
    shown.forEach((item, index) => gallery.append(buildCard(doc, item, { locale, now, featured: featured.has(index), headingId: `item-title-${item.id}` })));
    body.append(gallery);
  };
  view.setFilter(filter);
  return view;
}
