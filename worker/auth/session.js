// 로그인 세션 저장소(D1 sessions 표, migrations/0002_sessions.sql).
// - 쿠키 __Host-site-session = 무작위 32바이트(hex 64자). D1 행 id = SHA-256(쿠키). 쿠키 원문은 저장하지 않는다.
// - 행의 data = 세션 내용(사용자·Supabase 토큰)을 SESSION_ENCRYPTION_KEY(32바이트 base64)로 AES-GCM 암호화.
//   추가 인증 데이터에 행 id 를 넣어 다른 행으로 옮긴 암호문은 풀리지 않는다. 토큰은 브라우저로 나가지 않는다.
// - 7일 절대 만료. 로그아웃 = 행 삭제(같은 쿠키를 다시 보내도 행이 없어 로그인 상태가 아니다).
import { NO_STORE } from '../http.js';

export const SESSION_COOKIE = '__Host-site-session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_AAD = 'site-session-v1:';

export const SESSION_INSERT_SQL =
  'INSERT INTO sessions (id, data, csrf, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)';
export const SESSION_SELECT_SQL =
  'SELECT id, data, csrf, created_at, expires_at FROM sessions WHERE id = ?1 AND expires_at > ?2';
// 토큰 갱신: 읽었던 암호문과 같을 때만 바꾼다(동시에 두 요청이 갱신하면 하나만 쓰인다).
export const SESSION_UPDATE_SQL = 'UPDATE sessions SET data = ?1 WHERE id = ?2 AND data = ?3 AND expires_at > ?4';
export const SESSION_DELETE_SQL = 'DELETE FROM sessions WHERE id = ?1';
// 만료 정리는 한 번에 100행까지(로그인할 때 함께 돈다).
export const SESSION_CLEANUP_SQL =
  'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at <= ?1 LIMIT 100)';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export const randomHex = (size = 32) => hex(crypto.getRandomValues(new Uint8Array(size)));

export function base64url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64(text) {
  const normalized = String(text).replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function sha256Hex(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** SESSION_ENCRYPTION_KEY → 32바이트. 형식이 틀리면 null(호출하는 쪽이 503 AUTH_MISCONFIGURED). */
export function sessionKeyBytes(env) {
  const value = env?.SESSION_ENCRYPTION_KEY;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(value.trim())) return null;
  try {
    const bytes = fromBase64(value.trim());
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

const keyCache = new Map();
async function aesKey(keyBytes) {
  const id = hex(keyBytes);
  let key = keyCache.get(id);
  if (!key) {
    key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(id, key);
  }
  return key;
}

/** JSON 값을 'v1.<iv>.<암호문>'(base64url)으로. */
export async function encryptJson(keyBytes, aad, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    await aesKey(keyBytes),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64url(iv)}.${base64url(data)}`;
}

/** encryptJson 의 반대. 변조·다른 키·다른 aad 면 null. */
export async function decryptJson(keyBytes, aad, text) {
  try {
    const [version, iv, data, ...rest] = String(text).split('.');
    if (version !== 'v1' || rest.length || !/^[A-Za-z0-9_-]{16}$/.test(iv) || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(aad) },
      await aesKey(keyBytes),
      fromBase64(data),
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}

/** 이 이름의 쿠키가 정확히 하나일 때만 값을, 아니면 null. */
export function readCookie(request, name) {
  const values = (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : null;
}

export function sessionCookie(raw, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
export function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * 새 세션 행을 만든다. 만료된 행 정리도 함께.
 * @param {ReturnType<import('../db.js').database>} db
 * @param {Uint8Array} keyBytes
 * @param {{userId: string, email: string, provider: string, accessToken: string, refreshToken: string, accessExpiresAt: number}} data
 * @param {number} now ms
 */
export async function createSession(db, keyBytes, data, now) {
  const raw = randomHex(32);
  const id = await sha256Hex(raw);
  const csrf = randomHex(32);
  const ciphertext = await encryptJson(keyBytes, SESSION_AAD + id, data);
  await db.batch([
    db.statement(SESSION_CLEANUP_SQL, now),
    db.statement(SESSION_INSERT_SQL, id, ciphertext, csrf, now, now + SESSION_TTL_MS),
  ]);
  return { id, csrf, cookie: sessionCookie(raw), data, ciphertext, expiresAt: now + SESSION_TTL_MS };
}

/**
 * 요청의 세션 쿠키 → 행. 갱신·외부 호출은 하지 않는다.
 * @returns {Promise<{state: 'none'} | {state: 'invalid'} | {state: 'ok', id: string, csrf: string, data: any, ciphertext: string, expiresAt: number}>}
 *   invalid = 쿠키는 있는데 쓸 수 없음(행 없음·만료·풀리지 않음). 응답에서 쿠키를 지운다.
 */
export async function readSession(request, db, keyBytes, now) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (raw === null) return (request.headers.get('cookie') || '').includes(`${SESSION_COOKIE}=`) ? { state: 'invalid' } : { state: 'none' };
  if (!/^[a-f0-9]{64}$/.test(raw)) return { state: 'invalid' };
  const id = await sha256Hex(raw);
  const row = await db.first(SESSION_SELECT_SQL, id, now);
  if (!row) return { state: 'invalid' };
  const data = await decryptJson(keyBytes, SESSION_AAD + id, row.data);
  if (!data || typeof data.userId !== 'string') {
    // 키를 바꿨거나 행이 깨졌다: 7일 동안 401 이 이어지지 않게 행을 지운다(HttpOnly 쿠키는 화면이 못 지운다).
    await db.run(SESSION_DELETE_SQL, id);
    return { state: 'invalid' };
  }
  return { state: 'ok', id, csrf: row.csrf, data, ciphertext: row.data, expiresAt: row.expires_at };
}

/**
 * 토큰을 바꾼 세션 내용 저장. 다른 요청이 먼저 바꿨으면 false.
 */
export async function updateSessionData(db, keyBytes, session, data, now) {
  const ciphertext = await encryptJson(keyBytes, SESSION_AAD + session.id, data);
  const result = await db.run(SESSION_UPDATE_SQL, ciphertext, session.id, session.ciphertext, now);
  return (result?.meta?.changes ?? 0) > 0 ? { ...session, data, ciphertext } : null;
}

export async function deleteSession(db, id) {
  await db.run(SESSION_DELETE_SQL, id);
}

/** 세션 쿠키를 바꾸거나 지우는 응답 머리말 도우미. */
export function cookieHeaders(...cookies) {
  const headers = new Headers({ 'cache-control': NO_STORE });
  for (const cookie of cookies) if (cookie) headers.append('set-cookie', cookie);
  return headers;
}
