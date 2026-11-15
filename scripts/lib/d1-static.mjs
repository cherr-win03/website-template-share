// 저장소 SQL 모으기 + D1 제한 정적 검사(scripts/check-d1.mjs 와 tests/worker-d1.test.mjs 가 같이 쓴다).
// - worker/**/*.js 의 문자열·템플릿 리터럴 중 SQL 로 보이는 것(SELECT…FROM, INSERT INTO, UPDATE…SET, DELETE FROM, CREATE …, WITH …)
// - migrations/*.sql 의 문장(";" 로 나눔, CREATE TRIGGER … BEGIN … END 안의 ";" 는 나누지 않음)
// JS 는 가벼운 토큰 읽기로 본다(주석·문자열·템플릿·정규식 리터럴 구분). 규칙: SQL 은 문자열 상수로 쓰고 ${} 로 값을 끼우지 않는다.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { d1SqlInfo, d1StatementViolations } from '../../tests/helpers/d1-sql-limits.js';

const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '~', '+', '-', '*', '%', '<', '>', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * JS 원문의 문자열·템플릿 리터럴. {value, line, interpolated}
 * @param {string} source
 */
export function stringLiterals(source) {
  const out = [];
  let i = 0;
  let last = '';
  const lineAt = (index) => source.slice(0, index).split('\n').length;

  function readQuoted(quote) {
    const start = i;
    i += 1;
    let value = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        const next = source[i + 1];
        value += ESCAPES[next] ?? (next === '\n' ? '' : next);
        i += 2;
      } else {
        value += source[i];
        i += 1;
      }
    }
    i += 1;
    out.push({ value, line: lineAt(start), interpolated: false });
  }

  function readTemplate() {
    const start = i;
    i += 1;
    let value = '';
    let interpolated = false;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        const next = source[i + 1];
        value += ESCAPES[next] ?? next;
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        interpolated = true;
        i += 2;
        scan('}');
        i += 1;
        value += '?';
      } else {
        value += source[i];
        i += 1;
      }
    }
    i += 1;
    out.push({ value, line: lineAt(start), interpolated });
  }

  function readRegex() {
    i += 1;
    let inClass = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i += 1;
        break;
      }
      i += 1;
    }
    while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
  }

  // end: 이 글자를 깊이 0 에서 만나면 멈춘다(템플릿 ${ … } 안).
  function scan(end) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (/\s/.test(c)) {
        i += 1;
      } else if (c === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else if (c === '/' && next === '*') {
        const close = source.indexOf('*/', i + 2);
        i = close < 0 ? source.length : close + 2;
      } else if (c === "'" || c === '"') {
        readQuoted(c);
        last = 'string';
      } else if (c === '`') {
        readTemplate();
        last = 'string';
      } else if (c === '/' && (REGEX_BEFORE.has(last) || REGEX_AFTER_WORD.has(last))) {
        readRegex();
        last = 'regex';
      } else if (/[A-Za-z_$]/.test(c)) {
        const match = /^[A-Za-z0-9_$]+/.exec(source.slice(i, i + 64));
        last = match[0];
        i += match[0].length;
      } else if (/[0-9]/.test(c)) {
        const match = /^[0-9][0-9a-fA-FxXoObBn_.eE]*/.exec(source.slice(i, i + 64));
        last = 'number';
        i += match[0].length;
      } else {
        if (end && c === end && depth === 0) return;
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        last = c;
        i += 1;
      }
    }
  }

  scan(null);
  return out;
}

/** SQL 로 보이는 글인지(일반 문장 "Select a provider" 같은 것은 빼도록 구조까지 본다). */
export function looksLikeSql(text) {
  const sql = String(text).trim();
  return (
    /^SELECT\b[\s\S]*\bFROM\b/i.test(sql) ||
    /^INSERT\s+(?:OR\s+\w+\s+)?INTO\b/i.test(sql) ||
    /^REPLACE\s+INTO\b/i.test(sql) ||
    /^UPDATE\s+\w+\s+SET\b/i.test(sql) ||
    /^DELETE\s+FROM\b/i.test(sql) ||
    /^WITH\s+(?:RECURSIVE\s+)?\w+[\s\S]*\bSELECT\b/i.test(sql) ||
    /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\b/i.test(sql) ||
    /^EXPLAIN\s+SELECT\b/i.test(sql)
  );
}

