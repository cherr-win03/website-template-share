// Supabase Auth(GoTrue) REST 연결. 서버에서만 쓴다. fetch 는 주입할 수 있다(시험·가짜 Supabase).
// 부르는 곳: POST /auth/v1/otp, POST /auth/v1/verify, POST /auth/v1/token?grant_type=pkce|refresh_token,
//           GET /auth/v1/user, POST /auth/v1/logout?scope=local, 브라우저 이동용 GET /auth/v1/authorize.
// - 공개 키(publishable/anon)만 받는다. sb_secret_… 과 service_role JWT 는 거부한다(서버에 관리자 키를 두지 않는다).
// - 리다이렉트를 따라가지 않는다(redirect: 'manual'), 응답은 64KiB 까지, 시간 제한 5초(메일 보내는 /otp 는 10초).
// - Supabase 의 오류 문구·코드를 화면이나 로그로 넘기지 않는다. 호출하는 쪽은 SupabaseError.kind 만 본다.

export class SupabaseError extends Error {
  /**
   * @param {'rate_limited'|'unavailable'|'rejected'|'invalid_response'} kind
   * @param {{retryAfter?: number}} [extra]
   */
  constructor(kind, extra = {}) {
    super(kind);
    this.name = 'SupabaseError';
    this.kind = kind;
    this.retryAfter = extra.retryAfter;
  }
}

const EMAIL = /^[^\s@<>"'\\]+@[^\s@<>"'\\]+\.[^\s@<>"'\\]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const RESPONSE_LIMIT = 65536;

/** 이메일 정규화. 틀리면 null. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !EMAIL.test(email)) return null;
  return email;
}

/**
 * SUPABASE_URL 검사. https(사용자 도메인 포함) 또는 로컬 가짜 Supabase 용 http 루프백(사이트도 루프백일 때만).
 * @returns {string | null} origin
 */
export function supabaseOrigin(value, siteOrigin) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    try {
      return LOOPBACK.has(new URL(siteOrigin).hostname) ? url.origin : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** SUPABASE_PUBLISHABLE_KEY 검사. 비밀 키(sb_secret_…, service_role JWT)는 거부. */
export function publishableKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key || key.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(key)) return null;
  if (key.startsWith('sb_secret_')) return null;
  const parts = key.split('.');
  if (parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    try {
      const payload = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')));
      if (payload?.role === 'service_role') return null;
    } catch {
      // JWT 모양이지만 읽을 수 없는 키는 그대로 둔다(Supabase 가 거부한다).
    }
  }
  return key;
}

function token(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value))
    throw new SupabaseError('invalid_response');
  return value;
}

async function smallJson(response) {
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel().catch(() => {});
      throw new SupabaseError('invalid_response');
    }
    chunks.push(value);
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SupabaseError('invalid_response');
  }
}

function retrySeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 60;
}

/** /user 응답 → {id, email, provider}. 확인된 사용자(aud=authenticated, 익명 아님)만. */
export function userFields(user) {
  if (!user || typeof user !== 'object' || typeof user.id !== 'string' || !UUID.test(user.id) || user.aud !== 'authenticated' || user.is_anonymous === true)
    throw new SupabaseError('invalid_response');
  const provider = typeof user.app_metadata?.provider === 'string' && /^[a-z][a-z0-9_:-]{0,31}$/.test(user.app_metadata.provider) ? user.app_metadata.provider : 'email';
  return { id: user.id.toLowerCase(), email: normalizeEmail(user.email) ?? '', provider };
}

/**
 * @param {{url: string, key: string, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number, mailTimeoutMs?: number}} options
 */
export function createSupabaseAuth({ url, key, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, mailTimeoutMs = 10000 }) {
  const origin = url;

  async function request(path, { method = 'POST', payload, accessToken, mail = false } = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${origin}/auth/v1${path}`, {
            method,
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              apikey: key,
              'content-type': 'application/json',
              ...(accessToken ? { authorization: `Bearer ${token(accessToken)}` } : {}),
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          if (response.status >= 300 && response.status < 400) throw new SupabaseError('unavailable');
          if (response.status === 429) throw new SupabaseError('rate_limited', { retryAfter: retrySeconds(response.headers.get('retry-after')) });
          if (response.status >= 500) throw new SupabaseError('unavailable');
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new SupabaseError('rejected');
          }
          return smallJson(response);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new SupabaseError('unavailable'));
          }, mail ? mailTimeoutMs : timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof SupabaseError) throw error;
      // 연결 실패·시간 초과. 예외 문구에는 주소·본문이 들어 있을 수 있어 넘기지 않는다.
      throw new SupabaseError('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function getUser(accessToken) {
    return userFields(await request('/user', { method: 'GET', accessToken }));
  }

  /** 토큰 응답 검사 + /user 로 신원 재확인. expected 가 있으면 같은 사람이어야 한다. */
  async function session(data, expected = {}) {
    if (!data || typeof data !== 'object' || String(data.token_type).toLowerCase() !== 'bearer') throw new SupabaseError('invalid_response');
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86400) throw new SupabaseError('invalid_response');
    const accessToken = token(data.access_token);
    const refreshToken = token(data.refresh_token);
    const issued = userFields(data.user);
    const nowSeconds = Math.floor(now() / 1000);
    let accessExpiresAt = nowSeconds + Math.floor(expiresIn);
    if (data.expires_at !== undefined) {
      const at = Number(data.expires_at);
      if (!Number.isFinite(at) || at <= nowSeconds) throw new SupabaseError('invalid_response');
      accessExpiresAt = Math.min(accessExpiresAt, Math.floor(at));
    }
    const checked = await getUser(accessToken);
    if (checked.id !== issued.id || checked.email !== issued.email) throw new SupabaseError('invalid_response');
    if (expected.userId && checked.id !== expected.userId) throw new SupabaseError('invalid_response');
    if (expected.email && checked.email !== expected.email) throw new SupabaseError('invalid_response');
    return { accessToken, refreshToken, accessExpiresAt, user: checked };
  }

  return Object.freeze({
    origin,
    /** 이메일로 로그인 코드 보내기(없는 주소면 Supabase 설정에 따라 새 사용자). 성공은 "받았다"일 뿐 배달 증명이 아니다. */
    async sendEmailOtp(email) {
      await request('/otp', { payload: { email, create_user: true }, mail: true });
    },
    async verifyEmailOtp(email, code) {
      return session(await request('/verify', { payload: { type: 'email', email, token: code } }), { email });
    },
    /** 소셜 로그인 뒤 PKCE 코드 교환. */
    async exchangeCode(authCode, codeVerifier) {
      return session(await request('/token?grant_type=pkce', { payload: { auth_code: token(authCode), code_verifier: codeVerifier } }));
    },
    async refresh(refreshToken, expectedUserId) {
      return session(await request('/token?grant_type=refresh_token', { payload: { refresh_token: token(refreshToken) } }), { userId: expectedUserId });
    },
    getUser,
    /** 이 세션의 리프레시 토큰을 끝낸다(이미 발급된 액세스 토큰은 만료까지 남을 수 있다). */
    async logout(accessToken) {
      await request('/logout?scope=local', { accessToken });
    },
    /** 브라우저를 보낼 Supabase 로그인 주소(PKCE). */
    authorizeUrl({ provider, redirectTo, codeChallenge }) {
      const target = new URL(`${origin}/auth/v1/authorize`);
      target.searchParams.set('provider', provider);
      target.searchParams.set('redirect_to', redirectTo);
      target.searchParams.set('code_challenge', codeChallenge);
      target.searchParams.set('code_challenge_method', 's256');
      return target.href;
    },
  });
}
