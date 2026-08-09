/**
 * CHUNK-0 route-level contract tests for the future v2 sign-out endpoint.
 *
 * Purpose: Keep missing-route failures controlled, then execute structural
 * rejection, local-scope, cleanup, and truthful-outcome tables in CHUNK-4.
 * Connects to: src/pages/api/auth/v2/signout.js and the frozen v2 fixtures.
 */

const fs = require('node:fs');
const path = require('node:path');

const mockClearCsrfCookie = jest.fn();
const mockCreateApiRouteClient = jest.fn();
const mockRateLimitWork = jest.fn();
const mockSignOut = jest.fn();
let mockCapturedRateLimitOptions;

jest.mock('../../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: mockCreateApiRouteClient,
}));

jest.mock('../../../../../server/lib/csrf.js', () => ({
  clearCsrfCookie: mockClearCsrfCookie,
}));

jest.mock('../../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: jest.fn((handler, options) => {
    mockCapturedRateLimitOptions = options;
    return async (...args) => {
      mockRateLimitWork();
      return handler(...args);
    };
  }),
}));

const {
  LOGOUT_INTENT_DECISION_FIXTURES,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
  LOGOUT_REJECTED_SIDE_EFFECTS,
  LOGOUT_REQUEST_BODY_FIXTURES,
  LOGOUT_SOURCE_DECISION_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
  signoutHttpResponseSchema,
} = require('../../../../../testSupport/authV2ContractFixtures.js');

const routeSource = 'src/pages/api/auth/v2/signout.js';
const routePath = path.join(process.cwd(), routeSource);
const routeExists = fs.existsSync(routePath);
const routeModule = routeExists
  ? require('../../../../../pages/api/auth/v2/signout.js')
  : null;
const handler = routeModule?.default;

/**
 * Creates a sign-out request with approved defaults and caller overrides.
 *
 * @param {object} overrides - Request fields used by one contract case.
 * @returns {object} Next.js API request surface.
 */