const SQL_TOKEN = /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$)|\[[^\]]*(?:\]|$)|[A-Za-z_][A-Za-z0-9_$]*|;|[^\s]/gy;

/** SQL 파일 → 문장 목록(주석만 남은 조각은 버린다). */
export function splitSqlStatements(text) {
  const statements = [];
  let current = '';
  let first = null;
  let trigger = false;
  let body = 0;
  let cases = 0;
  let content = false;
  SQL_TOKEN.lastIndex = 0;
  for (let m; SQL_TOKEN.lastIndex < text.length && (m = SQL_TOKEN.exec(text)); ) {
    const t = m[0];
    current += t;
    if (/^\s/.test(t) || t.startsWith('--') || t.startsWith('/*')) continue;
    const upper = /^[A-Za-z_]/.test(t) ? t.toUpperCase() : null;
    if (t === ';' && !body) {
      if (content) statements.push(current.slice(0, -1).trim());
      current = '';
      first = null;
      trigger = false;
      cases = 0;
      content = false;
      continue;
    }
    content = true;
    if (upper && first === null) first = upper;
    if (first === 'CREATE' && upper === 'TRIGGER') trigger = true;
    if (trigger) {
      if (upper === 'BEGIN') body += 1;
      else if (upper === 'CASE') cases += 1;
      else if (upper === 'END') {
        if (cases) cases -= 1;
        else if (body) body -= 1;
      }
    }
  }
  if (content && current.trim()) statements.push(current.trim());
  return statements;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.m?js$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/**
 * 저장소의 SQL 전부. [{source: 'worker/items.js:12' | 'migrations/0001_items.sql#1', sql, interpolated, origin: 'worker'|'migration'}]
 * @param {string} root 저장소 경로
 */
export async function collectRepositorySql(root) {
  const entries = [];
  for (const file of await walk(join(root, 'worker'))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    for (const literal of stringLiterals(await readFile(file, 'utf8'))) {
      if (looksLikeSql(literal.value)) entries.push({ source: `${rel}:${literal.line}`, sql: literal.value, interpolated: literal.interpolated, origin: 'worker' });
    }
  }
  const migrationDir = join(root, 'migrations');
  const names = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) {
    splitSqlStatements(await readFile(join(migrationDir, name), 'utf8')).forEach((sql, index) => {
      entries.push({ source: `migrations/${name}#${index + 1}`, sql, interpolated: false, origin: 'migration' });
    });
  }
  return entries;
}

/** 정적 위반 목록. [{source, problems: string[]}] (위반 없는 항목은 빠진다) */
export function staticViolations(entries) {
  const out = [];
  for (const entry of entries) {
    const info = d1SqlInfo(entry.sql);
    const problems = d1StatementViolations(info);
    if (entry.origin === 'worker' && info.statements > 1) problems.push('한 문자열에 SQL 문장이 여러 개입니다(D1 prepare 는 한 문장)');
    if (entry.interpolated) problems.push('SQL 문자열에 ${} 로 값을 끼웠습니다. 값은 바인딩 매개변수(?1, ?2 …)로 넘깁니다');
    if (problems.length) out.push({ source: entry.source, problems });
  }
  return out;
}

/** 마이그레이션 파일 이름이 wrangler d1 migrations 형식(0001_이름.sql, 번호 연속)인지. 틀린 이름 목록. */
export function migrationNameProblems(names) {
  const problems = [];
  names
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .forEach((name, index) => {
      const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
      if (!match) problems.push(`${name}: 이름은 0001_소문자_이름.sql 형식`);
      else if (Number(match[1]) !== index + 1) problems.push(`${name}: 번호가 ${String(index + 1).padStart(4, '0')} 이어야 합니다(빠지거나 겹친 번호)`);
    });
  return problems;
}
