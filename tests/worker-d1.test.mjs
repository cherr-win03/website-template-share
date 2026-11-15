// D1 제한 정적 검사(docs/D1_RULES.md). 실제 엔진 확인은 `npm run check:d1`.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSeedSql } from '../scripts/seed-local.mjs';
import { collectRepositorySql, looksLikeSql, migrationNameProblems, splitSqlStatements, staticViolations, stringLiterals } from '../scripts/lib/d1-static.mjs';
import { ITEM_DETAIL_SQL, ITEM_LIST_SQL } from '../worker/items.js';
import { SESSION_CLEANUP_SQL, SESSION_DELETE_SQL, SESSION_INSERT_SQL, SESSION_SELECT_SQL, SESSION_UPDATE_SQL } from '../worker/auth/session.js';
import { d1BindViolations, d1SqlInfo, d1StatementViolations } from './helpers/d1-sql-limits.js';
import { createFakeD1 } from './helpers/fake-d1.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const union = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS v`).join(' UNION ALL ');

describe('d1-sql-limits', () => {
  it('compound SELECT 5항까지, 6항은 위반', () => {
    assert.deepEqual(d1StatementViolations(d1SqlInfo(union(5))), []);
    assert.match(d1StatementViolations(d1SqlInfo(union(6)))[0], /compound SELECT has 6 terms/);
  });
  it('문자열·주석 안의 UNION 은 세지 않는다', () => {
    const sql = `SELECT 'UNION UNION UNION UNION UNION UNION' AS a -- UNION UNION\n/* UNION */ FROM t`;
    assert.equal(d1SqlInfo(sql).compound, 1);
  });
  it('함수 인자 32·바인딩 100·LIKE 50바이트', () => {
    const args = (n) => `SELECT coalesce(${Array.from({ length: n }, () => '1').join(',')})`;
    assert.deepEqual(d1StatementViolations(d1SqlInfo(args(32))), []);
    assert.equal(d1StatementViolations(d1SqlInfo(args(33))).length, 1);
    assert.equal(d1StatementViolations(d1SqlInfo('SELECT ?101')).length, 1);
    assert.equal(d1StatementViolations(d1SqlInfo(`SELECT 1 WHERE a LIKE '${'x'.repeat(51)}'`)).length, 1);
    assert.equal(d1StatementViolations(d1SqlInfo(`SELECT 1 WHERE a GLOB '${'[0-9]'.repeat(11)}'`)).length, 1);
    const info = d1SqlInfo('SELECT 1 FROM t WHERE a LIKE ?1');
    assert.equal(d1BindViolations(info, ['x'.repeat(51)]).length, 1);
    assert.equal(d1BindViolations(info, ['x'.repeat(50)]).length, 0);
  });
  it('가짜 D1 은 위반 문장을 거부한다(로컬 SQLite 는 통과시키는 문장)', async () => {
    const d1 = createFakeD1();
    await assert.rejects(d1.prepare(union(6)).all(), /D1_LIMIT/);
    assert.equal((await d1.prepare(union(5)).all()).results.length, 5);
  });
});

describe('저장소 SQL', () => {
  it('worker 의 SQL 상수를 모두 찾는다', async () => {
    const entries = await collectRepositorySql(root);
    const found = new Set(entries.filter((entry) => entry.origin === 'worker').map((entry) => entry.sql));
    for (const sql of [ITEM_LIST_SQL, ITEM_DETAIL_SQL, SESSION_INSERT_SQL, SESSION_SELECT_SQL, SESSION_UPDATE_SQL, SESSION_DELETE_SQL, SESSION_CLEANUP_SQL]) {
      assert.ok(found.has(sql), sql.slice(0, 60));
    }
  });
  it('모든 SQL 이 D1 제한 안이고 ${} 끼워 넣기가 없다', async () => {
    assert.deepEqual(staticViolations(await collectRepositorySql(root)), []);
  });
  it('항목 SQL 은 compound SELECT 를 쓰지 않는다', () => {
    assert.equal(d1SqlInfo(ITEM_LIST_SQL).compound, 1);
    assert.equal(d1SqlInfo(ITEM_DETAIL_SQL).compound, 1);
  });
  it('마이그레이션 이름은 wrangler 형식(0001_이름.sql, 번호 연속)', () => {
    assert.deepEqual(migrationNameProblems(readdirSync(new URL('../migrations/', import.meta.url))), []);
    assert.deepEqual(migrationNameProblems(['0001_a.sql', '0003_b.sql']).length, 1);
    assert.deepEqual(migrationNameProblems(['1_a.sql']).length, 1);
  });
  it('시드 SQL 도 D1 제한 안', () => {
    const statements = splitSqlStatements(buildSeedSql('2026-11-14'));
    assert.equal(statements.length, 2 + 6 + 18);
    for (const sql of statements) assert.deepEqual(d1StatementViolations(d1SqlInfo(sql)), [], sql.slice(0, 80));
  });
});

describe('SQL 찾기 도구', () => {
  it('정규식 안의 따옴표에 속지 않는다', () => {
    const source = "const re = /^[^\\s@<>\"'\\\\]+@x$/u; const sql = 'SELECT a FROM t WHERE b = ?1'; const t = `x${y}z`;";
    const literals = stringLiterals(source).map((literal) => literal.value);
    assert.ok(literals.includes('SELECT a FROM t WHERE b = ?1'));
    assert.deepEqual(stringLiterals('`SELECT a FROM t WHERE b = ${x}`')[0], { value: 'SELECT a FROM t WHERE b = ?', line: 1, interpolated: true });
  });
  it('${} 를 쓴 SQL 은 위반으로 잡는다', () => {
    const [problem] = staticViolations([{ source: 'x.js:1', sql: 'SELECT a FROM t WHERE b = ?', interpolated: true, origin: 'worker' }]);
    assert.match(problem.problems[0], /바인딩 매개변수/);
  });
  it('일반 문장은 SQL 로 보지 않는다', () => {
    assert.equal(looksLikeSql('Select a provider'), false);
    assert.equal(looksLikeSql('delete this'), false);
    assert.equal(looksLikeSql('SELECT 1 FROM t'), true);
  });
  it('트리거 안의 ";" 로는 나누지 않는다', () => {
    const sql = 'CREATE TABLE a (x);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN 1 THEN 2 END; DELETE FROM a; END;\nSELECT 1 FROM a;';
    assert.equal(splitSqlStatements(sql).length, 3);
  });
  it('migrations 폴더가 실제로 있다', () => {
    assert.ok(readdirSync(new URL('../migrations/', import.meta.url)).length >= 2);
  });
});
