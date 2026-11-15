// 견본 항목 API: 언어 대체·상태 계산·정렬·상세·404·D1 장애(CONTRACT 3-1절).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedItems } from '../scripts/seed-local.mjs';
import { CLOSING_WINDOW_MS, formatKst, itemStatus } from '../worker/items.js';
import { createFakeD1 } from './helpers/fake-d1.js';
import { FIXED_NOW, makeEnv, seededD1, send } from './helpers/worker-env.js';

const TODAY = '2026-11-14'; // FIXED_NOW 의 KST 날짜

async function items(env, query = '') {
  const response = await send(env, `/api/items${query}`);
  assert.equal(response.status, 200);
  return (await response.json()).items;
}

describe('상태 계산', () => {
  it('마감 지남 closed, 7일 이내 closing, 그 밖 open', () => {
    assert.equal(itemStatus(formatKst(FIXED_NOW - 1000), FIXED_NOW), 'closed');
    assert.equal(itemStatus(formatKst(FIXED_NOW), FIXED_NOW), 'closed');
    assert.equal(itemStatus(formatKst(FIXED_NOW + 1000), FIXED_NOW), 'closing');
    assert.equal(itemStatus(formatKst(FIXED_NOW + CLOSING_WINDOW_MS), FIXED_NOW), 'closing');
    assert.equal(itemStatus(formatKst(FIXED_NOW + CLOSING_WINDOW_MS + 1000), FIXED_NOW), 'open');
    assert.equal(itemStatus('not a date', FIXED_NOW), 'closed');
  });
  it('formatKst 는 +09:00 고정 길이', () => {
    assert.equal(formatKst(Date.parse('2026-11-14T03:00:00Z')), '2026-11-14T12:00:00+09:00');
  });
});

