// 상세 화면: 전폭 테마 띠(포스터·D-day·제목·정보) + 소개글 + 정보 카드(모바일은 아래 고정 바).
import { el } from './dom.js';
import { createPoster } from './poster.js';
import { structureBody, renderBlocks } from './describe.js';
import { ddayInfo, formatRange, formatDeadline } from './format.js';
import { t } from '../i18n.js';
import { SITE, pick } from '../site.js';

export function createDetailView(doc, { item, locale, now = new Date() }) {
  const article = el(doc, 'article', { class: 'ui-detail', 'data-accent': item.accent, 'data-status': item.status });

  const poster = el(doc, 'figure', { class: 'ui-detail-poster' }, [createPoster(doc, item)]);
  const head = el(doc, 'div', { class: 'ui-detail-head' }, [
    el(doc, 'div', { class: 'ui-detail-meta' }, [el(doc, 'span', { class: 'ui-status', 'data-status': item.status, text: t(`status.${item.status}`) })]),
  ]);
  const dday = ddayInfo(item, now, SITE.timeZone);
  if (dday) {
    head.append(el(doc, 'div', { class: 'ui-detail-dday' }, [
      el(doc, 'span', { class: 'ui-detail-dday-num', 'aria-hidden': 'true', text: dday.text }),
      el(doc, 'span', { class: 'ui-detail-dday-text', text: t(dday.key, { n: dday.days }) }),
    ]));
  }

  const facts = el(doc, 'ul', { class: 'ui-facts' });
  const addFact = (labelKey, value) => {
    if (!value) return;
    facts.append(el(doc, 'li', { class: 'ui-fact' }, [el(doc, 'span', { class: 'ui-fact-label', text: t(labelKey) }), el(doc, 'span', { class: 'ui-fact-value', text: value })]));
  };
  addFact('fact.dates', formatRange(item.startsOn, item.endsOn, locale));
  addFact('fact.place', item.place);
  addFact('fact.deadline', item.deadline ? formatDeadline(item.deadline, locale, SITE.timeZone) : '');

  const title = el(doc, 'h1', { class: 'ui-detail-title', id: 'detail-title', tabindex: '-1', text: item.title });
  const content = el(doc, 'div', { class: 'ui-detail-content' }, [
    head,
    title,
    item.summary ? el(doc, 'p', { class: 'ui-detail-lead', text: item.summary }) : null,
    facts,
    el(doc, 'p', { class: 'ui-note', text: pick(SITE.timeZoneNote, locale) }),
  ]);
  const back = el(doc, 'a', { class: 'ui-back', href: '#/items', 'data-back': '', text: t('detail.back') });
  article.append(el(doc, 'div', { class: 'ui-detail-hero' }, [back, poster, content]));

  const main = el(doc, 'div', { class: 'ui-detail-main' });
  let hasBar = false;
  if (item.link) {
    hasBar = true;
    const bar = el(doc, 'div', { class: 'ui-action-bar' });
    if (dday) {
      bar.append(el(doc, 'p', { class: 'ui-when', 'aria-hidden': 'true' }, [el(doc, 'span', { class: 'ui-when-num', text: dday.text })]));
    }
    bar.append(el(doc, 'a', { class: 'ui-btn', href: item.link, target: '_blank', rel: 'noopener noreferrer' }, [
      t('detail.openLink'),
      el(doc, 'span', { class: 'ui-sr-only', text: ` ${t('detail.newTab')}` }),
    ]));
    const card = el(doc, 'aside', { class: 'ui-action-card', 'aria-labelledby': 'action-title' }, [el(doc, 'h2', { class: 'ui-action-title', id: 'action-title', text: t('detail.actionTitle') }), bar]);
    if (item.status === 'closed') card.append(el(doc, 'p', { class: 'ui-action-note', text: t('detail.closedNote') }));
    main.append(card);
  } else {
    main.classList.add('ui-detail-main--solo');
  }
  const text = el(doc, 'div', { class: 'ui-detail-text' });
  if (item.body && item.body.trim()) {
    text.append(el(doc, 'h2', { class: 'ui-prose-title', text: t('detail.about') }));
    text.append(...renderBlocks(doc, structureBody(item.body)));
  }
  main.append(text);
  article.append(main);
  return { element: article, title, hasBar };
}
