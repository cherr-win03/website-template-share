// 정적 검사: CSP 에 맞는 화면 코드인지, 토큰 밖 색이 없는지, 대비 4.5:1 이상인지, 약속된 파일이 있는지
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const rel = (f) => path.relative(PUBLIC, f).replaceAll('\\', '/');
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (rel(full) === 'design/fonts') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}
const files = walk(PUBLIC);
const byExt = (ext) => files.filter((f) => f.endsWith(ext));
const read = (f) => fs.readFileSync(f, 'utf8');

test('약속된 화면 파일이 있다', () => {
  for (const f of ['index.html', 'login/index.html', 'members/index.html', '404.html', 'favicon.svg', 'design/tokens.css', 'design/base.css', 'design/components.css', 'design/layouts.css', 'app/site.js', 'app/i18n.js', 'app/messages.js', 'app/api.js', 'app/shell.js', 'app/main.js', 'app/login.js', 'app/members.js', 'design/fonts/pretendard/pretendard.css'].concat([1, 2, 3, 4, 5, 6].map((n) => `samples/poster-${n}.svg`))) {
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} 없음`);
  }
});

test('HTML: 인라인 script·style·style=·on* 없음, 랜드마크·건너뛰기·noscript 있음', () => {
  for (const f of byExt('.html')) {
    const html = read(f);
    const name = rel(f);
    assert.equal([...html.matchAll(/<script\b[^>]*>/gi)].filter((m) => !/\ssrc=/.test(m[0])).length, 0, `${name}: 인라인 script`);
    assert.equal([...html.matchAll(/<script\b[^>]*\ssrc=[^>]*>\s*[^<\s]/gi)].length, 0, `${name}: src 가 있는 script 안에 내용`);
    assert.ok(!/<style\b/i.test(html), `${name}: <style>`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${name}: style 속성`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${name}: on* 속성`);
    assert.ok(!/javascript:/i.test(html), `${name}: javascript: 주소`);
    assert.match(html, /<html lang="ko">/, `${name}: lang`);
    assert.match(html, /name="viewport"/);
    assert.match(html, /class="ui-skip" href="#content"/, `${name}: 건너뛰기 링크`);
    assert.match(html, /<header\b/);
    assert.match(html, /<main id="content"/);
    assert.match(html, /<footer\b/);
    assert.match(html, /<noscript>/);
    assert.match(html, /\/design\/fonts\/pretendard\/pretendard\.css/);
    for (const m of html.matchAll(/(?:href|src)="(https?:)?\/\/[^"]+"/g)) assert.fail(`${name}: 외부 주소 ${m[0]}`);
  }
});

test('JS: HTML 로 해석되는 삽입·eval·인라인 스타일 속성 없음', () => {
  const banned = [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /\.cssText\b/, /setAttribute\(\s*['"]style['"]/, /setAttribute\(\s*['"]on/i, /\bsrcdoc\b/, /createContextualFragment/, /DOMParser/];
  for (const f of byExt('.js')) {
    const src = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of banned) assert.ok(!re.test(src), `${rel(f)}: ${re}`);
    assert.ok(!/\.style\.(?!setProperty)\w+\s*=/.test(src), `${rel(f)}: style 직접 대입`);
    assert.ok(!/^import .*from ['"]https?:/m.test(src), `${rel(f)}: 외부 모듈`);
  }
});

test('CSS: 토큰 파일 밖에 색 값·순흑·명조 없음', () => {
  for (const f of byExt('.css')) {
    const name = rel(f);
    if (name === 'design/tokens.css' || name.startsWith('design/fonts/')) continue;
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), `${name}: hex 색`);
    assert.ok(!/\brgba?\(/.test(css), `${name}: rgb 색`);
    assert.ok(!/\b(serif|Batang|Myungjo|Mincho)\b/i.test(css.replace(/sans-serif/gi, '')), `${name}: 명조`);
    assert.ok(!/@import/.test(css), `${name}: @import`);
    assert.ok(!/(^|[\s,>+~}])#[a-zA-Z_-][\w-]*\s*[{,.:\[\s>]/.test(css.replace(/#[0-9a-fA-F]{3,8}\b/g, '')), `${name}: ID 선택자`);
  }
  const tokens = read(path.join(PUBLIC, 'design/tokens.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#000(?:000)?\b/i.test(tokens), '순흑');
  assert.ok(!/\bserif\b/i.test(tokens.replace(/sans-serif/gi, '')));
});

test('SVG 견본: 스크립트·외부 참조·이미지 없음', () => {
  for (const f of byExt('.svg')) {
    const svg = read(f);
    assert.ok(!/<script|<image|<foreignObject|href=|xlink|on[a-z]+=/i.test(svg), rel(f));
  }
});

// ---- 대비 ----
function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const tokensCss = read(path.join(PUBLIC, 'design/tokens.css')).replace(/\/\*[\s\S]*?\*\//g, '');
const vars = (block) => Object.fromEntries([...block.matchAll(/--ui-([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
const root = vars(tokensCss);

function accents() {
  const out = {};
  for (const m of tokensCss.matchAll(/(?::root,)?\[data-accent=(\w+)\]\{([^}]*)\}/g)) {
    const v = vars(m[2]);
    if (v['accent-700']) out[m[1]] = v;
  }
  const buttons = {};
  for (const m of tokensCss.matchAll(/\[data-accent=(\w+)\]\{([^}]*--ui-btn-bg:#[^}]*)\}/g)) buttons[m[1]] = vars(m[2]);
  return { out, buttons };
}

test('토큰 대비: 본문·보조 글자와 6색 테마의 글자·단추 조합이 4.5:1 이상', () => {
  assert.ok(root.ink && root.muted && root.page, '토큰 읽기 실패');
  assert.ok(ratio(root.ink, root.page) >= 4.5);
  assert.ok(ratio(root.muted, root.page) >= 4.5, '보조 글자/흰 바탕');
  assert.ok(ratio(root.ink, root['surface-2']) >= 4.5);
  assert.ok(ratio(root.muted, root['surface-2']) >= 4.5);
  assert.ok(ratio(root['field-border'], root.page) >= 3, '입력 테두리 비텍스트 3:1');
  for (const tone of ['ok', 'warn', 'danger']) assert.ok(ratio(root[tone], root[`${tone}-bg`]) >= 4.5, `${tone} 쌍`);
  assert.ok(ratio(root.danger, root.page) >= 4.5);

  const { out, buttons } = accents();
  assert.deepEqual(Object.keys(out).sort(), ['aqua', 'blue', 'coral', 'lavender', 'slate', 'yellow']);
  for (const [name, a] of Object.entries(out)) {
    const white = '#FFFFFF';
    assert.ok(ratio(root.muted, a['accent-50']) >= 4.5, `${name}: 보조/50`);
    assert.ok(ratio(root.ink, a['accent-50']) >= 4.5, `${name}: 잉크/50`);
    assert.ok(ratio(a['accent-900'], a['accent-50']) >= 4.5, `${name}: 900/50`);
    assert.ok(ratio(a['accent-900'], a['accent-100']) >= 4.5, `${name}: 900/100`);
    assert.ok(ratio(a['accent-700'], a['accent-50']) >= 4.5, `${name}: 700/50`);
    assert.ok(ratio(a['accent-700'], white) >= 4.5, `${name}: 700/흰`);
    const btn = buttons[name];
    const bg = btn?.['btn-bg'] || a['accent-700'];
    const fg = btn?.['btn-fg'] || '#FFFFFF';
    assert.ok(ratio(fg, bg) >= 4.5, `${name}: 단추 글자/면 ${ratio(fg, bg).toFixed(2)}`);
    // 면 위의 상태 칩(마감 임박: 흰 글자 / 700 면)
    assert.ok(ratio('#FFFFFF', a['accent-700']) >= 4.5, `${name}: 흰/700`);
  }
  assert.equal(buttons.yellow['btn-fg'], '#141A1F');
});
