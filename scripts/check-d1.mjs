// D1 검사(npm run check:d1). 로컬 전용: 원격 계정·토큰·운영 DB 를 쓰지 않는다.
//  (a) 정적 검사: worker/**/*.js 안의 SQL 문자열과 migrations/*.sql 을 D1 제한(compound SELECT 5항, 함수 인자 32, 바인딩 100,
//      문장 100000바이트, LIKE/GLOB 패턴 50바이트)과 "${} 끼워 넣기 금지"로 본다. 마이그레이션 이름 형식도 본다.
//  (b) 로컬 D1 엔진(workerd): 빈 임시 DB 에 `wrangler d1 migrations apply --local` 로 마이그레이션을 실제로 적용하고,
//      worker 의 모든 SQL 을 EXPLAIN 으로 파싱·이름 해석까지 해 본 뒤, 항목·세션 모듈을 그 DB 에 대고 실제로 실행한다.
// 왜: D1 은 로컬 SQLite·node:sqlite 시험이 잡지 못하는 낮은 한도를 둔다(9항 UNION ALL 이 시험은 통과하고 운영에서 503 이 난 사례가 있다).
// 임시 DB 는 저장소 밖 ../qa/check-d1/state(SITE_QA_DIR 로 바꿈)에 매번 새로 만든다. 개발용 .wrangler/state 는 건드리지 않는다.
// 한계: LIKE 패턴 길이는 실행할 때 값으로 정해지므로 바인딩 값이 있는 실제 실행에서만 잡힌다. 함수 인자는 로컬 엔진이 127까지 받아 32는 정적 검사가 맡는다.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { d1SqlInfo } from '../tests/helpers/d1-sql-limits.js';
import { collectRepositorySql, migrationNameProblems, splitSqlStatements, staticViolations } from './lib/d1-static.mjs';
import { buildSeedSql, qaDir, seedItems, todayKst } from './seed-local.mjs';
import { database } from '../worker/db.js';
import { getItem, listItems } from '../worker/items.js';
import { createSession, deleteSession, readSession, SESSION_COOKIE, updateSessionData } from '../worker/auth/session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

