// 견본 보호 API: GET /api/members/hello → { email }. PROTECTED_PATHS 의 /api/members/ 라 gate 를 지나야 온다.
// 새 보호 API 는 이 파일처럼 ctx.user 를 쓰고, 혹시 gate 설정에서 빠져도 열리지 않게 사용자 확인을 한 번 더 한다.
import { signedInUser } from './auth/current.js';
import { fail, json } from './http.js';

/** @param {any} ctx 요청 문맥(app.js) */
export async function handleMembers(ctx) {
  if (ctx.path !== '/api/members/hello') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', { headers: { allow: 'GET, HEAD' } });
  const user = ctx.user ?? (await signedInUser(ctx));
  if (!user) fail(401, 'SIGN_IN_REQUIRED');
  return json({ email: user.email });
}
