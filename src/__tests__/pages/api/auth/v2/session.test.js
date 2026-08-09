/**
 * CHUNK-0 route-level contract tests for the future v2 session endpoint.
 *
 * Purpose: Fail cleanly while the dark v2 route is absent, then exercise the
 * actual handler's strict classification and response behavior in CHUNK-2.
 * Connects to: src/pages/api/auth/v2/session.js and the frozen v2 fixtures.
 */

const fs = require('node:fs');
const path = require('node:path');

const mockGetUser = jest.fn();
let mockCapturedRateLimitOptions;

jest.mock('../../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

jest.mock('../../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: jest.fn((handler, options) => {
    mockCapturedRateLimitOptions = options;
    return handler;
  }),
}));

const {
  AUTH_STATUS,
  ROLE_NORMALIZATION_FIXTURES,
  SAFE_USER_FIXTURE,
  SESSION_ERROR_EVIDENCE,
  SESSION_RESPONSE_FIXTURES,
  sessionHttpResponseSchema,
} = require('../../../../../testSupport/authV2ContractFixtures.js');

const routeSource = 'src/pages/api/auth/v2/session.js';
const routePath = path.join(process.cwd(), routeSource);
const routeExists = fs.existsSync(routePath);
const routeModule = routeExists
  ? require('../../../../../pages/api/auth/v2/session.js')
  : null;
const handler = routeModule?.default;

/**
 * Creates a v2 session request with a non-sensitive logger double.
 *
 * @returns {object} Next.js API request surface used by the route.
 */
function createRequest() {
  return {
    method: 'GET',
    cookies: {},
    headers: {},
    log: {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  };
}

/**
 * Creates a response double that exposes the complete HTTP contract.
 *
 * @returns {object} Mutable response with status, header, and body capture.
 */
function createResponse() {
  const headers = new Map();
  const response = {
    body: undefined,
    statusCode: 200,
    end: jest.fn((body) => {
      response.body = body;
      return response;
    }),
    getHeader: jest.fn((name) => headers.get(name.toLowerCase())),
    json: jest.fn((body) => {
      response.body = body;
      return response;
    }),
    setHeader: jest.fn((name, value) => {
      headers.set(name.toLowerCase(), value);
      return response;
    }),
    status: jest.fn((statusCode) => {
      response.statusCode = statusCode;
      return response;
    }),
  };

  return response;
}

/**
 * Converts the response double into the strict public-contract shape.
 *
 * @param {object} response - Completed response double.
 * @returns {object} Status, relevant headers, and parsed response body.
 */
function captureHttpContract(response) {
  const cacheControl = response.getHeader('cache-control');
  const retryAfter = response.getHeader('retry-after');
  const headers = { 'cache-control': cacheControl };

  if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);

  return {
    httpStatus: response.statusCode,
    headers,
    body: response.body,
  };
}

