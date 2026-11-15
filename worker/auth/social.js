// 소셜 로그인(Supabase 를 중개자로, PKCE). CONTRACT 3-2절.
//   GET /api/auth/social/start?provider=google&returnTo=/경로
//     → code_verifier(무작위 32바이트)·state 를 암호화한 10분짜리 __Host-site-oauth 쿠키에 두고
//       302 {SUPABASE_URL}/auth/v1/authorize?provider&redirect_to={APP_ORIGIN}/api/auth/social/callback?state=…&code_challenge(S256)
//   GET /api/auth/social/callback?code=…&state=…
//     → 쿠키의 state 와 맞으면 /auth/v1/token?grant_type=pkce 로 코드 교환 → /user 확인 → 세션 쿠키 + 302 returnTo
//     → 실패는 언제나 302 /login/?error=SOCIAL_FAILED. Supabase·제공자의 오류 문구와 코드는 되돌려 보내지 않는다(반사 방지).
import { constantTimeEqual, redirect } from '../http.js';
import { safeReturnTo } from '../path.js';
import { authSettings, issueSession, supabaseFor } from './current.js';
import { base64url, decryptJson, encryptJson, randomHex, readCookie } from './session.js';
import { SupabaseError } from './supabase.js';

export const OAUTH_COOKIE = '__Host-site-oauth';
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const SOCIAL_CALLBACK_PATH = '/api/auth/social/callback';
const OAUTH_AAD = 'site-oauth-v1';
const PROVIDER = /^[a-z][a-z0-9_:-]{0,31}$/;

const oauthCookie = (value) => `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_TTL_MS / 1000}`;
export const expiredOauthCookie = () => `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function loginRedirect(code, returnTo, cookies = []) {
  const query = new URLSearchParams({ error: code });
  if (returnTo && returnTo !== '/') query.set('returnTo', returnTo);
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return redirect(`/login/?${query}`, 302, headers);
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** @param {any} ctx 요청 문맥(app.js) */
export async function startSocial(ctx) {
  const params = ctx.url.searchParams;
  const returnTo = safeReturnTo(params.get('returnTo'));
  let settings;
  try {
    settings = authSettings(ctx.env);
  } catch {
    return loginRedirect('AUTH_MISCONFIGURED', returnTo);
  }
  if (!settings.enabled) return loginRedirect('AUTH_DISABLED', returnTo);
  const provider = params.get('provider');
  if (params.getAll('provider').length !== 1 || !PROVIDER.test(provider || '') || provider === 'email' || !settings.methods.includes(provider))
    return loginRedirect('PROVIDER_NOT_ALLOWED', returnTo);
  const { verifier, challenge } = await pkcePair();
  const state = randomHex(32);
  const sealed = await encryptJson(settings.keyBytes, OAUTH_AAD, { v: verifier, s: state, p: provider, r: returnTo, e: ctx.now + OAUTH_TTL_MS });
  const location = supabaseFor(ctx, settings).authorizeUrl({
    provider,
    redirectTo: `${settings.site}${SOCIAL_CALLBACK_PATH}?state=${state}`,
    codeChallenge: challenge,
  });
  return redirect(location, 302, { 'set-cookie': oauthCookie(sealed) });
}

function validFlow(flow, now) {
  return (
    flow &&
    typeof flow.v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(flow.v) &&
    typeof flow.s === 'string' && /^[a-f0-9]{64}$/.test(flow.s) &&
    typeof flow.p === 'string' && PROVIDER.test(flow.p) &&
    typeof flow.r === 'string' &&
    Number.isFinite(flow.e) && flow.e > now
  );
}

/** @param {any} ctx 요청 문맥(app.js) */
export async function socialCallback(ctx) {
  const clear = expiredOauthCookie();
  let settings;
  try {
    settings = authSettings(ctx.env);
  } catch {
    return loginRedirect('SOCIAL_FAILED', '/', [clear]);
  }
  if (!settings.enabled) return loginRedirect('AUTH_DISABLED', '/', [clear]);
  const sealed = readCookie(ctx.request, OAUTH_COOKIE);
  const flow = sealed ? await decryptJson(settings.keyBytes, OAUTH_AAD, sealed) : null;
  if (!validFlow(flow, ctx.now)) return loginRedirect('SOCIAL_FAILED', '/', [clear]);
  const returnTo = safeReturnTo(flow.r);
  const params = ctx.url.searchParams;
  const state = params.getAll('state');
  const code = params.getAll('code');
  if (
    params.has('error') ||
    state.length !== 1 || !constantTimeEqual(state[0], flow.s) ||
    code.length !== 1 || !code[0] || code[0].length > 2048 ||
    !settings.methods.includes(flow.p)
  )
    return loginRedirect('SOCIAL_FAILED', returnTo, [clear]);
  try {
    const result = await supabaseFor(ctx, settings).exchangeCode(code[0], flow.v);
    const issued = await issueSession(ctx, settings, result);
    const headers = new Headers();
    headers.append('set-cookie', clear);
    headers.append('set-cookie', issued.cookie);
    return redirect(returnTo, 302, headers);
  } catch (error) {
    if (!(error instanceof SupabaseError)) throw error;
    console.error('SITE_AUTH_SOCIAL_FAILED', error.kind);
    return loginRedirect('SOCIAL_FAILED', returnTo, [clear]);
  }
}
