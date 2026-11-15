// 로그인 API(CONTRACT 3-2절). 출처·x-site-request·빈도 제한·CSRF 는 app.js 가 라우팅 전에 확인한다.
import { database } from '../db.js';
import { fail, json, readJsonBody } from '../http.js';
import { safeReturnTo } from '../path.js';
import { authSettings, issueSession, rawSession, signedInUser, supabaseFor } from './current.js';
import { deleteSession, expiredSessionCookie, cookieHeaders } from './session.js';
import { socialCallback, startSocial } from './social.js';
import { normalizeEmail, SupabaseError } from './supabase.js';

/** 이메일 시작·확인은 로그인 전 요청이라 CSRF 를 보지 않는다(CONTRACT 2절). */
export const CSRF_EXEMPT_PATHS = new Set(['/api/auth/email/start', '/api/auth/email/verify']);

const ROUTES = {
  '/api/auth/config': { GET: config },
  '/api/auth/me': { GET: me },
  '/api/auth/email/start': { POST: emailStart },
  '/api/auth/email/verify': { POST: emailVerify },
  '/api/auth/social/start': { GET: startSocial },
  '/api/auth/social/callback': { GET: socialCallback },
  '/api/auth/logout': { POST: logout },
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** /api/auth/* 라우팅. 맞는 경로가 아니면 null. */
export async function handleAuth(ctx) {
  const route = ROUTES[ctx.path];
  if (!route) return null;
  const method = ctx.method === 'HEAD' ? 'GET' : ctx.method;
  const handler = route[method];
  if (!handler) fail(405, 'METHOD_NOT_ALLOWED', { headers: { allow: Object.keys(route).join(', ') } });
  return handler(ctx);
}

async function config(ctx) {
  const settings = authSettings(ctx.env);
  return json({ enabled: settings.enabled, methods: settings.enabled ? settings.methods : [] });
}

async function me(ctx) {
  const settings = authSettings(ctx.env);
  if (!settings.enabled) return json({ signedIn: false });
  const user = await signedInUser(ctx);
  if (!user) return json({ signedIn: false });
  const session = await rawSession(ctx);
  return json({ signedIn: true, user: { id: user.id, email: user.email }, csrf: session.csrf });
}

function emailSettings(ctx) {
  const settings = authSettings(ctx.env);
  if (!settings.enabled || !settings.methods.includes('email')) fail(503, 'AUTH_DISABLED');
  return settings;
}

function supabaseFailure(error, rejectedCode) {
  if (!(error instanceof SupabaseError)) throw error;
  if (error.kind === 'rate_limited') fail(429, 'RATE_LIMITED', { retryAfter: error.retryAfter ?? 60 });
  if (error.kind === 'rejected' && rejectedCode) fail(400, rejectedCode);
  console.error('SITE_AUTH_UNAVAILABLE', error.kind);
  fail(503, 'AUTH_UNAVAILABLE');
}

async function emailStart(ctx) {
  const settings = emailSettings(ctx);
  const body = await readJsonBody(ctx.request);
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'email')) fail(400, 'INVALID_EMAIL');
  const email = normalizeEmail(body.email);
  if (!email) fail(400, 'INVALID_EMAIL');
  try {
    await supabaseFor(ctx, settings).sendEmailOtp(email);
  } catch (error) {
    // 거부(가입 막힘 등)도 AUTH_UNAVAILABLE: 주소가 있는지 없는지를 알려 주지 않는다.
    supabaseFailure(error, null);
  }
  return json({ sent: true });
}

async function emailVerify(ctx) {
  const settings = emailSettings(ctx);
  const body = await readJsonBody(ctx.request);
  if (!isPlainObject(body) || Object.keys(body).some((key) => !['email', 'code', 'returnTo'].includes(key))) fail(400, 'INVALID_CODE');
  const email = normalizeEmail(body.email);
  if (!email) fail(400, 'INVALID_EMAIL');
  if (typeof body.code !== 'string' || !/^\d{6,10}$/.test(body.code)) fail(400, 'INVALID_CODE');
  const returnTo = safeReturnTo(body.returnTo);
  let result;
  try {
    result = await supabaseFor(ctx, settings).verifyEmailOtp(email, body.code);
  } catch (error) {
    supabaseFailure(error, 'INVALID_CODE');
  }
  const issued = await issueSession(ctx, settings, result);
  return json({ signedIn: true, returnTo }, 200, cookieHeaders(issued.cookie));
}

async function logout(ctx) {
  let settings = null;
  try {
    settings = authSettings(ctx.env);
  } catch {
    settings = null;
  }
  const session = settings?.enabled ? await rawSession(ctx) : null;
  if (session) {
    // CSRF 는 app.js 가 이미 확인했다(로그인 상태의 상태 변경 요청).
    await deleteSession(database(ctx.env), session.id);
    const revoke = supabaseFor(ctx, settings)
      .logout(session.data.accessToken)
      .catch(() => {});
    ctx.waitUntil(revoke);
  }
  return json({ signedIn: false }, 200, cookieHeaders(expiredSessionCookie()));
}
