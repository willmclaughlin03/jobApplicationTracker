/**
 * Integration tests for the composed GET /api/auth/session v1 route.
 *
 * Purpose: exercise the real default export, real withRateLimit middleware,
 * route-owned cache wrapper, temporary-ceiling boundary, ordinary Redis path,
 * and legacy handler contracts without introducing future v2 behavior.
 *
 * Connects to: src/pages/api/auth/session.js
 */

const mockGetUser = jest.fn();
const mockCreateApiRouteClient = jest.fn(() => ({
  auth: { getUser: mockGetUser },
}));
jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: (...args) => mockCreateApiRouteClient(...args),
}));

const mockGetUserFromRequest = jest.fn();
jest.mock('../../../../server/lib/supabaseServer.js', () => ({
  AUTH_ERROR_CODES: {
    AUTH_INVALID: 'AUTH_INVALID',
    AUTH_NOT_FOUND: 'AUTH_NOT_FOUND',
    AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  },
  getUserFromRequest: mockGetUserFromRequest,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../../../server/lib/rateLimit.js', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

const mockValidateCsrfToken = jest.fn(() => true);
jest.mock('../../../../server/lib/csrf.js', () => ({
  validateCsrfToken: mockValidateCsrfToken,
}));

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
const mockAttachRequestLogger = jest.fn((req) => {
  req.log = mockLog;
  return 'session-request-id';
});
jest.mock('../../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mockLog),
  },
  attachRequestLogger: mockAttachRequestLogger,
}));

const sessionRoute = require('../../../../pages/api/auth/session.js').default;
const {
  temporarySessionCeiling,
} = require('../../../../server/lib/temporarySessionCeiling.js');
const {
  sessionResponseSchema,
} = require('../../../../testSupport/authV2ContractFixtures.js');

let sourceSequence = 1;

/**
 * Creates one local request with a unique default source address.
 *
 * Purpose: the production ceiling is intentionally process-local and has no
 * reset hook, so unrelated route tests must not share an accidental allowance.
 *
 * @param {string} [method='GET'] - HTTP method.
 * @param {string} [remoteAddress] - Explicit local socket source when required.
 * @returns {object} Next.js request-like object.
 */
function createMockRequest(method = 'GET', remoteAddress = null) {
  const source = remoteAddress ?? `192.0.2.${sourceSequence++}`;
  return {
    method,
    headers: {},
    rawHeaders: [],
    cookies: {},
    socket: { remoteAddress: source },
  };
}

/**
 * Creates a response double that records effective headers and completion.
 *
 * Purpose: the real middleware validates that a route writer actually commits
 * its response, while assertions need case-insensitive access to final headers.
 *
 * @returns {object} Next.js response-like object.
 */
function createMockResponse() {
  const headers = new Map();
  const res = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    finished: false,
  };

  res.setHeader = jest.fn((name, value) => {
    headers.set(String(name).toLowerCase(), value);
    return res;
  });
  res.getHeader = jest.fn((name) => headers.get(String(name).toLowerCase()));
  res.removeHeader = jest.fn((name) => {
    headers.delete(String(name).toLowerCase());
  });
  res.status = jest.fn((statusCode) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    return res;
  });
  res.end = jest.fn(() => {
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    return res;
  });

  return res;
}

/**
 * Verifies the route-owned private cache contract on one response.
 *
 * @param {object} res - Completed response double.
 * @returns {void}
 */
function expectPrivateNoStore(res) {
  expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  expect(res.setHeader.mock.calls[0]).toEqual(['Cache-Control', 'private, no-store']);
}

/**
 * Verifies that a response remains outside the frozen future-v2 envelope.
 *
 * @param {object} body - Legacy response body.
 * @returns {void}
 */
function expectLegacyV1Body(body) {
  expect(sessionResponseSchema.safeParse(body).success).toBe(false);
  expect(body).not.toHaveProperty('version');
  expect(body).not.toHaveProperty('status');
}

