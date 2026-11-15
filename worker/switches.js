// 기능 스위치 관례(CONTRACT 5절): 값이 없거나 `disabled` → 꺼짐, `enabled` → 켜짐, 그 밖의 값은 추측하지 않고 503 으로 닫는다.
// 값은 요청마다 env 에서 읽는다(모듈을 불러올 때 읽지 않는다).
import { fail } from './http.js';

/**
 * @param {unknown} value env 값
 * @param {string} misconfiguredCode 알 수 없는 값일 때 503 오류 코드
 * @returns {boolean} 켜짐 여부
 */
export function switchEnabled(value, misconfiguredCode = 'SERVICE_UNAVAILABLE') {
  if (value === undefined || value === null || value === '' || value === 'disabled') return false;
  if (value === 'enabled') return true;
  return fail(503, misconfiguredCode);
}

/** 로그인 스위치. 알 수 없는 값은 503 AUTH_MISCONFIGURED. */
export function authEnabled(env) {
  return switchEnabled(env?.AUTH_ACTIVATION, 'AUTH_MISCONFIGURED');
}