describe('GET /api/items', () => {
  it('시드 6개: open 3·closing 1·closed 2, 진행 중을 마감 가까운 순 → 마감된 것을 최근 순', async () => {
    const list = await items(makeEnv({ DB: seededD1(TODAY) }));
    assert.equal(list.length, 6);
    const expected = Object.fromEntries(seedItems(TODAY).map((item) => [item.id, item.expected]));
    for (const item of list) assert.equal(item.status, expected[item.id], item.id);
    assert.deepEqual(list.map((item) => item.id), [
      'sample-cooking-class', // closing, +3일
      'sample-city-walk', // open, +21일
      'sample-community-workshop', // open, +30일
      'sample-photo-exhibit', // open, 마감 없음 → 끝나는 날 +60일
      'sample-book-club', // closed, -5일
      'sample-music-night', // closed, -40일
    ]);
  });

  it('Item 모양(CONTRACT)과 값', async () => {
    const [first] = await items(makeEnv({ DB: seededD1(TODAY) }));
    assert.deepEqual(Object.keys(first).sort(), ['accent', 'deadline', 'endsOn', 'id', 'image', 'place', 'startsOn', 'status', 'summary', 'title'].sort());
    assert.equal(first.title, '주말 요리 교실');
    assert.equal(first.accent, 'coral');
    assert.equal(first.image, '/samples/poster-4.svg');
    assert.match(first.deadline, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    assert.match(first.startsOn, /^\d{4}-\d{2}-\d{2}$/);
    const list = await items(makeEnv({ DB: seededD1(TODAY) }));
    assert.equal(list.find((item) => item.id === 'sample-photo-exhibit').deadline, null);
    assert.deepEqual(new Set(list.map((item) => item.accent)), new Set(['blue', 'aqua', 'lavender', 'coral', 'slate', 'yellow']));
    assert.equal(list.filter((item) => item.image === null).length, 2);
  });

  it('lang=ja·en 은 그 언어, 없거나 모르는 값은 ko', async () => {
    const env = makeEnv({ DB: seededD1(TODAY) });
    const title = async (query) => (await items(env, query)).find((item) => item.id === 'sample-city-walk').title;
    assert.equal(await title('?lang=ja'), '街歩きの会');
    assert.equal(await title('?lang=en'), 'City Walking Meetup');
    assert.equal(await title(''), '도심 걷기 모임');
    assert.equal(await title('?lang=fr'), '도심 걷기 모임');
    assert.equal(await title('?lang=JA'), '도심 걷기 모임');
  });

  it('그 언어 글이 없거나 칸이 비어 있으면 ko 로 채운다', async () => {
    const d1 = seededD1(TODAY);
    d1.sqlite.exec("DELETE FROM item_texts WHERE item_id = 'sample-city-walk' AND locale = 'ja'");
    d1.sqlite.exec("UPDATE item_texts SET summary = '' WHERE item_id = 'sample-music-night' AND locale = 'ja'");
    const list = await items(makeEnv({ DB: d1 }), '?lang=ja');
    const walk = list.find((item) => item.id === 'sample-city-walk');
    assert.equal(walk.title, '도심 걷기 모임');
    const night = list.find((item) => item.id === 'sample-music-night');
    assert.equal(night.title, '小さな音楽会');
    assert.equal(night.summary, '동네 연주자들이 꾸민 저녁 음악회였습니다.');
  });

  it('ko 글이 없는 항목은 나오지 않는다', async () => {
    const d1 = seededD1(TODAY);
    d1.sqlite.exec("DELETE FROM item_texts WHERE item_id = 'sample-city-walk' AND locale = 'ko'");
    assert.equal((await items(makeEnv({ DB: d1 }))).some((item) => item.id === 'sample-city-walk'), false);
  });

  it('빈 표는 빈 목록', async () => {
    assert.deepEqual(await items(makeEnv({ DB: createFakeD1() })), []);
  });

  it('같은 출처가 아닌 그림 경로는 null 로 내보낸다', async () => {
    const d1 = seededD1(TODAY);
    d1.sqlite.exec("UPDATE items SET image = '//evil.example/x.png' WHERE id = 'sample-city-walk'");
    assert.equal((await items(makeEnv({ DB: d1 }))).find((item) => item.id === 'sample-city-walk').image, null);
  });
});

describe('GET /api/items/<id>', () => {
  it('상세는 body·link 를 더한다(본문 문자열은 그대로, 이스케이프는 화면 몫)', async () => {
    const response = await send(makeEnv({ DB: seededD1(TODAY) }), '/api/items/sample-community-workshop?lang=en');
    assert.equal(response.status, 200);
    const { item } = await response.json();
    assert.equal(item.title, 'Neighborhood Writing Workshop');
    assert.equal(item.link, 'https://example.com/workshop');
    assert.equal(item.status, 'open');
    assert.ok(item.body.includes('## What to bring'));
    assert.ok(item.body.includes('- Something to write with'));
    assert.ok(item.body.includes('<script>alert("x")</script>'));
    assert.deepEqual(Object.keys(item).sort(), ['accent', 'body', 'deadline', 'endsOn', 'id', 'image', 'link', 'place', 'startsOn', 'status', 'summary', 'title'].sort());
  });

  it('언어 대체(상세 본문)', async () => {
    const d1 = seededD1(TODAY);
    d1.sqlite.exec("UPDATE item_texts SET body = '' WHERE item_id = 'sample-cooking-class' AND locale = 'ja'");
    const { item } = await (await send(makeEnv({ DB: d1 }), '/api/items/sample-cooking-class?lang=ja')).json();
    assert.equal(item.title, '週末料理教室');
    assert.ok(item.body.startsWith('재료는 준비되어 있습니다.'));
    assert.equal(item.status, 'closing');
  });

  it('link 가 javascript: 면 null', async () => {
    const d1 = seededD1(TODAY);
    d1.sqlite.exec("UPDATE items SET link = 'javascript:alert(1)' WHERE id = 'sample-city-walk'");
    assert.equal((await (await send(makeEnv({ DB: d1 }), '/api/items/sample-city-walk')).json()).item.link, null);
  });

  it('없는 id 는 404 NOT_FOUND', async () => {
    const response = await send(makeEnv({ DB: seededD1(TODAY) }), '/api/items/nope');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
  });

  it('형식이 틀린 id 는 DB 에 묻지 않고 404', async () => {
    const d1 = seededD1(TODAY);
    for (const id of ['-x', 'a_b', `${'a'.repeat(65)}`, "x'or'1", '%E0%A4%A']) {
      const response = await send(makeEnv({ DB: d1 }), `/api/items/${id}`);
      assert.equal(response.status, 404, id);
    }
    assert.equal(d1.log.length, 0);
  });

  it('대문자 경로도 같은 항목(경로는 정규화한다)', async () => {
    assert.equal((await send(makeEnv({ DB: seededD1(TODAY) }), '/API/ITEMS/SAMPLE-CITY-WALK')).status, 200);
  });

  it('GET·HEAD 말고는 405', async () => {
    const response = await send(makeEnv({ DB: seededD1(TODAY) }), '/api/items', { method: 'POST', headers: { origin: 'https://site.example', 'x-site-request': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: 'METHOD_NOT_ALLOWED' });
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

describe('D1 장애·바인딩 없음', () => {
  it('DB 바인딩이 없으면 503 SERVICE_UNAVAILABLE', async () => {
    const env = makeEnv();
    delete env.DB;
    const response = await send(env, '/api/items');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
  });
  it('D1 오류는 503, 로그에 SQL·값을 남기지 않는다', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const env = makeEnv({ DB: seededD1(TODAY, { failWhen: (sql) => sql.includes('FROM items') }) });
      const response = await send(env, '/api/items?lang=ja');
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
    } finally {
      console.error = original;
    }
    assert.deepEqual(logged, ['SITE_ERROR api/items Error']);
  });
});
