import pino from 'pino';
import {
  AUTH_PROVIDER_LOG_EVENTS,
  AUTH_PROVIDER_LOG_ROUTES,
  formatAuthProviderError,
} from '../authProviderError.js';

describe('formatAuthProviderError', () => {
  it('returns only approved bounded metadata', () => {
    expect(formatAuthProviderError({
      route: AUTH_PROVIDER_LOG_ROUTES.V2_SESSION,
      event: AUTH_PROVIDER_LOG_EVENTS.SESSION_LOOKUP_FAILED,
      error: { name: 'AuthApiError', status: 403, code: 'bad_jwt' },
    })).toStrictEqual({
      route: 'v2_session',
      event: 'session_lookup_failed',
      name: 'AuthApiError',
      status: 403,
      code: 'bad_jwt',
    });
  });

  it.each([
    ['unknown route and event', { route: 'route-sentinel', event: 'event-sentinel', error: {} }, {
      route: 'unknown', event: 'unknown', name: 'unknown', status: null, code: 'absent',
    }],
    ['unknown name and code', {
      route: AUTH_PROVIDER_LOG_ROUTES.PROTECTED_API,
      event: AUTH_PROVIDER_LOG_EVENTS.AUTHORIZATION_FAILED,
      error: { name: 'FutureError', status: 401, code: 'future_code' },
    }, {
      route: 'protected_api', event: 'authorization_failed', name: 'unknown', status: 401, code: 'unknown',
    }],
    ['invalid status', {
      route: AUTH_PROVIDER_LOG_ROUTES.SERVER_RENDER,
      event: AUTH_PROVIDER_LOG_EVENTS.PROVIDER_EXCEPTION,
      error: { name: 'Error', status: 600, code: null },
    }, {
      route: 'server_render', event: 'provider_exception', name: 'Error', status: null, code: 'absent',
    }],
  ])('normalizes %s', (_name, input, expected) => {
    expect(formatAuthProviderError(input)).toStrictEqual(expected);
  });

  it('excludes every prohibited provider field when serialized through Pino', () => {
    const sentinels = Object.freeze({
      message: 'message-private-sentinel',
      stack: 'stack-private-sentinel',
      cause: 'cause-private-sentinel',
      url: 'url-private-sentinel',
      query: 'query-private-sentinel',
      payload: 'payload-private-sentinel',
      request: 'request-private-sentinel',
      response: 'response-private-sentinel',
      headers: 'headers-private-sentinel',
      cookies: 'cookies-private-sentinel',
      roles: 'roles-private-sentinel',
      accessToken: 'access-token-private-sentinel',
      refreshToken: 'refresh-token-private-sentinel',
      metadata: 'metadata-private-sentinel',
    });
    const writes = [];
    const destination = { write: (chunk) => writes.push(String(chunk)) };
    const log = pino({ base: null, timestamp: false }, destination);
    const error = {
      name: 'AuthApiError',
      status: 403,
      code: 'user_not_found',
      message: sentinels.message,
      stack: sentinels.stack,
      cause: { value: sentinels.cause },
      url: sentinels.url,
      query: sentinels.query,
      payload: { value: sentinels.payload },
      request: { value: sentinels.request },
      response: { value: sentinels.response },
      headers: { value: sentinels.headers },
      cookies: sentinels.cookies,
      roles: [sentinels.roles],
      access_token: sentinels.accessToken,
      refresh_token: sentinels.refreshToken,
      metadata: { value: sentinels.metadata },
    };

    const formatted = formatAuthProviderError({
      route: AUTH_PROVIDER_LOG_ROUTES.V2_SESSION,
      event: AUTH_PROVIDER_LOG_EVENTS.SESSION_LOOKUP_FAILED,
      error,
    });
    log.error(formatted, 'Authentication provider request failed');

    const serialized = writes.join('');
    expect(Object.keys(formatted)).toStrictEqual(['route', 'event', 'name', 'status', 'code']);
    Object.values(sentinels).forEach((sentinel) => {
      expect(serialized).not.toContain(sentinel);
    });
  });

  it('is total for throwing proxies and never returns the source object', () => {
    const error = new Proxy({}, {
      get() {
        throw new Error('proxy-sentinel');
      },
    });
    const input = { error };

    expect(() => formatAuthProviderError(input)).not.toThrow();
    const formatted = formatAuthProviderError(input);
    expect(formatted).toStrictEqual({
      route: 'unknown',
      event: 'unknown',
      name: 'unknown',
      status: null,
      code: 'absent',
    });
    expect(Object.values(formatted)).not.toContain(error);
  });
});
