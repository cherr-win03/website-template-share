// 견본 API: GET /api/items, GET /api/items/<id> (CONTRACT 3-1절).
// - lang 이 없거나 모르는 값이면 ko. 해당 언어 글(또는 그 칸)이 비어 있으면 ko 글로 채운다(LEFT JOIN + COALESCE).
// - 상태는 서버가 계산한다: 마감이 지났으면 closed, 7일 이내면 closing, 그 밖 open.
//   마감(deadline)이 없는 항목은 끝나는 날 23:59:59(+09:00)를 마감으로 본다(CONTRACT 에 정해지지 않은 부분, docs/D1_RULES.md).
// - compound SELECT(UNION 등)를 쓰지 않는다: D1 은 5항까지라 언어 수가 늘면 깨진다.
import { database } from './db.js';
import { fail, json } from './http.js';

export const LOCALES = Object.freeze(['ko', 'ja', 'en']);
export const ACCENTS = Object.freeze(['blue', 'aqua', 'lavender', 'coral', 'slate', 'yellow']);
export const CLOSING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const LIST_LIMIT = 200; // ITEM_LIST_SQL 의 LIMIT 과 같은 값(SQL 은 ${} 없이 상수로 쓴다)
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ITEM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// ?1 = 언어, ?2 = 지금(KST 문자열). 정렬: 진행 중(open·closing)을 마감 가까운 순, 그다음 마감된 것을 최근 순.
export const ITEM_LIST_SQL = `SELECT i.id AS id, i.accent AS accent, i.image AS image,
  i.starts_on AS starts_on, i.ends_on AS ends_on, i.deadline AS deadline, i.effective_deadline AS effective_deadline,
  COALESCE(NULLIF(t.title, ''), k.title) AS title,
  COALESCE(NULLIF(t.summary, ''), k.summary) AS summary,
  COALESCE(NULLIF(t.place, ''), k.place) AS place
FROM (
  SELECT id, accent, image, starts_on, ends_on, deadline,
    COALESCE(deadline, ends_on || 'T23:59:59+09:00') AS effective_deadline
  FROM items
) AS i
JOIN item_texts AS k ON k.item_id = i.id AND k.locale = 'ko'
LEFT JOIN item_texts AS t ON t.item_id = i.id AND t.locale = ?1
ORDER BY CASE WHEN i.effective_deadline > ?2 THEN 0 ELSE 1 END,
  CASE WHEN i.effective_deadline > ?2 THEN i.effective_deadline END ASC,
  i.effective_deadline DESC,
  i.id ASC
LIMIT 200`;

// ?1 = 언어, ?2 = 항목 id.
export const ITEM_DETAIL_SQL = `SELECT i.id AS id, i.accent AS accent, i.image AS image, i.link AS link,
  i.starts_on AS starts_on, i.ends_on AS ends_on, i.deadline AS deadline,
  COALESCE(i.deadline, i.ends_on || 'T23:59:59+09:00') AS effective_deadline,
  COALESCE(NULLIF(t.title, ''), k.title) AS title,
  COALESCE(NULLIF(t.summary, ''), k.summary) AS summary,
  COALESCE(NULLIF(t.place, ''), k.place) AS place,
  COALESCE(NULLIF(t.body, ''), k.body) AS body
FROM items AS i
JOIN item_texts AS k ON k.item_id = i.id AND k.locale = 'ko'
LEFT JOIN item_texts AS t ON t.item_id = i.id AND t.locale = ?1
WHERE i.id = ?2`;

/** lang 질의값 → 지원 언어(모르면 ko). */
export function pickLocale(value) {
  return LOCALES.includes(value) ? value : 'ko';
}

/** ms → 'YYYY-MM-DDTHH:mm:ss+09:00' */
export function formatKst(ms) {
  return `${new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

/**
 * @param {string} effectiveDeadline 'YYYY-MM-DDTHH:mm:ss+09:00'
 * @param {number} now ms
 * @returns {'open'|'closing'|'closed'}
 */
export function itemStatus(effectiveDeadline, now) {
  const at = Date.parse(effectiveDeadline);
  if (!Number.isFinite(at)) return 'closed';
  if (at <= now) return 'closed';
  return at - now <= CLOSING_WINDOW_MS ? 'closing' : 'open';
}

/** 같은 출처 경로만(예: /samples/poster-1.svg). 그 밖은 null. */
function sameOriginPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null;
}
/** http(s) 주소 또는 같은 출처 경로만. javascript: 등은 null. */
function safeLink(value) {
  if (typeof value !== 'string' || !value) return null;
  if (sameOriginPath(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function toItem(row, now) {
  return {
    id: row.id,
    status: itemStatus(row.effective_deadline, now),
    title: row.title ?? '',
    summary: row.summary ?? '',
    place: row.place ?? '',
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    deadline: row.deadline ?? null,
    accent: ACCENTS.includes(row.accent) ? row.accent : 'blue',
    image: sameOriginPath(row.image),
  };
}

/** @param {Record<string, any>} env @param {string} lang @param {number} now */
export async function listItems(env, lang, now) {
  const rows = await database(env).all(ITEM_LIST_SQL, pickLocale(lang), formatKst(now));
  return rows.map((row) => toItem(row, now));
}

/** @returns {Promise<object | null>} */
export async function getItem(env, id, lang, now) {
  if (typeof id !== 'string' || !ITEM_ID.test(id)) return null;
  const row = await database(env).first(ITEM_DETAIL_SQL, pickLocale(lang), id);
  if (!row) return null;
  return { ...toItem(row, now), body: row.body ?? '', link: safeLink(row.link) };
}

/**
 * /api/items 라우팅. path 는 정규화 경로. 맞는 경로가 아니면 null.
 * @param {{path: string, method: string, url: URL, env: Record<string, any>, now: number}} context
 */
export async function handleItems({ path, method, url, env, now }) {
  const match = /^\/api\/items(?:\/([^/]+))?$/.exec(path);
  if (!match) return null;
  if (method !== 'GET' && method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', { headers: { allow: 'GET, HEAD' } });
  const lang = url.searchParams.get('lang');
  if (match[1] === undefined) return json({ items: await listItems(env, lang, now) });
  const item = await getItem(env, match[1], lang, now);
  if (!item) fail(404, 'NOT_FOUND');
  return json({ item });
}
