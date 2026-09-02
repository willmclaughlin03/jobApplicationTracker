/**
 * Production/Vercel composition tests for GET /api/auth/session.
 *
 * Purpose: load the real route, middleware, source resolver, deployment secret
 * singleton, HMAC identity, shared ceiling, and Redis executor together while
 * replacing only external transports needed to keep the proof deterministic.
 */

const TEST_SOURCE = '203.0.113.86';
const TEST_SOCKET_SOURCE = '169.254.0.1';
const TEST_HMAC_KEY = Buffer.alloc(32, 8).toString('base64url');
const TEST_REDIS_URL = 'https://session-route-sentinel.upstash.io';
const TEST_REDIS_TOKEN = 'session-route-token-sentinel';
const TEST_KEY_ID = 'session-route-key-1';
const ENVIRONMENT_NAMES = [
  'NODE_ENV',
  'VERCEL',
  'TEMPORARY_SESSION_CEILING_SOURCE_MODE',
  'TEMPORARY_SESSION_CEILING_SECRET_MODE',
  'TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON',
  'TEMPORARY_SESSION_CEILING_UPSTASH_JSON',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CSRF_SECRET',
];

const mockRedisEvalsha = jest.fn();
const mockRedisEval = jest.fn();
const mockRedisConstructor = jest.fn();

jest.mock('@upstash/redis', () => ({
  Redis: mockRedisConstructor,
}));

const mockSupabaseGetUser = jest.fn();
const mockCreateServerClient = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args) => mockCreateServerClient(...args),
}));

const mockRequestLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
const mockRootLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockRequestLog),
};
const mockAttachRequestLogger = jest.fn((req) => {
  req.log = mockRequestLog;
  return 'production-session-request-id';
});

jest.mock('../../../../shared/logger.js', () => ({
  logger: mockRootLog,
  attachRequestLogger: mockAttachRequestLogger,
}));

/**
 * Restores one environment name without converting absence into `undefined`.
 *
 * @param {string} name environment variable name
 * @param {string|undefined} value original value
 * @returns {void}
 */
function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * Installs the exact production/Vercel configuration before module loading.
 *
 * Side effects: replaces only synthetic process environment values restored by
 * the enclosing test cleanup.
 *
 * @returns {void}
 */
