/**
 * Integration tests for the composed GET /api/auth/session v1 route.
 *
 * Purpose: exercise the real default export, real withRateLimit middleware,
 * route-owned cache wrapper, shared-ceiling boundary, session-only generic
 * AUTH skip, and legacy handler contracts without future v2 behavior.
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
  createGate1RestartProbe,
  gate1RestartProbe,
  GATE1_RESTART_PROBE_HEADER,
  GATE1_RESTART_DIAGNOSTIC_HEADER,
} = require('../../../../server/lib/gate1RestartProbe.js');
const {
  sessionResponseSchema,
} = require('../../../../testSupport/authV2ContractFixtures.js');

let sourceSequence = 1;

/**
 * Creates one local request with a unique default source address.
 *
 * Purpose: each route test uses a documentation-reserved synthetic source.
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
 * Verifies the intentional absence of all legacy generic Redis quota headers.
 *
 * @param {object} res completed response double
 * @returns {void}
 */
function expectLegacyRateLimitHeadersAbsent(res) {
  for (const name of [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-RateLimit-Window',
  ]) {
    expect(res.getHeader(name)).toBeUndefined();
  }
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

/**
 * Simulates a request-scoped warning transport failure.
 *
 * Purpose: route writers must remain response-safe even when warning telemetry
 * is unavailable.
 *
 * @throws {Error} Always throws the fixed test failure.
 */
function throwTestWarningFailure() {
  throw new Error('test warning logger failure');
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
    mockLog.warn.mockReset();
    jest.spyOn(gate1RestartProbe, 'attach').mockImplementation(
      createGate1RestartProbe({ env: {} }).attach
    );
    ceilingEvaluateSpy = jest
      .spyOn(temporarySessionCeiling, 'evaluate')
      .mockResolvedValue({ allowed: true });
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
  it('attaches the v1 ceiling before the session-only skip and Supabase work', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(ceilingEvaluateSpy).toHaveBeenCalledWith(req, {
      routeVersion: 'v1',
      logger: mockLog,
    });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(ceilingEvaluateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateApiRouteClient.mock.invocationCallOrder[0]
    );
    expectPrivateNoStore(res);
    expectLegacyRateLimitHeadersAbsent(res);
  });

  /**
   * A shared-ceiling rejection short-circuits cookies, Redis, and Supabase.
   */
  it('returns the legacy bounded 429 for shared request 401', async () => {
    ceilingEvaluateSpy.mockResolvedValue({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    });
    const cookieRead = jest.fn(() => ({}));
    const rejectedRequest = createMockRequest();
    Object.defineProperty(rejectedRequest, 'cookies', { get: cookieRead });
    const rejectedResponse = createMockResponse();

    await sessionRoute(rejectedRequest, rejectedResponse);

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
    expect(retryAfterHeaderCallIndex).toBeGreaterThanOrEqual(0);
    expectPrivateNoStore(rejectedResponse);
    expectLegacyV1Body(rejectedResponse.body);
    expectLegacyRateLimitHeadersAbsent(rejectedResponse);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
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
    ceilingEvaluateSpy.mockResolvedValue(decision);
    const req = createMockRequest();
    const cookieRead = jest.fn(() => ({}));
    Object.defineProperty(req, 'cookies', { get: cookieRead });
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
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(cookieRead).not.toHaveBeenCalled();
  });

  /**
   * An asynchronous ceiling failure must fail closed before downstream work.
   */
  it('maps a rejected ceiling evaluation to the retry-free legacy 503', async () => {
    ceilingEvaluateSpy.mockRejectedValue(new Error('shared ceiling unavailable'));
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
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  /**
   * A throwing warning logger cannot replace a validated ceiling response.
   */
  it.each([
    [
      '429',
      { allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 30 },
      429,
      {
        data: null,
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded. Please try again later.',
      },
      30,
    ],
    [
      '503',
      { allowed: false, statusCode: 503, reason: 'internal_failure' },
      503,
      {
        data: null,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.',
      },
      undefined,
    ],
  ])('preserves the exact %s response when req.log.warn throws', async (
    _description,
    decision,
    expectedStatus,
    expectedBody,
    expectedRetryAfter
  ) => {
    mockLog.warn.mockImplementation(throwTestWarningFailure);
    ceilingEvaluateSpy.mockResolvedValue(decision);
    const req = createMockRequest();
    const cookieRead = jest.fn(() => ({}));
    Object.defineProperty(req, 'cookies', { get: cookieRead });
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(expectedStatus);
    expect(res.body).toEqual(expectedBody);
    expect(res.getHeader('Retry-After')).toBe(expectedRetryAfter);
    expectPrivateNoStore(res);
    expectLegacyV1Body(res.body);
    expect(mockLog.warn).not.toHaveBeenCalled();
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
    ceilingEvaluateSpy.mockResolvedValue(decision);
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
   * A ceiling allow skips the legacy public AUTH Redis check.
   */
  it('skips generic AUTH and omits all four legacy quota headers after an allow', async () => {
    const req = createMockRequest('GET', '203.0.113.10');
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateApiRouteClient).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(200);
    expectPrivateNoStore(res);
    expectLegacyRateLimitHeadersAbsent(res);
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
    expectLegacyRateLimitHeadersAbsent(res);
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
    expectLegacyRateLimitHeadersAbsent(res);
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
    expectLegacyRateLimitHeadersAbsent(res);
    expectLegacyV1Body(res.body);
  });

  /**
   * Runs the real observational probe alongside the real composed session route.
   */
  describe.each(['preview', 'production'])('approved %s runtime diagnostics', (deploymentEnvironment) => {
    // Synthetic fixture only; no deployed credentials or process configuration are used.
    const probeSecret = 'b'.repeat(64);
    const authorization = `Bearer ${probeSecret}`;
    const diagnosticLogger = { info: jest.fn() };

    /**
     * Installs the real probe for the current synthetic Vercel deployment target.
     * @param {object} [options] runtime/configuration failure seams for composed tests
     * @returns {void} replaces only the probe dependencies, not its implementation
     */
    function installDeploymentProbe(options = {}) {
      gate1RestartProbe.attach.mockImplementation(createGate1RestartProbe({
        env: {
          VERCEL: '1',
          VERCEL_ENV: deploymentEnvironment,
          NODE_ENV: 'production',
          GATE1_RESTART_PROBE_ENABLED: 'true',
          GATE1_RESTART_PROBE_SECRET: probeSecret,
        },
        logger: diagnosticLogger,
        ...options,
      }).attach);
    }

    /**
     * Adds the dedicated credential to a standard synthetic session request.
     * @param {string} [method='GET'] route method under test
     * @returns {object} request with matching raw and normalized authorization
     */
    function createProbeRequest(method = 'GET') {
      const req = createMockRequest(method);
      req.headers.authorization = authorization;
      req.rawHeaders = ['Authorization', authorization];
      return req;
    }

    /**
     * Opts one synthetic GET into outcome logs without changing probe authentication.
     * @returns {object} request with a public marker and the normal dedicated credential
     */
    function createMarkedProbeRequest() {
      const req = createProbeRequest();
      req.headers[GATE1_RESTART_DIAGNOSTIC_HEADER] = '1';
      req.rawHeaders.push(GATE1_RESTART_DIAGNOSTIC_HEADER, '1');
      return req;
    }

    beforeEach(installDeploymentProbe);

    /**
     * A diagnostic GET still consumes exactly one shared decision and returns legacy v1.
     */
    it('adds runtime metadata while preserving anonymity, quota, and no-cookie behavior', async () => {
      const req = createProbeRequest();
      const res = createMockResponse();
      await sessionRoute(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ data: { user: null }, error: null, message: 'Success' });
      expect(JSON.parse(res.getHeader(GATE1_RESTART_PROBE_HEADER))).toMatchObject({
        schemaVersion: 1,
        contextScope: 'module',
        nodeVersion: process.version,
      });
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expect(ceilingEvaluateSpy).toHaveBeenCalledWith(req, { routeVersion: 'v1', logger: mockLog });
      expect(ceilingEvaluateSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateApiRouteClient.mock.invocationCallOrder[0]
      );
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expectPrivateNoStore(res);
      expectLegacyRateLimitHeadersAbsent(res);
      expect(diagnosticLogger.info).not.toHaveBeenCalled();
      expect(JSON.stringify([res.body, res.setHeader.mock.calls, mockLog.info.mock.calls,
        mockLog.warn.mock.calls, mockLog.error.mock.calls])).not.toContain(probeSecret);
    });

    /**
     * Diagnostics remain present on limiter failures without reaching cookies or Supabase.
     */
    it.each([
      [{ allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 30 }, 429],
      [{ allowed: false, statusCode: 503, reason: 'source_unavailable' }, 503],
    ])('preserves the ceiling decision %# and its diagnostic header', async (decision, status) => {
      ceilingEvaluateSpy.mockResolvedValue(decision);
      const req = createProbeRequest();
      const cookieRead = jest.fn(() => { throw new Error('must not read cookies'); });
      Object.defineProperty(req, 'cookies', { get: cookieRead });
      const res = createMockResponse();
      await sessionRoute(req, res);

      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(status === 429 ? {
        data: null, error: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded. Please try again later.',
      } : {
        data: null, error: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.',
      });
      expect(res.getHeader('Retry-After')).toBe(status === 429 ? 30 : undefined);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toEqual(expect.any(String));
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
      expect(cookieRead).not.toHaveBeenCalled();
      expectPrivateNoStore(res);
      expectLegacyRateLimitHeadersAbsent(res);
    });

    /**
     * A provider failure still produces the ordinary retry-free unavailable response.
     */
    it('preserves a handler 503 after authenticated diagnostic observation', async () => {
      mockGetUser.mockRejectedValue(new Error('provider unavailable'));
      const res = createMockResponse();
      await sessionRoute(createProbeRequest(), res);
      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
      expect(res.getHeader('Retry-After')).toBeUndefined();
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toEqual(expect.any(String));
      expectPrivateNoStore(res);
    });

    /**
     * Existing identity and refresh cookies survive an authorized diagnostic request.
     */
    it('preserves authenticated identity and cookie writes from the existing session client', async () => {
      const cookie = 'synthetic-session=fixture; HttpOnly; Secure; SameSite=Lax; Path=/';
      mockCreateApiRouteClient.mockImplementationOnce((_req, res) => {
        res.setHeader('Set-Cookie', [cookie]);
        return { auth: { getUser: mockGetUser } };
      });
      mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
      const res = createMockResponse();
      await sessionRoute(createProbeRequest(), res);
      expect(res.body.data.user).toEqual({
        id: mockUser.id, email: mockUser.email, role: 'user',
      });
      expect(res.getHeader('Set-Cookie')).toEqual([cookie]);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).not.toContain(cookie);
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expectPrivateNoStore(res);
    });

    /**
     * Missing/invalid probe authorization omits metadata without changing ordinary access.
     */
    it.each([undefined, `Bearer ${'c'.repeat(64)}`])('preserves a normal request %#', async (value) => {
      const req = createProbeRequest();
      req.headers.authorization = value;
      req.rawHeaders = value === undefined ? [] : ['Authorization', value];
      const res = createMockResponse();
      await sessionRoute(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expect(mockCreateApiRouteClient).toHaveBeenCalledTimes(1);
      expectPrivateNoStore(res);
    });

    /**
     * Both targets must explicitly enable diagnostics even with a valid credential.
     */
    it.each([undefined, 'false', 'TRUE'])('preserves ordinary access with disabled opt-in %#', async (flag) => {
      installDeploymentProbe({ env: {
        VERCEL: '1', VERCEL_ENV: deploymentEnvironment, NODE_ENV: 'production',
        GATE1_RESTART_PROBE_ENABLED: flag, GATE1_RESTART_PROBE_SECRET: probeSecret,
      } });
      const res = createMockResponse();
      await sessionRoute(createProbeRequest(), res);
      expect(res.statusCode).toBe(200);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expectPrivateNoStore(res);
    });

    /**
     * Diagnostic authorization cannot turn unsupported methods into quota-consuming GETs.
     */
    it.each(['POST', 'OPTIONS', 'HEAD'])('preserves method rejection for %s', async (method) => {
      const res = createMockResponse();
      await sessionRoute(createProbeRequest(method), res);
      expect(res.statusCode).toBe(405);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toBeUndefined();
      expect(ceilingEvaluateSpy).not.toHaveBeenCalled();
      expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
      expectPrivateNoStore(res);
    });

    /**
     * Observational failure cannot skip the real ceiling or turn its rejection into a 200.
     */
    it('retains enforcement when runtime observation throws', async () => {
      installDeploymentProbe({ readRuntime: () => { throw new Error('private probe failure'); } });
      ceilingEvaluateSpy.mockResolvedValue({
        allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 10,
      });
      const res = createMockResponse();
      await sessionRoute(createProbeRequest(), res);
      expect(res.statusCode).toBe(429);
      expect(res.getHeader('Retry-After')).toBe(10);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
      expect(mockLog.error).not.toHaveBeenCalled();
      expectPrivateNoStore(res);
    });

    /** Marking a request cannot grant metadata when the existing credential checks reject it. */
    it.each(['authorization_missing', 'raw_header_mismatch', 'raw_authorization_duplicate'])(
      'preserves ordinary access and internally records %s', async (outcome) => {
        const req = createMarkedProbeRequest();
        if (outcome === 'authorization_missing') delete req.headers.authorization;
        if (outcome === 'raw_header_mismatch') req.rawHeaders[1] = `Bearer ${'c'.repeat(64)}`;
        if (outcome === 'raw_authorization_duplicate') req.rawHeaders.push('Authorization', authorization);
        const res = createMockResponse();
        await sessionRoute(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ data: { user: null }, error: null, message: 'Success' });
        expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toBeUndefined();
        expect(res.getHeader('Set-Cookie')).toBeUndefined();
        expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
        expect(mockCreateApiRouteClient).toHaveBeenCalledTimes(1);
        expect(diagnosticLogger.info.mock.calls).toEqual([
          [{ event: 'gate1_restart_probe_outcome', outcome }, 'GATE-1 restart probe diagnostic'],
        ]);
        expectPrivateNoStore(res);
      }
    );

    /** Consecutive marked observations still traverse the quota while outcome logging stays bounded. */
    it('logs attachment once while preserving both marked session exchanges', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = createMockResponse();
        await sessionRoute(createMarkedProbeRequest(), res);
        expect(res.statusCode).toBe(200);
        expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toEqual(expect.any(String));
        expect(res.getHeader('Set-Cookie')).toBeUndefined();
        expectPrivateNoStore(res);
      }
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(2);
      expect(diagnosticLogger.info.mock.calls).toEqual([
        [{ event: 'gate1_restart_probe_outcome', outcome: 'header_attached' }, 'GATE-1 restart probe diagnostic'],
      ]);
    });

    /** Failed diagnostic logging cannot turn an allow, rejection, or outage into another route result. */
    it.each([
      [{ allowed: true }, 200],
      [{ allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 10 }, 429],
      [{ allowed: false, statusCode: 503, reason: 'source_unavailable' }, 503],
    ])('contains logging failure while retaining response %#', async (decision, status) => {
      /** Simulate a logger failure without exposing its exception to the route or response. */
      function failDiagnosticLog() { throw new Error('private-log-failure'); }
      installDeploymentProbe({ logger: { info: failDiagnosticLog } });
      ceilingEvaluateSpy.mockResolvedValue(decision);
      const res = createMockResponse();
      await sessionRoute(createMarkedProbeRequest(), res);
      expect(res.statusCode).toBe(status);
      expect(res.getHeader(GATE1_RESTART_PROBE_HEADER)).toEqual(expect.any(String));
      expect(res.getHeader('Retry-After')).toBe(status === 429 ? 10 : undefined);
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
      expect(ceilingEvaluateSpy).toHaveBeenCalledTimes(1);
      expect(mockCreateApiRouteClient).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expectPrivateNoStore(res);
      expect(JSON.stringify(res.body)).not.toContain('private-log-failure');
    });
  });
});
