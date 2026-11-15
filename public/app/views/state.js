// 상태 한 요소: 불러오는 중 · 비어 있음 · 오류. data-state 로 모양이 바뀐다.
import { el } from './dom.js';
import { t } from '../i18n.js';

export function createState(doc, { kind, message, onRetry }) {
  const box = el(doc, 'div', { class: 'ui-state', 'data-state': kind, role: kind === 'error' ? 'alert' : 'status', tabindex: '-1' });
  if (kind === 'loading') box.append(el(doc, 'span', { class: 'ui-state-bar', 'aria-hidden': 'true' }));
  box.append(el(doc, 'p', { class: kind === 'error' ? 'ui-error' : 'ui-state-text', text: message || (kind === 'loading' ? t('state.loading') : '') }));
  if (kind === 'error' && onRetry) {
    const button = el(doc, 'button', { class: 'ui-btn ui-btn--secondary', type: 'button', text: t('state.retry') });
    button.addEventListener('click', onRetry);
    box.append(button);
  }
  return box;
}
