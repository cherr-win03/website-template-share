// Worker 진입점(wrangler.jsonc main). 흐름은 app.js, 약속은 docs/CONTRACT.md.
// 진입 모듈은 기본 내보내기(fetch 처리기) 하나만 둔다: workerd 는 진입 모듈의 이름 있는 내보내기를
// 처리기·클래스로 해석하므로 상수·도우미를 여기서 내보내지 않는다(시험이 확인한다).
import { handleRequest } from './app.js';

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{waitUntil(promise: Promise<unknown>): void}} ctx
   */
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
