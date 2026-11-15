// 언어 결정·tr·문구 사전(오류 코드 포함)·소개글 구조화·날짜 표시
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialLocale, tr, normalizeLocale, LOCALES } from '../public/app/i18n.js';
import { MESSAGES, ERROR_CODES } from '../public/app/messages.js';
import { structureBody, renderBlocks } from '../public/app/views/describe.js';
import { formatDate, formatRange, daysUntil, ddayInfo } from '../public/app/views/format.js';
import { JSDOM } from 'jsdom';

test('언어 결정 순서: URL ?lang= → 저장값 → 브라우저 → ko', () => {
  assert.equal(initialLocale({ search: '?lang=ja', stored: 'en', browser: ['ko-KR'] }), 'ja');
  assert.equal(initialLocale({ search: '', stored: 'en', browser: ['ja-JP'] }), 'en');
  assert.equal(initialLocale({ search: '', stored: null, browser: ['fr-FR', 'ja-JP'] }), 'ja');
  assert.equal(initialLocale({ search: '?lang=xx', stored: 'zz', browser: ['de'] }), 'ko');
  assert.equal(initialLocale({}), 'ko');
  assert.equal(normalizeLocale('EN-us'), 'en');
  assert.equal(normalizeLocale(null), null);
});

test('tr: 사전 [ko,ja,en] 과 자리표시자', () => {
  const dict = { hi: ['안녕 {name}', 'こんにちは {name}', 'Hello {name}'], plain: ['가', '나', 'C'] };
  assert.equal(tr(dict, 'ko', 'hi', { name: 'A' }), '안녕 A');
  assert.equal(tr(dict, 'ja', 'hi', { name: 'A' }), 'こんにちは A');
  assert.equal(tr(dict, 'en', 'hi', { name: 'A' }), 'Hello A');
  assert.equal(tr(dict, 'en', 'hi'), 'Hello {name}');
  assert.equal(tr(dict, 'en', 'missing'), 'missing');
  assert.equal(tr(dict, 'xx', 'plain'), '가');
});

test('모든 문구가 세 언어 모두 비어 있지 않다', () => {
  for (const [key, row] of Object.entries(MESSAGES)) {
    assert.equal(row.length, LOCALES.length, `${key}: 칸 수`);
    for (const [i, text] of row.entries()) assert.ok(typeof text === 'string' && text.trim(), `${key}[${LOCALES[i]}] 비어 있음`);
    const holes = row.map((x) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(','));
    assert.equal(new Set(holes).size, 1, `${key}: 언어마다 자리표시자가 다름`);
  }
});