// (a) 정적 검사
const entries = await collectRepositorySql(root);
const migrationNames = (await readdir(join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
for (const violation of staticViolations(entries)) failures.push(`정적: ${violation.source}: ${violation.problems.join('; ')}`);
for (const problem of migrationNameProblems(migrationNames)) failures.push(`마이그레이션 이름: ${problem}`);
const workerSql = entries.filter((entry) => entry.origin === 'worker');

// (b) 로컬 D1 엔진
const qa = join(qaDir(), 'check-d1');
const state = join(qa, 'state');
// Windows 에서 workerd 의 SQLite 파일 경로가 260자를 넘으면 "internal error" 로 멈춘다.
if (process.platform === 'win32' && state.length > 140) {
  console.error(`check-d1: 임시 경로가 너무 깁니다(${state.length}자 > 140). SITE_QA_DIR 를 짧은 경로로 지정하세요.`);
  process.exit(1);
}
await rm(state, { recursive: true, force: true });
await mkdir(state, { recursive: true });
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const childEnv = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' };
try {
  const log = execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await writeFile(join(qa, 'migration.log'), log, 'utf8');
} catch (error) {
  await writeFile(join(qa, 'migration.log'), `${error.stdout || ''}\n${error.stderr || ''}`, 'utf8');
  console.error(`check-d1: 마이그레이션 적용 실패. 기록: ${join(qa, 'migration.log')}`);
  process.exit(1);
}

const engine = { explained: 0, explainFailures: [], limitProbe: null, flows: [] };
const proxy = await getPlatformProxy({ configPath: join(root, 'wrangler.jsonc'), persist: { path: join(state, 'v3') }, remoteBindings: false });
try {
  const DB = proxy.env.DB;
  const env = { DB };
  const tables = (await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((row) => row.name);
  for (const table of ['items', 'item_texts', 'sessions', 'd1_migrations']) check(tables.includes(table), `엔진: 표 ${table} 이 없습니다`);
  const applied = (await DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((row) => row.name);
  check(JSON.stringify(applied) === JSON.stringify(migrationNames), `엔진: 적용된 마이그레이션 ${JSON.stringify(applied)} ≠ 파일 ${JSON.stringify(migrationNames)}`);

  // worker 의 모든 SQL 을 EXPLAIN(파싱·한도·이름 해석). 표가 모두 있으므로 어떤 오류든 실패다.
  for (const entry of workerSql) {
    const info = d1SqlInfo(entry.sql);
    try {
      await DB.prepare(`EXPLAIN ${entry.sql}`).bind(...Array(info.maxParameter).fill(null)).all();
      engine.explained += 1;
    } catch (error) {
      engine.explainFailures.push({ source: entry.source, error: String(error?.message || error).slice(0, 300) });
      failures.push(`엔진 EXPLAIN: ${entry.source}: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  // 검사기 자체 확인: 6항 compound SELECT 를 로컬 엔진이 실제로 거부하는지.
  try {
    await DB.prepare(`EXPLAIN ${Array.from({ length: 6 }, (_, i) => `SELECT ${i}`).join(' UNION ALL ')}`).all();
    engine.limitProbe = 'not-rejected';
    notes.push('로컬 엔진이 6항 compound SELECT 를 거부하지 않았습니다(정적 검사만 이 한도를 지킵니다)');
  } catch (error) {
    engine.limitProbe = /too many terms in compound SELECT/i.test(String(error?.message)) ? 'rejected' : `other: ${String(error?.message).slice(0, 120)}`;
  }

  // 실제 실행: 시드 → 항목 모듈
  const today = todayKst();
  const seed = splitSqlStatements(buildSeedSql(today));
  await DB.batch(seed.map((sql) => DB.prepare(sql)));
  const now = Date.now();
  const expected = Object.fromEntries(seedItems(today).map((item) => [item.id, item.expected]));
  const list = await listItems(env, 'ja', now);
  check(list.length === 6, `실행: 목록 ${list.length}개(6개여야 함)`);
  check(list.every((item) => item.status === expected[item.id]), `실행: 상태 ${JSON.stringify(list.map((item) => [item.id, item.status]))}`);
  check(list.find((item) => item.id === 'sample-city-walk')?.title === '街歩きの会', '실행: 일본어 제목');
  await DB.prepare("DELETE FROM item_texts WHERE item_id = ?1 AND locale = 'ja'").bind('sample-city-walk').run();
  const fallback = await listItems(env, 'ja', now);
  check(fallback.find((item) => item.id === 'sample-city-walk')?.title === '도심 걷기 모임', '실행: ja 글이 없으면 ko 로 채워야 함');
  const detail = await getItem(env, 'sample-community-workshop', 'en', now);
  check(detail?.body.includes('<script>alert("x")</script>') && detail.link === 'https://example.com/workshop', '실행: 상세 본문·링크');
  check((await getItem(env, 'nope', 'ko', now)) === null, '실행: 없는 항목은 null');
  engine.flows.push('items');

  // 실제 실행: 세션 모듈(만들기·읽기·갱신 경합·삭제·만료 정리)
  const db = database(env);
  const key = crypto.getRandomValues(new Uint8Array(32));
  await DB.prepare('INSERT INTO sessions (id, data, csrf, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind('0'.repeat(64), 'x', 'y', 1, 2).run();
  const data = { userId: '00000000-0000-4000-8000-000000000001', email: 'check@example.test', provider: 'email', accessToken: 'a', refreshToken: 'r', accessExpiresAt: 1 };
  const created = await createSession(db, key, data, now);
  const cookie = /=([a-f0-9]{64});/.exec(created.cookie)[1];
  const request = new Request('http://127.0.0.1/', { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  const read = await readSession(request, db, key, now);
  check(read.state === 'ok' && read.data.email === 'check@example.test', '실행: 세션 읽기');
  check((await DB.prepare('SELECT count(*) AS n FROM sessions WHERE id = ?1').bind('0'.repeat(64)).first())?.n === 0, '실행: 만료 세션 정리');
  const updated = await updateSessionData(db, key, read, { ...data, refreshToken: 'r2' }, now);
  check(!!updated, '실행: 세션 갱신');
  check((await updateSessionData(db, key, read, { ...data, refreshToken: 'r3' }, now)) === null, '실행: 오래된 암호문으로는 갱신되지 않아야 함');
  await deleteSession(db, read.id);
  check((await readSession(request, db, key, now)).state === 'invalid', '실행: 삭제 뒤 같은 쿠키는 쓸 수 없어야 함');
  engine.flows.push('sessions');
} catch (error) {
  failures.push(`엔진 실행 중 오류: ${String(error?.message || error).slice(0, 300)}`);
} finally {
  await proxy.dispose();
}

const report = {
  runtime: 'local-workerd-d1',
  remoteExecution: false,
  state,
  static: { statements: entries.length, workerStatements: workerSql.length, migrations: migrationNames },
  engine,
  notes,
  failures,
};
await writeFile(join(qa, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (failures.length) {
  console.error('D1_CHECK_FAILED');
  process.exitCode = 1;
} else {
  console.log('D1_CHECK_OK');
}