function createRequest(overrides = {}) {
  return {
    method: 'POST',
    body: undefined,
    cookies: {},
    headers: {
      [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
      'sec-fetch-site': 'same-origin',
    },
    log: {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };
}

/**
 * Creates a response double with observable headers and cookie mutations.
 *
 * @returns {object} Mutable Next.js response surface.
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
 * Captures relevant response fields for strict HTTP contract parsing.
 *
 * @param {object} response - Completed response double.
 * @returns {object} Strict status, headers, and body contract.
 */
function captureHttpContract(response) {
  const headers = {
    'cache-control': response.getHeader('cache-control'),
  };
  const allow = response.getHeader('allow');

  if (allow !== undefined) headers.allow = allow;

  return {
    httpStatus: response.statusCode,
    headers,
    body: response.body,
  };
}

/**
 * Captures every side effect forbidden before a logout request is accepted.
 *
 * @param {object} response - Response double whose cookie writes are inspected.
 * @returns {object} Observable Redis, Supabase, auth-cookie, and CSRF work counts.
 */
function captureRejectedSideEffects(response) {
  return {
    authCookieMutations: response.setHeader.mock.calls.filter(
      ([name]) => name.toLowerCase() === 'set-cookie'
    ).length,
    csrfMutations: mockClearCsrfCookie.mock.calls.length,
    redisCalls: mockRateLimitWork.mock.calls.length,
    supabaseCalls: mockCreateApiRouteClient.mock.calls.length,
  };
}

if (!routeExists) {
  describe('POST /api/auth/v2/signout route contract', () => {
    it('CHUNK-4 creates the isolated v2 sign-out handler before behavior can go green', () => {
      expect(routeExists).toBe(true);
    });
  });
} else if (typeof handler !== 'function') {
  describe('POST /api/auth/v2/signout route contract', () => {
    it('exports a callable default handler before behavior can go green', () => {
      expect(handler).toEqual(expect.any(Function));
    });
  });
} else {
  describe('POST /api/auth/v2/signout route contract', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockCreateApiRouteClient.mockReturnValue({
        auth: { signOut: mockSignOut },
      });
      mockSignOut.mockResolvedValue({ error: null });
    });

    it('uses the isolated public wrapper and permits POST only', () => {
      expect(mockCapturedRateLimitOptions).toEqual(expect.objectContaining({
        allowedMethods: ['POST'],
        requireAuth: false,
      }));
    });

    it.each(LOGOUT_REQUEST_BODY_FIXTURES.accepted)(
      'accepts $name and uses explicit local Supabase scope',
      async ({ body, contentType }) => {
        const headers = {
          [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
          'sec-fetch-site': 'same-origin',
        };
        if (contentType) headers['content-type'] = contentType;
        const response = createResponse();

        await handler(createRequest({ body, headers }), response);

        expect(mockRateLimitWork).toHaveBeenCalledTimes(1);
        expect(mockSignOut).toHaveBeenCalledTimes(1);
        expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(mockClearCsrfCookie).toHaveBeenCalledTimes(1);
        const authCookieWrites = response.setHeader.mock.calls.filter(
          ([name]) => name.toLowerCase() === 'set-cookie'
        );
        const authCookieWriteOrders = response.setHeader.mock.invocationCallOrder.filter(
          (_order, index) => (
            response.setHeader.mock.calls[index][0].toLowerCase() === 'set-cookie'
          )
        );
        expect(authCookieWrites.length).toBeGreaterThan(0);
        expect(Math.max(...authCookieWriteOrders)).toBeLessThan(
          response.json.mock.invocationCallOrder[0]
        );
        expect(captureHttpContract(response)).toEqual(SIGNOUT_RESPONSE_FIXTURES.localOnly);
        expect(signoutHttpResponseSchema.safeParse(captureHttpContract(response)).success).toBe(true);
      }
    );

    it.each(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => accepted))(
      'accepts source-proof case $name without weakening the intent requirement',
      async ({ headers: sourceHeaders }) => {
        const response = createResponse();

        await handler(createRequest({
          headers: {
            ...sourceHeaders,
            [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
          },
        }), response);

        expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(captureHttpContract(response)).toEqual(SIGNOUT_RESPONSE_FIXTURES.localOnly);
      }
    );

    it.each(LOGOUT_REQUEST_BODY_FIXTURES.rejected)(
      'rejects $name before any cleanup, Redis, or Supabase side effect',
      async ({ body, contentType }) => {
        const response = createResponse();
        const headers = {
          [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
          'sec-fetch-site': 'same-origin',
          'content-type': contentType,
        };

        await handler(createRequest({ body, headers }), response);

        expect(captureHttpContract(response)).toEqual(
          SIGNOUT_RESPONSE_FIXTURES.rejectedBadRequest
        );
        expect(captureRejectedSideEffects(response)).toEqual(LOGOUT_REJECTED_SIDE_EFFECTS);
      }
    );

    it.each(LOGOUT_INTENT_DECISION_FIXTURES.filter(({ accepted }) => !accepted))(
      'rejects intent case $name before side effects',
      async ({ value }) => {
        const headers = { 'sec-fetch-site': 'same-origin' };
        if (value !== undefined) headers[LOGOUT_INTENT_HEADER.toLowerCase()] = value;
        const response = createResponse();

        await handler(createRequest({ headers }), response);

        expect(captureHttpContract(response)).toEqual(
          SIGNOUT_RESPONSE_FIXTURES.rejectedForbidden
        );
        expect(captureRejectedSideEffects(response)).toEqual(LOGOUT_REJECTED_SIDE_EFFECTS);
      }
    );

    it.each(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => !accepted))(
      'rejects source-proof case $name before side effects',
      async ({ headers: sourceHeaders }) => {
        const response = createResponse();

        await handler(createRequest({
          headers: {
            ...sourceHeaders,
            [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
          },
        }), response);

        expect(captureHttpContract(response)).toEqual(
          SIGNOUT_RESPONSE_FIXTURES.rejectedForbidden
        );
        expect(captureRejectedSideEffects(response)).toEqual(LOGOUT_REJECTED_SIDE_EFFECTS);
      }
    );

    it.each([
      ['suppressed SDK status', { error: null }],
      ['returned Supabase failure', { error: new Error('sanitized remote failure') }],
      ['thrown Supabase failure', new Error('sanitized transport failure')],
    ])('reports %s as local-only without overstating remote termination', async (
      _name,
      outcome
    ) => {
      if (outcome instanceof Error) {
        mockSignOut.mockRejectedValue(outcome);
      } else {
        mockSignOut.mockResolvedValue(outcome);
      }
      const response = createResponse();

      await handler(createRequest(), response);

      expect(captureHttpContract(response)).toEqual(SIGNOUT_RESPONSE_FIXTURES.localOnly);
      expect(mockClearCsrfCookie).toHaveBeenCalledTimes(1);
      expect(response.setHeader.mock.calls.some(
        ([name]) => name.toLowerCase() === 'set-cookie'
      )).toBe(true);
    });

    it('never emits a legacy success envelope from the v2 route', async () => {
      const response = createResponse();

      await handler(createRequest(), response);

      const contract = captureHttpContract(response);
      expect(contract.body).not.toHaveProperty('data');
      expect(signoutHttpResponseSchema.safeParse(contract).success).toBe(true);
    });
  });
}