test('CONTRACT 의 오류 코드가 전부 세 언어 문구를 가진다', () => {
  const contract = fs.readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
  const found = new Set();
  for (const m of contract.matchAll(/\b[45]\d\d\s+(?:\{\s*"error":\s*")?([A-Z]+(?:_[A-Z]+)+)/g)) found.add(m[1]);
  for (const m of contract.matchAll(/error[=:]\s*"?([A-Z]+(?:_[A-Z]+)+)/g)) found.add(m[1]);
  // SITE_* 는 로그 꼬리표라 화면 문구 대상이 아니다.
  for (const m of contract.matchAll(/`([A-Z]+(?:_[A-Z]+)+)`/g)) if (!m[1].startsWith('SITE_') && /ERROR|REQUIRED|INVALID|UNAVAILABLE|DISABLED|FAILED|LIMITED|ALLOWED|MISCONFIGURED|LARGE|NOT_FOUND/.test(m[1])) found.add(m[1]);
  assert.ok(found.size >= 14, `계약에서 찾은 오류 코드 ${found.size}개`);
  for (const code of found) {
    const row = MESSAGES[`error.${code}`];
    assert.ok(row && row.every((x) => x.trim()), `error.${code} 문구 없음`);
  }
  for (const code of ['NETWORK_ERROR', 'UNKNOWN']) assert.ok(ERROR_CODES.includes(code));
});

test('화면 코드가 쓰는 t() 키가 사전에 있다', () => {
  const dir = new URL('../public/app/', import.meta.url);
  const files = ['login.js', 'members.js', 'notfound.js', 'main.js', 'shell.js', 'api.js', 'views/list.js', 'views/detail.js', 'views/state.js'];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) assert.ok(MESSAGES[m[1]], `${f}: t('${m[1]}') 가 사전에 없음`);
    for (const m of src.matchAll(/'((?:status|filter|fact)\.[\w]+)'|labelKey\b/g)) if (m[1]) assert.ok(MESSAGES[m[1]], m[1]);
  }
  for (const k of ['status.open', 'status.closing', 'status.closed', 'filter.all', 'filter.open', 'filter.closed', 'fact.dates', 'fact.place', 'fact.deadline']) assert.ok(MESSAGES[k], k);
});

test('소개글 구조화: 문단·목록·소제목, 스크립트 문자열은 글자로만', () => {
  const text = '## 제목\n첫 줄\n둘째 줄\n\n- 하나\n- 둘\n\n끝\r\n## \n- ';
  const blocks = structureBody(text);
  assert.deepEqual(blocks[0], { type: 'heading', text: '제목' });
  assert.deepEqual(blocks[1], { type: 'paragraph', text: '첫 줄\n둘째 줄' });
  assert.deepEqual(blocks[2], { type: 'list', items: ['하나', '둘'] });
  assert.equal(blocks[3].type, 'paragraph');
  assert.deepEqual(structureBody(''), []);
  assert.deepEqual(structureBody(null), []);

  const dom = new JSDOM('<!doctype html><body><div id="r"></div></body>');
  const doc = dom.window.document;
  const evil = '## <img src=x onerror=alert(1)>\n<script>window.pwned=1</script>\n- <b>굵게</b>';
  const host = doc.getElementById('r');
  host.append(...renderBlocks(doc, structureBody(evil)));
  assert.equal(host.querySelectorAll('script,img,b').length, 0);
  assert.ok(host.textContent.includes('<script>window.pwned=1</script>'));
  assert.ok(host.textContent.includes('<b>굵게</b>'));
  assert.equal(dom.window.pwned, undefined);
});

test('날짜·마감 표시(언어별, 시간대 달력 기준)', () => {
  assert.match(formatDate('2026-11-26', 'ko'), /2026년 11월 26일/);
  assert.match(formatDate('2026-11-26', 'ja'), /2026年11月26日/);
  assert.match(formatDate('2026-11-26', 'en'), /November 26, 2026/);
  assert.equal(formatRange('2026-11-26', '2026-11-28', 'en', { weekday: false }), 'November 26, 2026 – November 28');
  assert.equal(formatRange('2026-11-26', '2026-11-26', 'en', { weekday: false }), 'November 26, 2026');
  assert.equal(formatDate('bad', 'ko'), '');
  const now = new Date('2026-11-14T10:00:00+09:00');
  assert.equal(daysUntil('2026-11-14T23:00:00+09:00', now, 'Asia/Seoul'), 0);
  assert.equal(daysUntil('2026-11-17T01:00:00+09:00', now, 'Asia/Seoul'), 3);
  assert.equal(daysUntil('2026-11-13T23:00:00+09:00', now, 'Asia/Seoul'), null);
  assert.equal(daysUntil(null, now, 'Asia/Seoul'), null);
  assert.deepEqual(ddayInfo({ status: 'open', deadline: '2026-11-17T01:00:00+09:00' }, now, 'Asia/Seoul'), { text: 'D-3', days: 3, key: 'dday.left' });
  assert.equal(ddayInfo({ status: 'open', deadline: '2026-11-14T20:00:00+09:00' }, now, 'Asia/Seoul').text, 'D-day');
  assert.equal(ddayInfo({ status: 'closed', deadline: '2026-11-30T01:00:00+09:00' }, now, 'Asia/Seoul'), null);
  assert.equal(ddayInfo({ status: 'open', deadline: null }, now, 'Asia/Seoul'), null);
});
