// 시험용 가짜 D1: node:sqlite 메모리 DB 에 migrations/*.sql 을 적용하고 D1 바인딩처럼 감싼다.
// 보내는 모든 문장을 D1 제한 정적 검사(d1-sql-limits.js)에 통과시키고, 어기면 던진다(로컬 SQLite 는 D1 한도를 지키지 않으므로).
// 실제 D1 엔진 확인은 scripts/check-d1.mjs 가 한다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { d1BindViolations, d1SqlInfo, d1StatementViolations } from './d1-sql-limits.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

function guard(sql, args) {
  const info = d1SqlInfo(sql);
  const problems = [...d1StatementViolations(info), ...d1BindViolations(info, args)];
  if (info.statements > 1) problems.push('D1 prepare 는 한 문장만 받습니다');
  if (problems.length) throw new Error(`D1_LIMIT: ${problems.join('; ')} :: ${sql.replace(/\s+/g, ' ').slice(0, 200)}`);
}

function toSqlite(value) {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
  if (typeof value === 'boolean') throw new TypeError("D1_TYPE_ERROR: Type 'boolean' not supported");
  return value;
}

/**
 * @param {{failWhen?: (sql: string) => boolean}} [options] failWhen 이 참인 문장은 D1 오류처럼 던진다(장애 시험).
 */
export function createFakeD1(options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) db.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
  const log = [];

  function execute(sql, args, mode) {
    guard(sql, args);
    if (options.failWhen?.(sql)) throw new Error('D1_ERROR: simulated failure');
    log.push(sql);
    const statement = db.prepare(sql);
    const params = args.map(toSqlite);
    const returnsRows = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (mode === 'run' && !returnsRows) {
      const result = statement.run(...params);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    const rows = statement.all(...params).map((row) => ({ ...row }));
    return { success: true, results: rows, meta: { changes: 0 } };
  }

  function prepared(sql, args = []) {
    return {
      sql,
      args,
      bind: (...values) => prepared(sql, values),
      first: async (column) => {
        const row = execute(sql, args, 'all').results[0] ?? null;
        return column === undefined || row === null ? row : (row[column] ?? null);
      },
      all: async () => execute(sql, args, 'all'),
      run: async () => execute(sql, args, 'run'),
      raw: async () => execute(sql, args, 'all').results.map((row) => Object.values(row)),
    };
  }

  return {
    prepare: (sql) => prepared(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.args, 'run'));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    /** 시험에서 표를 직접 보거나 채울 때 */
    sqlite: db,
    /** 지금까지 보낸 문장(값은 없음) */
    log,
  };
}
