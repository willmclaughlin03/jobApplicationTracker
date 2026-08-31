import {
  APP_REQUEST_HEADER,
  APP_REQUEST_VALUE,
  AUTH_SESSION_ERROR_CODES,
  AUTH_SIGNOUT_ERROR_CODES,
  AUTH_SIGNOUT_REMOTE_TERMINATION,
  AUTH_SIGNOUT_STATUS,
  AUTH_STATUS,
  AUTH_USER_ROLES,
  AUTH_V2_VERSION,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
  PRIVATE_NO_STORE,
} from '../authV2.js';

describe('authV2 constants', () => {
  it('freezes the exact shared version, states, roles, and intent headers', () => {
    expect(AUTH_V2_VERSION).toBe(2);
    expect(AUTH_STATUS).toStrictEqual({
      LOADING: 'loading',
      AUTHENTICATED: 'authenticated',
      ANONYMOUS: 'anonymous',
      UNAVAILABLE: 'unavailable',
      SIGNED_OUT_LOCAL: 'signed_out_local',
      LOGOUT_UNCONFIRMED: 'logout_unconfirmed',
      TERMINAL_UNAUTHENTICATED: 'terminal_unauthenticated',
    });
    expect(AUTH_USER_ROLES).toStrictEqual({ USER: 'user', ADMIN: 'admin' });
    expect([APP_REQUEST_HEADER, APP_REQUEST_VALUE]).toStrictEqual(['X-App-Request', '1']);
    expect([LOGOUT_INTENT_HEADER, LOGOUT_INTENT_VALUE]).toStrictEqual([
      'X-Logout-Intent',
      '1',
    ]);
    expect(PRIVATE_NO_STORE).toBe('private, no-store');
    expect(Object.isFrozen(AUTH_STATUS)).toBe(true);
    expect(Object.isFrozen(AUTH_USER_ROLES)).toBe(true);
  });

  it('keeps response outcomes and error codes finite and immutable', () => {
    expect(AUTH_SESSION_ERROR_CODES).toStrictEqual({
      SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE',
      RATE_LIMITED: 'RATE_LIMITED',
      ACCOUNT_ACCESS_RESTRICTED: 'ACCOUNT_ACCESS_RESTRICTED',
    });
    expect(AUTH_SIGNOUT_STATUS).toStrictEqual({
      COMPLETE: 'complete',
      LOCAL_ONLY: 'local_only',
      REJECTED: 'rejected',
    });
    expect(AUTH_SIGNOUT_REMOTE_TERMINATION).toStrictEqual({
      CONFIRMED: 'confirmed',
      ALREADY_INVALID: 'already_invalid',
      NOT_NEEDED: 'not_needed',
      UNCONFIRMED: 'unconfirmed',
    });
    expect(AUTH_SIGNOUT_ERROR_CODES).toStrictEqual({
      REQUEST_REJECTED: 'LOGOUT_REQUEST_REJECTED',
    });
    [
      AUTH_SESSION_ERROR_CODES,
      AUTH_SIGNOUT_STATUS,
      AUTH_SIGNOUT_REMOTE_TERMINATION,
      AUTH_SIGNOUT_ERROR_CODES,
    ].forEach((value) => expect(Object.isFrozen(value)).toBe(true));
  });
});
