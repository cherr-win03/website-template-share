// 소개글 구조화. 빈 줄 = 문단 나눔, "- " 줄 = 목록, "## " 줄 = 소제목.
// structureBody 는 DOM 을 모르는 순수 함수이고, renderBlocks 는 textContent 로만 글을 넣는다(스크립트 문자열도 그냥 글자).
import { el } from './dom.js';

export function structureBody(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'list', items: list });
    list = null;
  };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (line.startsWith('## ') && line.slice(3).trim() !== '') {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('- ') && line.slice(2).trim() !== '') {
      flushParagraph();
      (list ||= []).push(line.slice(2).trim());
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function renderBlocks(doc, blocks) {
  const nodes = [];
  for (const block of blocks) {
    if (block.type === 'heading') nodes.push(el(doc, 'h3', { class: 'ui-prose-sub', text: block.text }));
    else if (block.type === 'list') nodes.push(el(doc, 'ul', { class: 'ui-prose-list' }, block.items.map((item) => el(doc, 'li', { text: item }))));
    else nodes.push(el(doc, 'p', { class: 'ui-prose-p', text: block.text }));
  }
  return nodes;
}
