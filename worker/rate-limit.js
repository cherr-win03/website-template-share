// 요청 빈도 제한. Cloudflare Workers Rate Limiting 바인딩(wrangler.jsonc ratelimits)을 쓴다.
// 바인딩이 없거나 호출이 실패하면 허용한다(fail-open: 로컬·시험·미설정 배포에서 기능을 막지 않는다).
// 초과는 429 RATE_LIMITED + retryAfter(초). 키는 cf-connecting-ip, IPv6 는 /64 로 묶는다. 로그·오류에 IP 를 남기지 않는다.
//   주의: Workers ratelimit 의 period 는 10 또는 60(초)만 된다(추정입니다: Cloudflare 문서 기준).

const AUTH_POST = /^\/api\/auth\/[a-z][a-z/-]*$/;
// 빈도 제한을 받지 않는 경로: 로그아웃이 막히면 공용 기기에서 세션을 끝낼 수 없다.
const EXEMPT = new Set(['/api/auth/logout']);

/**
 * 경로·메서드 → 범위. path 는 normalizePath 결과.
 * auth: POST /api/auth/*(로그아웃 제외) + 소셜 콜백 GET(Supabase 코드 교환이 일어나는 GET).
 */
export const RATE_LIMIT_RULES = Object.freeze([
  Object.freeze({
    scope: 'auth',
    binding: 'AUTH_RATE_LIMITER',
    period: 60,
    match: (path, method) =>
      (method === 'POST' && AUTH_POST.test(path) && !EXEMPT.has(path)) ||
      (method === 'GET' && path === '/api/auth/social/callback'),
  }),
]);

/** @returns {typeof RATE_LIMIT_RULES[number] | null} */
export function rateLimitRule(path, method) {
  if (typeof path !== 'string' || typeof method !== 'string') return null;
  return RATE_LIMIT_RULES.find((rule) => rule.match(path, method)) || null;
}

const hextet = (s) => /^[0-9a-f]{1,4}$/i.test(s);

/** cf-connecting-ip → 제한 키. IPv4 그대로, IPv6 는 앞 64비트, IPv4-mapped 는 IPv4. 없거나 형식이 다르면 'anonymous'. */
export function rateLimitKey(address) {
  if (typeof address !== 'string') return 'anonymous';
  const ip = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip.split('.').every((n) => Number(n) <= 255) ? ip : 'anonymous';
  if (!ip.includes(':')) return 'anonymous';
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return rateLimitKey(mapped[1]);
  const halves = ip.split('::');
  if (halves.length > 2) return 'anonymous';
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ((halves.length === 1 && head.length !== 8) || (halves.length === 2 && head.length + tail.length > 7)) return 'anonymous';
  if (![...head, ...tail].every(hextet)) return 'anonymous';
  const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * 허용 여부. {allowed:true, scope} 또는 {allowed:false, scope, retryAfter}. 반환값에 키(IP)는 없다.
 * @param {Record<string, any>} env
 * @param {{path: string, method: string, address: string | null}} request
 */
export async function rateLimitDecision(env, { path, method, address }) {
  const rule = rateLimitRule(path, method);
  if (!rule) return { allowed: true, scope: null };
  const limiter = env?.[rule.binding];
  if (!limiter || typeof limiter.limit !== 'function') return { allowed: true, scope: rule.scope, enforced: false };
  let success = true;
  try {
    const result = await limiter.limit({ key: `${rule.scope}:${rateLimitKey(address)}` });
    success = result?.success !== false;
  } catch {
    success = true;
  }
  return success
    ? { allowed: true, scope: rule.scope, enforced: true }
    : { allowed: false, scope: rule.scope, enforced: true, retryAfter: rule.period };
}
