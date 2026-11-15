// 로컬 시험용 가짜 Supabase Auth(GoTrue). 실제 서비스·계정·비밀값 없이 로그인 흐름을 끝까지 돌려 본다.
//   node scripts/fake-supabase.mjs                      → http://127.0.0.1:54321
//   node scripts/fake-supabase.mjs --access-ttl=20      → 액세스 토큰 20초(갱신 시험용)
//   .dev.vars: AUTH_ACTIVATION=enabled, SUPABASE_URL=http://127.0.0.1:54321 (APP_ORIGIN 도 http://127.0.0.1:<포트>)
// 흉내 내는 끝점(요청·응답 모양은 GoTrue API 에 맞춤):
//   POST /auth/v1/otp                          아무 이메일 → 200 {}
//   POST /auth/v1/verify {type:'email',email,token}  코드 "123456" 만 성공 → 세션, 그 밖 403 otp_expired
//   GET  /auth/v1/authorize?provider&redirect_to&code_challenge&code_challenge_method=s256
//                                              → 제공자 화면 없이 곧바로 302 redirect_to?code=…
//   POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier}      → 세션(+ provider_token)
//   POST /auth/v1/token?grant_type=refresh_token {refresh_token}        → 새 세션(리프레시 토큰 교체, 10초 재사용 허용)
//   GET  /auth/v1/user (Bearer)                → 사용자
//   POST /auth/v1/logout?scope=local (Bearer)  → 204, 그 세션의 리프레시 토큰 폐기
// 토큰은 JWT 모양(HS256, 가짜 키)이고 서명·만료·세션 폐기를 확인한다. 모든 요청에 apikey 머리말이 있어야 한다.
// 시험(node --test)은 createFakeSupabase().fetch 를 Worker 의 fetch 대신 넣어 포트 없이 쓴다.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const encoder = new TextEncoder();
const FAKE_SECRET = 'fake-supabase-local-only-signing-key';
const EMAIL = /^[^\s@<>"'\\]+@[^\s@<>"'\\]+\.[^\s@<>"'\\]+$/u;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const randomHex = (size = 16) => Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString('hex');
const iso = (ms) => new Date(ms).toISOString();

async function uuidFrom(text) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`fake-user:${text}`)));
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Buffer.from(hash.slice(0, 16)).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function jsonResponse(status, data, headers = {}) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
const gotrueError = (status, errorCode, msg) => jsonResponse(status, { code: status, error_code: errorCode, msg });

/**
 * @param {{origin?: string, accessTtlSeconds?: number, now?: () => number, code?: string, reuseIntervalSeconds?: number}} [options]
 */
