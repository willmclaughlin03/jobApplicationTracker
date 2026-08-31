import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from '@supabase/supabase-js';
import { AUTH_STATUS } from '../../../shared/constants/authV2.js';
import { AUTH_PROVIDER_OPERATIONS } from '../authProviderOperationTracker.js';
import {
  AUTH_SESSION_CLASSIFIER_ENDPOINTS,
  classifyAuthSessionError,
} from '../authSessionClassifier.js';

const SESSION_LOOKUP = AUTH_SESSION_CLASSIFIER_ENDPOINTS.SESSION_LOOKUP;

/**
 * Creates the exact classifier input for the v2 session lookup boundary.
 *
 * @param {unknown} operation tracked provider operation
 * @param {unknown} error provider error candidate
 * @returns {object} classifier input
 */
function createClassifierInput(operation, error) {
  return { endpoint: SESSION_LOOKUP, operation, error };
}

describe('classifyAuthSessionError', () => {
  it.each([
    [null, new AuthSessionMissingError(), AUTH_STATUS.ANONYMOUS],
    [
      AUTH_PROVIDER_OPERATIONS.GET_USER,
      new AuthApiError('provider-sentinel', 403, 'bad_jwt'),
      AUTH_STATUS.ANONYMOUS,
    ],
    [
      AUTH_PROVIDER_OPERATIONS.GET_USER,
      new AuthApiError('provider-sentinel', 403, 'user_not_found'),
      AUTH_STATUS.ANONYMOUS,
    ],
    [
      AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH,
      new AuthApiError('provider-sentinel', 400, 'user_banned'),
      AUTH_STATUS.TERMINAL_UNAUTHENTICATED,
    ],
  ])('activates an exact frozen tuple', (operation, error, expected) => {
    expect(classifyAuthSessionError(createClassifierInput(operation, error))).toBe(expected);
  });

  it.each([
    ['missing-session after getUser', AUTH_PROVIDER_OPERATIONS.GET_USER, new AuthSessionMissingError()],
    ['unsupported session_not_found', AUTH_PROVIDER_OPERATIONS.GET_USER, new AuthApiError('x', 403, 'session_not_found')],
    ['wrong status', AUTH_PROVIDER_OPERATIONS.GET_USER, new AuthApiError('x', 400, 'bad_jwt')],
    ['wrong operation', AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH, new AuthApiError('x', 403, 'bad_jwt')],
    ['generic forbidden', AUTH_PROVIDER_OPERATIONS.GET_USER, new Error('forbidden')],
    ['retryable fetch error', AUTH_PROVIDER_OPERATIONS.GET_USER, new AuthRetryableFetchError('network', 0)],
    ['null error', null, null],
  ])('keeps %s unavailable', (_name, operation, error) => {
    expect(classifyAuthSessionError(createClassifierInput(operation, error)))
      .toBe(AUTH_STATUS.UNAVAILABLE);
  });

  it('proves only three AuthApiError permutations activate', () => {
    const operations = [
      null,
      AUTH_PROVIDER_OPERATIONS.GET_USER,
      AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH,
      'unsupported_operation',
    ];
    const statuses = [400, 401, 403, 429, 500];
    const codes = [
      'bad_jwt',
      'user_not_found',
      'user_banned',
      'session_expired',
      'session_not_found',
      'refresh_token_not_found',
      'refresh_token_already_used',
      undefined,
    ];
    let activated = 0;

    operations.forEach((operation) => {
      statuses.forEach((status) => {
        codes.forEach((code) => {
          const result = classifyAuthSessionError(createClassifierInput(
            operation,
            new AuthApiError('provider-sentinel', status, code)
          ));
          const expected = operation === AUTH_PROVIDER_OPERATIONS.GET_USER
            && status === 403
            && (code === 'bad_jwt' || code === 'user_not_found')
            ? AUTH_STATUS.ANONYMOUS
            : operation === AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH
              && status === 400
              && code === 'user_banned'
              ? AUTH_STATUS.TERMINAL_UNAUTHENTICATED
              : AUTH_STATUS.UNAVAILABLE;

          expect(result).toBe(expected);
          if (result !== AUTH_STATUS.UNAVAILABLE) activated += 1;
        });
      });
    });

    expect(activated).toBe(3);
  });

  it('proves only one exact missing-session permutation activates', () => {
    const operations = [null, AUTH_PROVIDER_OPERATIONS.GET_USER, undefined];
    const statuses = [400, 401, 403];
    const codes = [undefined, 'session_not_found'];
    let activated = 0;

    operations.forEach((operation) => {
      statuses.forEach((status) => {
        codes.forEach((code) => {
          const error = new AuthSessionMissingError();
          error.status = status;
          error.code = code;
          const result = classifyAuthSessionError(createClassifierInput(operation, error));
          const expected = operation === null && status === 400 && code === undefined
            ? AUTH_STATUS.ANONYMOUS
            : AUTH_STATUS.UNAVAILABLE;

          expect(result).toBe(expected);
          if (result !== AUTH_STATUS.UNAVAILABLE) activated += 1;
        });
      });
    });

    expect(activated).toBe(1);
  });

  it('rejects plain-object forgeries and subclasses of exported errors', () => {
    class DerivedAuthApiError extends AuthApiError {}
    class DerivedMissingError extends AuthSessionMissingError {}
    const plainForgery = {
      name: 'AuthApiError',
      status: 403,
      code: 'bad_jwt',
    };
    const subclass = new DerivedAuthApiError('provider-sentinel', 403, 'bad_jwt');

    expect(classifyAuthSessionError(createClassifierInput(
      AUTH_PROVIDER_OPERATIONS.GET_USER,
      plainForgery
    ))).toBe(AUTH_STATUS.UNAVAILABLE);
    expect(classifyAuthSessionError(createClassifierInput(
      AUTH_PROVIDER_OPERATIONS.GET_USER,
      subclass
    ))).toBe(AUTH_STATUS.UNAVAILABLE);
    expect(classifyAuthSessionError(createClassifierInput(
      null,
      new DerivedMissingError()
    ))).toBe(AUTH_STATUS.UNAVAILABLE);
  });

  it('requires the exact endpoint and explicit null for a local missing session', () => {
    const missing = new AuthSessionMissingError();

    expect(classifyAuthSessionError({
      endpoint: 'protected_api',
      operation: null,
      error: missing,
    })).toBe(AUTH_STATUS.UNAVAILABLE);
    expect(classifyAuthSessionError({
      endpoint: SESSION_LOOKUP,
      operation: undefined,
      error: missing,
    })).toBe(AUTH_STATUS.UNAVAILABLE);
  });

  it('remains unavailable for malformed input and throwing accessors', () => {
    const input = { endpoint: SESSION_LOOKUP, operation: null };
    Object.defineProperty(input, 'error', {
      get() {
        throw new Error('classifier-getter-sentinel');
      },
    });

    expect(classifyAuthSessionError(input)).toBe(AUTH_STATUS.UNAVAILABLE);
    expect(classifyAuthSessionError(null)).toBe(AUTH_STATUS.UNAVAILABLE);
  });
});
