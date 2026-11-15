// 포스터: 이미지가 있으면 <img>, 없으면 테마색 면 + 제목. 제목은 옆에 따로 있으므로 이미지 대체 글은 비운다.
import { el } from './dom.js';

export function createPoster(doc, item) {
  if (item.image) {
    return el(doc, 'img', { class: 'ui-poster', src: item.image, alt: '', width: '600', height: '800', loading: 'lazy', decoding: 'async' });
  }
  return el(doc, 'div', { class: 'ui-poster ui-poster--none', 'aria-hidden': 'true', text: item.title });
}
