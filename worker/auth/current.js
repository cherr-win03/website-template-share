// 로그인 설정 읽기와 "지금 요청한 사람" 판단(요청마다 한 번, ctx.cache 에 기억).
// - 로그인 판단은 D1 세션 행 기준이다. 요청마다 Supabase 를 부르지 않는다(이유: docs/AUTH.md "설계 선택").
// - 액세스 토큰이 만료(60초 여유)됐으면 refresh 로 갱신하고 /user 로 같은 사람인지 다시 확인한다.
//   갱신이 거부되면 행을 지우고 로그아웃 상태, Supabase 에 닿지 못하면(일시 장애) 행은 두고 이번 요청만 로그인 안 한 것으로 본다(닫힌 쪽).
import { database } from '../db.js';
import { fail } from '../http.js';
import { appOrigin } from '../origin.js';
import { authEnabled } from '../switches.js';
import {
  createSession,
  deleteSession,
  expiredSessionCookie,
  readSession,
  sessionKeyBytes,
  updateSessionData,
} from './session.js';
import { createSupabaseAuth, publishableKey, supabaseOrigin, SupabaseError } from './supabase.js';

const METHOD_NAME = /^[a-z][a-z0-9_:-]{0,31}$/;
const REFRESH_MARGIN_MS = 60_000;

/** AUTH_METHODS → ['email','google',…]. 이름 형식이 틀리면 503 AUTH_MISCONFIGURED. */
export function parseMethods(value) {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.some((name) => !METHOD_NAME.test(name))) fail(503, 'AUTH_MISCONFIGURED');
  return [...new Set(names)];
}

/**
 * 로그인 설정. 꺼져 있으면 {enabled:false}. 켜져 있는데 필요한 값이 틀리면 503 AUTH_MISCONFIGURED.
 * (AUTH_ACTIVATION 이 알 수 없는 값이어도 503 AUTH_MISCONFIGURED.)
 */
export function authSettings(env) {
  if (!authEnabled(env)) return { enabled: false, methods: [] };
  const methods = parseMethods(env.AUTH_METHODS);
  const site = appOrigin(env);
  const url = site ? supabaseOrigin(env.SUPABASE_URL, site) : null;
  const key = publishableKey(env.SUPABASE_PUBLISHABLE_KEY);
  const keyBytes = sessionKeyBytes(env);
  if (!methods.length || !site || !url || !key || !keyBytes || !env.DB) fail(503, 'AUTH_MISCONFIGURED');
  return { enabled: true, methods, site, url, key, keyBytes };
}

/** 설정이 틀리면 null(차단·CSRF 판단에서 "로그인 안 함"으로 보아 닫는다). */
function settingsOrNull(env) {
  try {
    const settings = authSettings(env);
    return settings.enabled ? settings : null;
  } catch {
    return null;
  }
}

export function supabaseFor(ctx, settings) {
  return createSupabaseAuth({ url: settings.url, key: settings.key, fetchImpl: ctx.fetchImpl, now: () => ctx.now });
}

/** 쿠키 → 세션 행(갱신 없음). 없거나 쓸 수 없으면 null. */
export async function rawSession(ctx) {
  if (ctx.cache.rawSession !== undefined) return ctx.cache.rawSession;
  const settings = settingsOrNull(ctx.env);
  let session = null;
  if (settings) {
    const result = await readSession(ctx.request, database(ctx.env), settings.keyBytes, ctx.now);
    if (result.state === 'invalid') ctx.setCookies.push(expiredSessionCookie());
    if (result.state === 'ok') session = result;
  }
  ctx.cache.rawSession = session;
  return session;
}

const userOf = (session) => ({ id: session.data.userId, email: session.data.email ?? '', provider: session.data.provider ?? 'email' });
const fresh = (session, now) => Number.isFinite(session?.data?.accessExpiresAt) && session.data.accessExpiresAt * 1000 > now + REFRESH_MARGIN_MS;

/**
 * 로그인한 사용자 {id, email, provider} 또는 null. 토큰 갱신까지 한다.
 * @param {any} ctx 요청 문맥(app.js)
 */
export async function signedInUser(ctx) {
  if (ctx.cache.user !== undefined) return ctx.cache.user;
  ctx.cache.user = await resolveUser(ctx);
  return ctx.cache.user;
}

async function resolveUser(ctx) {
  const session = await rawSession(ctx);
  if (!session) return null;
  if (fresh(session, ctx.now)) return userOf(session);
  const settings = authSettings(ctx.env);
  const db = database(ctx.env);
  try {
    const renewed = await supabaseFor(ctx, settings).refresh(session.data.refreshToken, session.data.userId);
    const data = {
      ...session.data,
      email: renewed.user.email,
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken,
      accessExpiresAt: renewed.accessExpiresAt,
    };
    const saved = await updateSessionData(db, settings.keyBytes, session, data, ctx.now);
    const current = saved ?? (await latestIfRefreshed(ctx, db, settings, session));
    ctx.cache.rawSession = current;
    return current ? userOf(current) : null;
  } catch (error) {
    if (!(error instanceof SupabaseError)) throw error;
    if (error.kind === 'unavailable' || error.kind === 'rate_limited') {
      console.error('SITE_AUTH_REFRESH_UNAVAILABLE', error.kind);
      return null;
    }
    // 거부: 다른 요청이 같은 리프레시 토큰으로 먼저 갱신했을 수 있다. 행이 새 토큰으로 바뀌었으면 그것을 쓴다.
    const latest = await latestIfRefreshed(ctx, db, settings, session);
    if (latest) {
      ctx.cache.rawSession = latest;
      return userOf(latest);
    }
    await deleteSession(db, session.id);
    ctx.setCookies.push(expiredSessionCookie());
    ctx.cache.rawSession = null;
    return null;
  }
}

async function latestIfRefreshed(ctx, db, settings, before) {
  const latest = await readSession(ctx.request, db, settings.keyBytes, ctx.now);
  return latest.state === 'ok' && latest.ciphertext !== before.ciphertext && fresh(latest, ctx.now) ? latest : null;
}

/**
 * Supabase 로그인 결과로 새 세션을 만든다. 같은 브라우저의 이전 세션 행은 지운다(세션 고정 방지).
 * @returns {Promise<{cookie: string, csrf: string, user: {id: string, email: string}}>}
 */
export async function issueSession(ctx, settings, result) {
  const db = database(ctx.env);
  const previous = await rawSession(ctx);
  if (previous) await deleteSession(db, previous.id);
  const created = await createSession(
    db,
    settings.keyBytes,
    {
      userId: result.user.id,
      email: result.user.email,
      provider: result.user.provider,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresAt: result.accessExpiresAt,
    },
    ctx.now,
  );
  ctx.cache.rawSession = { state: 'ok', ...created };
  ctx.cache.user = { id: result.user.id, email: result.user.email, provider: result.user.provider };
  return { cookie: created.cookie, csrf: created.csrf, user: ctx.cache.user };
}
