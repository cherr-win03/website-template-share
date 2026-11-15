// D1 얇은 도우미. SQL 은 문자열 상수로 쓰고 값은 언제나 바인딩 매개변수(?1, ?2 …)로 넘긴다(문자열 이어 붙이기 금지).
// 새 SQL 은 docs/D1_RULES.md 의 제한(compound SELECT 5항·함수 인자 32·바인딩 100 등)을 지키고 `npm run check:d1` 로 확인한다.
import { fail } from './http.js';

const MAX_BINDINGS = 100;

function checkArgs(args) {
  if (args.length > MAX_BINDINGS) throw new TypeError(`D1 바인딩은 ${MAX_BINDINGS}개까지입니다`);
  for (const value of args) {
    const ok =
      value === null ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value);
    // undefined·boolean·객체는 D1 이 거부하거나 뜻이 바뀐다. 호출하는 쪽에서 null·0/1·JSON 문자열로 바꾼다.
    if (!ok) throw new TypeError('D1 바인딩 값은 문자열·유한한 숫자·null·바이트만 됩니다');
  }
  return args;
}

/**
 * @param {Record<string, any>} env
 */
export function database(env) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') fail(503, 'SERVICE_UNAVAILABLE');
  /** @param {string} sql @param {...any} args */
  const statement = (sql, ...args) => db.prepare(sql).bind(...checkArgs(args));
  return Object.freeze({
    statement,
    /** 첫 행 또는 null */
    first: (sql, ...args) => statement(sql, ...args).first(),
    /** 모든 행(배열) */
    all: async (sql, ...args) => (await statement(sql, ...args).all()).results ?? [],
    /** 쓰기. 결과의 meta.changes 로 바뀐 행 수를 본다 */
    run: (sql, ...args) => statement(sql, ...args).run(),
    /** 여러 문장을 한 번에(하나의 트랜잭션) */
    batch: (statements) => db.batch(statements),
  });
}