function installProductionEnvironment() {
  process.env.NODE_ENV = 'production';
  process.env.VERCEL = '1';
  process.env.TEMPORARY_SESSION_CEILING_SOURCE_MODE = 'vercel';
  process.env.TEMPORARY_SESSION_CEILING_SECRET_MODE = 'vercel';
  process.env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON = JSON.stringify({
    schemaVersion: 1,
    active: {
      generation: 1,
      keyId: TEST_KEY_ID,
      key: TEST_HMAC_KEY,
    },
    previous: null,
  });
  process.env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON = JSON.stringify({
    schemaVersion: 1,
    url: TEST_REDIS_URL,
    token: TEST_REDIS_TOKEN,
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production-session.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'production-session-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'production-session-service-role-key';
  process.env.CSRF_SECRET = 'production-session-csrf-secret-at-least-32-characters';
}

/**
 * Creates a GET request with independently controlled normalized/raw metadata.
 *
 * @param {object} [options] trusted-header variants
 * @param {string|undefined} [options.normalizedSource=TEST_SOURCE] normalized header value
 * @param {string[]} [options.rawHeaders] alternating raw header metadata
 * @returns {{req: object, cookieRead: jest.Mock}} request and cookie-access probe
 */
function createMockRequest(options = {}) {
  const normalizedSource = Object.prototype.hasOwnProperty.call(options, 'normalizedSource')
    ? options.normalizedSource
    : TEST_SOURCE;
  const rawHeaders = options.rawHeaders ?? ['X-Vercel-Forwarded-For', TEST_SOURCE];
  const cookieRead = jest.fn(() => ({}));
  const req = {
    method: 'GET',
    headers: normalizedSource === undefined
      ? {}
      : { 'x-vercel-forwarded-for': normalizedSource },
    rawHeaders,
    socket: { remoteAddress: TEST_SOCKET_SOURCE },
  };
  Object.defineProperty(req, 'cookies', {
    enumerable: true,
    get: cookieRead,
  });
  return { req, cookieRead };
}

/**
 * Creates a Next.js response double with case-insensitive header storage.
 *
 * @returns {object} response-like object
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
 * Loads a fresh real route after the test has installed production state.
 *
 * @returns {Function} composed session route
 */
function loadSessionRoute() {
  return require('../../../../pages/api/auth/session.js').default;
}

/**
 * Serializes every captured application log call for sentinel assertions.
 *
 * @returns {string} deterministic log-call representation
 */
function serializeCapturedLogs() {
  return JSON.stringify([
    ...mockRootLog.info.mock.calls,
    ...mockRootLog.warn.mock.calls,
    ...mockRootLog.error.mock.calls,
    ...mockRootLog.debug.mock.calls,
    ...mockRequestLog.info.mock.calls,
    ...mockRequestLog.warn.mock.calls,
    ...mockRequestLog.error.mock.calls,
    ...mockRequestLog.debug.mock.calls,
  ]);
}

/**
 * Verifies that transient source/configuration/identity values never reach logs.
 *
 * @param {string[]} [additionalSentinels] derived values captured during a test
 * @returns {void}
 */
function expectSensitiveValuesAbsentFromLogs(additionalSentinels = []) {
  const serializedLogs = serializeCapturedLogs();
  for (const sentinel of [
    TEST_SOURCE,
    TEST_HMAC_KEY,
    TEST_REDIS_URL,
    TEST_REDIS_TOKEN,
    ...additionalSentinels,
  ]) {
    expect(serializedLogs).not.toContain(sentinel);
  }
}

/**
 * Verifies that the legacy generic limiter did not add quota headers.
 *
 * @param {object} res completed route response
 * @returns {void}
 */
function expectGenericRateLimitHeadersAbsent(res) {
  for (const name of [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-RateLimit-Window',
  ]) {
    expect(res.getHeader(name)).toBeUndefined();
  }
}

describe('/api/auth/session production/Vercel composition', () => {
  let originalEnvironment;

  beforeEach(() => {
    originalEnvironment = Object.fromEntries(
      ENVIRONMENT_NAMES.map((name) => [name, process.env[name]])
    );
    jest.resetModules();
    jest.clearAllMocks();
    installProductionEnvironment();
    mockRedisEvalsha.mockResolvedValue([1, 0, 0]);
    mockRedisEval.mockResolvedValue([1, 0, 0]);
    mockRedisConstructor.mockImplementation(function MockRedis() {
      this.evalsha = mockRedisEvalsha;
      this.eval = mockRedisEval;
    });
    mockSupabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockCreateServerClient.mockReturnValue({
      auth: { getUser: mockSupabaseGetUser },
    });
  });

  afterEach(() => {
    for (const name of ENVIRONMENT_NAMES) {
      restoreEnvironmentVariable(name, originalEnvironment[name]);
    }
    jest.restoreAllMocks();
  });

  /**
   * A singleton Vercel source must traverse the complete production composition.
   */
  it('reaches the handler through the real shared ceiling and skips generic AUTH', async () => {
    const sessionRoute = loadSessionRoute();
    const { req } = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: { user: null },
      error: null,
      message: 'Success',
    });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    expect(mockSupabaseGetUser).toHaveBeenCalledTimes(1);
    expect(mockRedisConstructor).toHaveBeenCalledTimes(1);
    expect(mockRedisEvalsha).toHaveBeenCalledTimes(1);
    expect(mockRedisEval).not.toHaveBeenCalled();
    const redisIdentifier = mockRedisEvalsha.mock.calls[0][1][0];
    expect(redisIdentifier).toMatch(/^tsc:v1:g1:session-route-key-1:[A-Za-z0-9_-]{43}$/);
    expect(mockRedisEvalsha).toHaveBeenCalledWith(expect.any(String), [redisIdentifier], []);
    expectGenericRateLimitHeadersAbsent(res);
    expectSensitiveValuesAbsentFromLogs([redisIdentifier]);
  });

  /**
   * Missing or duplicate provider metadata must fail before any downstream work.
   */
  it.each([
    [
      'missing header',
      { normalizedSource: undefined, rawHeaders: [] },
    ],
    [
      'duplicate raw header',
      {
        normalizedSource: TEST_SOURCE,
        rawHeaders: [
          'X-Vercel-Forwarded-For', TEST_SOURCE,
          'x-vercel-forwarded-for', TEST_SOURCE,
        ],
      },
    ],
  ])('fails closed for a %s before cookies, Redis, or Supabase', async (_caseName, options) => {
    const sessionRoute = loadSessionRoute();
    const { req, cookieRead } = createMockRequest(options);
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
    expect(res.getHeader('Retry-After')).toBeUndefined();
    expect(cookieRead).not.toHaveBeenCalled();
    expect(mockRedisConstructor).not.toHaveBeenCalled();
    expect(mockRedisEvalsha).not.toHaveBeenCalled();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockSupabaseGetUser).not.toHaveBeenCalled();
    expectSensitiveValuesAbsentFromLogs();
  });

  /**
   * Malformed deployed JSON must be rejected by the real singleton before cookies.
   */
  it.each([
    [
      'HMAC keyring JSON',
      'TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON',
      `{"schemaVersion":1,"active":{"key":"${TEST_HMAC_KEY}"`,
    ],
    [
      'Upstash JSON',
      'TEMPORARY_SESSION_CEILING_UPSTASH_JSON',
      `{"schemaVersion":1,"url":"${TEST_REDIS_URL}","token":"${TEST_REDIS_TOKEN}"`,
    ],
  ])('fails closed for malformed %s before cookies or Supabase', async (
    _caseName,
    environmentName,
    malformedValue
  ) => {
    process.env[environmentName] = malformedValue;
    const sessionRoute = loadSessionRoute();
    const { req, cookieRead } = createMockRequest();
    const res = createMockResponse();

    await sessionRoute(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
    expect(res.getHeader('Retry-After')).toBeUndefined();
    expect(cookieRead).not.toHaveBeenCalled();
    expect(mockRedisConstructor).not.toHaveBeenCalled();
    expect(mockRedisEvalsha).not.toHaveBeenCalled();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockSupabaseGetUser).not.toHaveBeenCalled();
    expectSensitiveValuesAbsentFromLogs();
  });
});