describe('/api/auth/session composed v1 route', () => {
  let ceilingEvaluateSpy;

  const mockUser = {
    id: 'user-session-123',
    email: 'test@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Test' },
    aud: 'authenticated',
    role: 'authenticated',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ceilingEvaluateSpy = jest
      .spyOn(temporarySessionCeiling, 'evaluate')
      .mockReturnValue({ allowed: true });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 15,
      remaining: 14,
      reset: Date.now() + 60_000,
      window: 'hourly',
    });
    mockValidateCsrfToken.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * OPTIONS and unsupported methods retain the legacy 405 before the ceiling.
   */
  it.each(['OPTIONS', 'POST'])('returns the legacy 405 for %s', async (method) => {
    const req = createMockRequest(method);
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({
      data: null,
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
    });
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(ceilingEvaluateSpy).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
  });

  /**
   * The route supplies the bounded v1 label and attached request logger.
   */
  it('attaches the v1 ceiling before ordinary Redis and Supabase work', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(ceilingEvaluateSpy).toHaveBeenCalledWith(req, {
      routeVersion: 'v1',
      logger: mockLog,
    });
    expect(ceilingEvaluateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mockCheckRateLimit.mock.invocationCallOrder[0]
    );
    expect(mockCheckRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateApiRouteClient.mock.invocationCallOrder[0]
    );
    expectPrivateNoStore(res);
  });

  /**
   * The real production singleton accepts requests 1-400 and rejects request 401.
   */
  it('returns the legacy bounded 429 on real ceiling request 401', async () => {
    ceilingEvaluateSpy.mockRestore();
    const sharedSource = '198.51.100.200';
    let firstResponse;

    for (let requestNumber = 1; requestNumber <= 400; requestNumber += 1) {
      const res = createMockResponse();
      await sessionRoute(createMockRequest('GET', sharedSource), res);
      if (requestNumber === 1) firstResponse = res;
      expect(res.statusCode).toBe(200);
    }

    const cookieRead = jest.fn(() => ({}));
    const rejectedRequest = createMockRequest('GET', sharedSource);
    Object.defineProperty(rejectedRequest, 'cookies', { get: cookieRead });
    const rejectedResponse = createMockResponse();

    await sessionRoute(rejectedRequest, rejectedResponse);

    const responseLogCallIndex = mockLog.warn.mock.calls.findIndex(
      ([fields]) => fields?.event === 'temporary_session_ceiling_response'
    );
    const retryAfterHeaderCallIndex = rejectedResponse.setHeader.mock.calls.findIndex(
      ([name]) => name === 'Retry-After'
    );

    expect(rejectedResponse.statusCode).toBe(429);
    expect(rejectedResponse.body).toEqual({
      data: null,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded. Please try again later.',
    });
    expect(rejectedResponse.getHeader('Retry-After')).toEqual(expect.any(Number));
    expect(rejectedResponse.getHeader('Retry-After')).toBeGreaterThanOrEqual(1);
    expect(rejectedResponse.getHeader('Retry-After')).toBeLessThanOrEqual(60);
    expect(mockLog.warn).toHaveBeenCalledWith({
      event: 'temporary_session_ceiling_response',
      reason: 'limit_exceeded',
      statusCode: 429,
    }, 'Temporary session ceiling rejected request');
    expect(mockLog.warn.mock.invocationCallOrder[responseLogCallIndex]).toBeLessThan(
      rejectedResponse.setHeader.mock.invocationCallOrder[retryAfterHeaderCallIndex]
    );
    expectPrivateNoStore(firstResponse);
    expectPrivateNoStore(rejectedResponse);
    expectLegacyV1Body(rejectedResponse.body);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(400);
    expect(mockCreateApiRouteClient).toHaveBeenCalledTimes(400);
    expect(mockGetUser).toHaveBeenCalledTimes(400);
    expect(cookieRead).not.toHaveBeenCalled();
  });

  /**
   * Every validated unavailable reason maps to one retry-free legacy 503.
   */
  it.each([
    ['source_unavailable', { allowed: false, statusCode: 503, reason: 'source_unavailable' }],
    ['internal_failure', { allowed: false, statusCode: 503, reason: 'internal_failure' }],
    ['state_capacity', { allowed: false, statusCode: 503, reason: 'state_capacity' }],
  ])('maps the %s reason to the legacy unavailable response', async (_reason, decision) => {
    ceilingEvaluateSpy.mockReturnValue(decision);
    const req = createMockRequest();
    const cookieRead = jest.fn(() => ({}));
    Object.defineProperty(req, 'cookies', { get: cookieRead });
    const res = createMockResponse();

    await sessionRoute(req, res);

    const responseLogCallIndex = mockLog.warn.mock.calls.findIndex(
      ([fields]) => fields?.event === 'temporary_session_ceiling_response'
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      data: null,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again later.',
    });
    expect(res.getHeader('Retry-After')).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith({
      event: 'temporary_session_ceiling_response',
      reason: decision.reason,
      statusCode: decision.statusCode,
    }, 'Temporary session ceiling rejected request');
    expect(mockLog.warn.mock.invocationCallOrder[responseLogCallIndex]).toBeLessThan(
      res.removeHeader.mock.invocationCallOrder[0]
    );
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(cookieRead).not.toHaveBeenCalled();
  });

  /**
   * Out-of-contract rejection details cannot create a speculative 429 delay.
   */
  it.each([
    null,
    { allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 61 },
    { allowed: false, statusCode: 429, reason: 'unexpected_reason', retryAfterSeconds: 30 },
  ])('maps malformed ceiling output %# to a retry-free legacy 503', async (decision) => {
    ceilingEvaluateSpy.mockReturnValue(decision);
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
    expect(res.getHeader('Retry-After')).toBeUndefined();
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
  });

  /**
   * A ceiling allow proceeds into the existing public AUTH Redis check.
   */
  it('preserves ordinary Redis enforcement after a ceiling allow', async () => {
    const req = createMockRequest('GET', '203.0.113.10');
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.10', 'free', 'auth');
    expect(mockCreateApiRouteClient).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(200);
    expectPrivateNoStore(res);
  });

  /**
   * Existing Redis exhaustion keeps its current headers, copy, and short circuit.
   */
  it('preserves the ordinary Redis 429 response', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 15,
      remaining: 0,
      reset: 1_030_000,
      window: 'hourly',
    });
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      data: null,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded. Try again in 30 seconds.',
    });
    expect(res.getHeader('Retry-After')).toBe(30);
    expect(res.getHeader('X-RateLimit-Limit')).toBe(15);
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
  });

  /**
   * Existing Redis unavailability remains a legacy retry-free 503.
   */
  it('preserves the ordinary Redis unavailable response', async () => {
    mockCheckRateLimit.mockResolvedValue({ success: false, unavailable: true });
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      data: null,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again later.',
    });
    expect(res.getHeader('Retry-After')).toBeUndefined();
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
  });

  /**
   * Authenticated responses expose only the existing safe v1 user fields.
   */
  it('preserves the authenticated v1 response and trusted application role', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...mockUser,
          app_metadata: { ...mockUser.app_metadata, role: 'admin' },
        },
      },
      error: null,
    });
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: {
        user: {
          id: 'user-session-123',
          email: 'test@example.com',
          role: 'admin',
        },
      },
      error: null,
      message: 'Success',
    });
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('app_metadata');
    expect(serialized).not.toContain('user_metadata');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
  });

  /**
   * Missing users and provider-declared errors remain anonymous in legacy v1.
   */
  it.each([
    ['missing user', { data: { user: null }, error: null }],
    ['provider error', { data: { user: null }, error: { message: 'invalid JWT' } }],
  ])('preserves the anonymous v1 response for %s', async (_name, providerResult) => {
    mockGetUser.mockResolvedValue(providerResult);
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: { user: null },
      error: null,
      message: 'Success',
    });
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
  });

  /**
   * Handler exceptions retain the legacy unavailable response and safe logging.
   */
  it('preserves the handler-error 503 contract', async () => {
    const handlerError = new Error('provider connection refused');
    mockGetUser.mockRejectedValue(handlerError);
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      data: null,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again later.',
    });
    expect(mockLog.error).toHaveBeenCalledWith({ err: handlerError }, 'Session check failed');
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
  });
});