if (!routeExists) {
  describe('GET /api/auth/v2/session route contract', () => {
    it('CHUNK-2 creates the isolated v2 session handler before behavior can go green', () => {
      expect(routeExists).toBe(true);
    });
  });
} else if (typeof handler !== 'function') {
  describe('GET /api/auth/v2/session route contract', () => {
    it('exports a callable default handler before behavior can go green', () => {
      expect(handler).toEqual(expect.any(Function));
    });
  });
} else {
  describe('GET /api/auth/v2/session route contract', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('uses an isolated public wrapper configuration without v1 fallback', () => {
      expect(mockCapturedRateLimitOptions).toEqual(expect.objectContaining({
        allowedMethods: ['GET'],
        requireAuth: false,
      }));
    });

    it.each([
      ['missing user role', {}, 'user'],
      ['null user role', { role: null }, 'user'],
      ['explicit user role', { role: 'user' }, 'user'],
      ['explicit admin role', { role: 'admin' }, 'admin'],
    ])('returns a strict authenticated response for %s', async (_name, appMetadata, role) => {
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            ...SAFE_USER_FIXTURE,
            app_metadata: appMetadata,
          },
        },
        error: null,
      });
      const response = createResponse();

      await handler(createRequest(), response);

      const contract = captureHttpContract(response);
      expect(sessionHttpResponseSchema.safeParse(contract).success).toBe(true);
      expect(contract).toEqual({
        ...SESSION_RESPONSE_FIXTURES.authenticated,
        body: {
          ...SESSION_RESPONSE_FIXTURES.authenticated.body,
          user: { ...SAFE_USER_FIXTURE, role },
        },
      });
    });

    it.each(ROLE_NORMALIZATION_FIXTURES.filter(({ result }) => result === 'unavailable'))(
      'maps invalid role $raw to strict unavailable instead of authorizing it',
      async ({ raw }) => {
        mockGetUser.mockResolvedValue({
          data: {
            user: {
              ...SAFE_USER_FIXTURE,
              app_metadata: { role: raw },
            },
          },
          error: null,
        });
        const response = createResponse();

        await handler(createRequest(), response);

        expect(captureHttpContract(response)).toEqual(SESSION_RESPONSE_FIXTURES.unavailable);
      }
    );

    it.each([
      ['malformed user id', { id: 'not-a-uuid' }],
      ['malformed user email', { email: 'not-an-email' }],
    ])('maps a %s to strict unavailable without exposing it', async (_name, userOverride) => {
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            ...SAFE_USER_FIXTURE,
            ...userOverride,
            app_metadata: { role: 'user' },
          },
        },
        error: null,
      });
      const response = createResponse();

      await handler(createRequest(), response);

      expect(captureHttpContract(response)).toEqual(SESSION_RESPONSE_FIXTURES.unavailable);
    });

    it('maps only the installed missing-session tuple to anonymous', async () => {
      const [{ exportedClass, status }] = SESSION_ERROR_EVIDENCE.locallyVerified;
      const missingSessionError = new Error('sanitized missing-session marker');
      missingSessionError.name = exportedClass;
      missingSessionError.status = status;
      mockGetUser.mockResolvedValue({ data: { user: null }, error: missingSessionError });
      const response = createResponse();

      await handler(createRequest(), response);

      expect(captureHttpContract(response)).toEqual(SESSION_RESPONSE_FIXTURES.anonymous);
    });

    it.each([
      ['null user and null error', { data: { user: null }, error: null }],
      ['unknown returned error', {
        data: { user: null },
        error: { name: 'AuthApiError', code: 'future_code', status: 401 },
      }],
      ['network rejection', new Error('sanitized network failure')],
    ])('keeps %s unavailable without clearing authority uncertainty', async (
      _name,
      result
    ) => {
      if (result instanceof Error) {
        mockGetUser.mockRejectedValue(result);
      } else {
        mockGetUser.mockResolvedValue(result);
      }
      const response = createResponse();

      await handler(createRequest(), response);

      expect(captureHttpContract(response)).toEqual(SESSION_RESPONSE_FIXTURES.unavailable);
    });

    it.each(SESSION_ERROR_EVIDENCE.deployedCandidates)(
      'does not activate unsupported deployed candidate %s',
      async (code) => {
        expect(SESSION_ERROR_EVIDENCE.deployedAllowlist).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code }),
        ]));
        mockGetUser.mockResolvedValue({
          data: { user: null },
          error: { name: 'AuthApiError', code, status: 403 },
        });
        const response = createResponse();

        await handler(createRequest(), response);

        expect(captureHttpContract(response)).toEqual(SESSION_RESPONSE_FIXTURES.unavailable);
      }
    );

    it('never accepts a legacy envelope as a v2 route response', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = createResponse();

      await handler(createRequest(), response);

      const contract = captureHttpContract(response);
      expect(contract.body).not.toHaveProperty('data');
      expect(contract.body?.status).toBe(AUTH_STATUS.UNAVAILABLE);
      expect(sessionHttpResponseSchema.safeParse(contract).success).toBe(true);
    });
  });
}