export function createFakeSupabase({ origin = 'http://127.0.0.1:54321', accessTtlSeconds = 3600, now = () => Date.now(), code = '123456', reuseIntervalSeconds = 10 } = {}) {
  const issuer = `${origin}/auth/v1`;
  const state = {
    users: new Map(), // email → user
    otps: new Map(), // email → sentAt
    flows: new Map(), // auth code → {challenge, method, provider, createdAt}
    sessions: new Map(), // session id → {userId, revoked}
    refreshTokens: new Map(), // token → {sessionId, usedAt, child}
    requests: [], // {method, path} 만(본문·토큰은 남기지 않는다)
  };
  let signingKey;
  const key = async () =>
    (signingKey ??= await crypto.subtle.importKey('raw', encoder.encode(FAKE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));

  async function sign(payload) {
    const head = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'fake' })));
    const body = b64url(encoder.encode(JSON.stringify(payload)));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), encoder.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(signature)}`;
  }

  async function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { error: 'bad_jwt' };
    const ok = await crypto.subtle.verify('HMAC', await key(), Buffer.from(parts[2], 'base64url'), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return { error: 'bad_jwt' };
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { error: 'bad_jwt' };
    }
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(now() / 1000)) return { error: 'bad_jwt' };
    const session = state.sessions.get(payload.session_id);
    if (!session || session.revoked) return { error: 'session_not_found' };
    return { payload };
  }

  async function userFor(email, provider) {
    let user = state.users.get(email);
    if (!user) {
      const id = await uuidFrom(email);
      const at = iso(now());
      user = {
        id,
        aud: 'authenticated',
        role: 'authenticated',
        email,
        email_confirmed_at: null,
        phone: '',
        confirmed_at: null,
        last_sign_in_at: null,
        app_metadata: { provider, providers: [provider] },
        user_metadata: {},
        identities: [
          {
            identity_id: await uuidFrom(`${provider}:${email}:identity`),
            id: provider === 'email' ? id : randomHex(10),
            user_id: id,
            identity_data: { email, email_verified: true, phone_verified: false, sub: id },
            provider,
            last_sign_in_at: at,
            created_at: at,
            updated_at: at,
            email,
          },
        ],
        created_at: at,
        updated_at: at,
        is_anonymous: false,
      };
      state.users.set(email, user);
    } else if (!user.app_metadata.providers.includes(provider)) {
      user.app_metadata.providers.push(provider);
    }
    return user;
  }

  async function accessToken(user, sessionId, method) {
    const iat = Math.floor(now() / 1000);
    return sign({
      iss: issuer,
      sub: user.id,
      aud: 'authenticated',
      exp: iat + accessTtlSeconds,
      iat,
      email: user.email,
      phone: '',
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method, timestamp: iat }],
      session_id: sessionId,
      is_anonymous: false,
    });
  }

  async function newSession(user, method, extra = {}) {
    const at = now();
    user.email_confirmed_at ??= iso(at);
    user.confirmed_at ??= iso(at);
    user.last_sign_in_at = iso(at);
    const sessionId = await uuidFrom(`session:${randomHex(8)}`);
    state.sessions.set(sessionId, { userId: user.id, revoked: false });
    const refresh = randomHex(16);
    state.refreshTokens.set(refresh, { sessionId, usedAt: null, child: null });
    return sessionBody(user, await accessToken(user, sessionId, method), refresh, extra);
  }

  function sessionBody(user, access, refresh, extra = {}) {
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: accessTtlSeconds,
      expires_at: Math.floor(now() / 1000) + accessTtlSeconds,
      refresh_token: refresh,
      user,
      ...extra,
    };
  }

  const userById = (id) => [...state.users.values()].find((user) => user.id === id);

  async function readBody(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/auth\/v1/, '');
    state.requests.push({ method: request.method, path });
    if (!url.pathname.startsWith('/auth/v1/')) return gotrueError(404, 'not_found', 'Not found');
    if (path !== '/authorize' && !request.headers.get('apikey')) return jsonResponse(401, { message: 'No API key found in request' });

    if (path === '/otp' && request.method === 'POST') {
      const body = await readBody(request);
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL.test(email)) return gotrueError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (body.create_user === false && !state.users.has(email)) return gotrueError(422, 'otp_disabled', 'Signups not allowed for otp');
      await userFor(email, 'email');
      state.otps.set(email, now());
      return jsonResponse(200, {});
    }

    if (path === '/verify' && request.method === 'POST') {
      const body = await readBody(request);
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      const sentAt = state.otps.get(email);
      if (!['email', 'magiclink', 'signup'].includes(body?.type) || sentAt === undefined || now() - sentAt > 3600_000 || body.token !== code)
        return gotrueError(403, 'otp_expired', 'Token has expired or is invalid');
      state.otps.delete(email);
      return jsonResponse(200, await newSession(await userFor(email, 'email'), 'otp'));
    }

    if (path === '/authorize' && request.method === 'GET') {
      const provider = url.searchParams.get('provider');
      const redirectTo = url.searchParams.get('redirect_to');
      const challenge = url.searchParams.get('code_challenge');
      const method = (url.searchParams.get('code_challenge_method') || '').toLowerCase();
      if (!provider || provider === 'email') return gotrueError(400, 'validation_failed', 'Unsupported provider: Provider could not be found');
      if (!challenge || !['s256', 'plain'].includes(method)) return gotrueError(400, 'validation_failed', 'PKCE flow requires code_challenge and code_challenge_method');
      let target;
      try {
        target = new URL(redirectTo);
      } catch {
        return gotrueError(400, 'validation_failed', 'invalid redirect_to');
      }
      const authCode = await uuidFrom(`flow:${randomHex(8)}`);
      state.flows.set(authCode, { challenge, method, provider, createdAt: now() });
      target.searchParams.set('code', authCode);
      return new Response(null, { status: 302, headers: { location: target.href } });
    }

    if (path === '/token' && request.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const body = await readBody(request);
      if (grant === 'pkce') {
        const flow = state.flows.get(body?.auth_code);
        if (!flow || now() - flow.createdAt > 300_000) return gotrueError(404, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
        const verifier = String(body?.code_verifier || '');
        const expected = flow.method === 's256' ? b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))) : verifier;
        if (!verifier || expected !== flow.challenge) return gotrueError(400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
        state.flows.delete(body.auth_code);
        const user = await userFor(`${flow.provider.replace(/[^a-z0-9]/g, '-')}.user@example.test`, flow.provider);
        return jsonResponse(200, await newSession(user, 'oauth', { provider_token: `fake-${flow.provider}-provider-token`, provider_refresh_token: null }));
      }
      if (grant === 'refresh_token') {
        const record = state.refreshTokens.get(body?.refresh_token);
        const session = record && state.sessions.get(record.sessionId);
        if (!record || !session || session.revoked) return gotrueError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        const user = userById(session.userId);
        if (record.usedAt !== null) {
          if (now() - record.usedAt <= reuseIntervalSeconds * 1000 && record.child) {
            return jsonResponse(200, sessionBody(user, await accessToken(user, record.sessionId, 'token_refresh'), record.child));
          }
          session.revoked = true;
          return gotrueError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
        }
        const child = randomHex(16);
        record.usedAt = now();
        record.child = child;
        state.refreshTokens.set(child, { sessionId: record.sessionId, usedAt: null, child: null });
        return jsonResponse(200, sessionBody(user, await accessToken(user, record.sessionId, 'token_refresh'), child));
      }
      return gotrueError(400, 'validation_failed', 'unsupported_grant_type');
    }

    if (path === '/user' && request.method === 'GET') {
      const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '')?.[1];
      if (!bearer) return gotrueError(401, 'no_authorization', 'This endpoint requires a valid Bearer token');
      const checked = await verifyJwt(bearer);
      if (checked.error === 'session_not_found') return gotrueError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
      if (checked.error) return gotrueError(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired');
      const user = userById(checked.payload.sub);
      return user ? jsonResponse(200, user) : gotrueError(404, 'user_not_found', 'User from sub claim in JWT does not exist');
    }

    if (path === '/logout' && request.method === 'POST') {
      const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '')?.[1];
      if (!bearer) return gotrueError(401, 'no_authorization', 'This endpoint requires a valid Bearer token');
      const checked = await verifyJwt(bearer);
      if (checked.error) return gotrueError(403, checked.error, 'invalid JWT');
      state.sessions.get(checked.payload.session_id).revoked = true;
      return jsonResponse(204, null);
    }

    return gotrueError(404, 'not_found', 'Not found');
  }

  return {
    origin,
    state,
    handle,
    /** Worker 의 fetch 대신 넣는 함수(Request 또는 주소 + init). */
    fetch: (input, init) => handle(input instanceof Request && init === undefined ? input : new Request(input, init)),
  };
}

function option(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const host = option('host', '127.0.0.1');
  const port = Number(option('port', process.env.FAKE_SUPABASE_PORT || '54321'));
  const accessTtlSeconds = Number(option('access-ttl', process.env.FAKE_SUPABASE_ACCESS_TTL || '3600'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('가짜 Supabase 는 루프백 주소에서만 띄웁니다');
  const fake = createFakeSupabase({ origin: `http://${host}:${port}`, accessTtlSeconds });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${host}:${port}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => [name, v]) : [[name, value]])),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const response = await fake.handle(request);
      const payload = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(payload);
      // 경로와 상태만 남긴다(본문·이메일·토큰·검색어는 남기지 않는다).
      console.log(`[fake-supabase] ${req.method} ${new URL(request.url).pathname} ${response.status}`);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"code":500,"error_code":"unexpected_failure","msg":"fake server error"}');
    }
  });
  server.listen(port, host, () => {
    console.log(`[fake-supabase] http://${host}:${port}  (로그인 코드 123456, 액세스 토큰 ${accessTtlSeconds}초)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
