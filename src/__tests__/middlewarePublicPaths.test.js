/**
 * Tests for middleware page-route classification and protected cookie handling.
 *
 * Purpose: prove public and unmatched pages avoid all Supabase work while known
 * protected pages retain auth gating, private cache policy, and refresh cookies.
 *
 * Connects to: src/middleware.js
 */

const mockCreateServerClient = jest.fn();
const mockGetUser = jest.fn();
const mockNext = jest.fn();
const mockRedirect = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args) => mockCreateServerClient(...args),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    next: (...args) => mockNext(...args),
    redirect: (...args) => mockRedirect(...args),
  },
}));

const {
  ROUTE_POLICY,
  classifyRoutePolicy,
  config,
  isPublicPath,
  middleware,
} = require('../middleware.js');
const { ERROR_STATUS_CODES } = require('../shared/constants/errorStatusCodes.js');
const {
  MIDDLEWARE_PROBE_KEY_HEADER,
  MIDDLEWARE_PROBE_CHALLENGE_HEADER,
  MIDDLEWARE_PROBE_RESPONSE_HEADER,
} = require('../server/lib/gate1MiddlewareRuntimeProbe.js');

/**
 * Builds a minimal observable NextResponse substitute for middleware tests.
 *
 * Purpose: record cache and cookie mutations without relying on Next.js runtime
 * internals, while retaining the selected next-or-redirect response identity.
 *
 * @param {'next'|'redirect'} kind - Final response type.
 * @param {object|null} destination - Redirect URL clone when applicable.
 * @returns {object} Response mock with Headers-like and cookies-like adapters.
 */
function createMockNextResponse(kind, destination = null) {
  const headerValues = new Map();
  return {
    kind,
    destination,
    headers: {
      set: jest.fn((name, value) => headerValues.set(name.toLowerCase(), value)),
      get: jest.fn((name) => headerValues.get(name.toLowerCase())),
      delete: jest.fn((name) => headerValues.delete(name.toLowerCase())),
    },
    cookies: {
      set: jest.fn(),
    },
  };
}

/**
 * Builds a mutable middleware request for one page pathname.
 *
 * Purpose: expose observable request-cookie updates and URL cloning used by
 * protected redirects without including unrelated NextRequest behavior.
 *
 * @param {string} pathname - Page pathname under test.
 * @param {Array<{name: string, value: string}>} initialCookies - Initial cookies.
 * @returns {object} Minimal NextRequest-compatible object.
 */
function createMockRequest(pathname, initialCookies = []) {
  const cookieValues = new Map(initialCookies.map(({ name, value }) => [name, value]));
  const requestCookies = {
    getAll: jest.fn(() => Array.from(cookieValues, ([name, value]) => ({ name, value }))),
    set: jest.fn((name, value) => cookieValues.set(name, value)),
  };

  return {
    method: 'GET',
    url: `https://example.test${pathname}`,
    headers: new Headers(),
    cookies: requestCookies,
    nextUrl: {
      pathname,
      search: '',
      clone: jest.fn(() => ({ pathname })),
    },
  };
}

describe('middleware route policy', () => {
  /** Check all final mocked branches, including public bypass, for CDN policy. */
  afterEach(() => {
    for (const result of [...mockNext.mock.results, ...mockRedirect.mock.results]) {
      if (result.type !== 'return' || !result.value?.headers) continue;
      const headers = result.value.headers;
      const expected = headers.get('Cache-Control') ? 'no-store' : undefined;
      expect(headers.get('CDN-Cache-Control')).toBe(expected);
      expect(headers.get('Vercel-CDN-Cache-Control')).toBe(expected);
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } });
    mockCreateServerClient.mockImplementation(() => ({
      auth: { getUser: mockGetUser },
    }));
    mockNext.mockImplementation(() => createMockNextResponse('next'));
    mockRedirect.mockImplementation((destination) => (
      createMockNextResponse('redirect', destination)
    ));
  });

  it('classifies exact public pages without widening segment boundaries', () => {
    expect(classifyRoutePolicy('/login')).toBe(ROUTE_POLICY.PUBLIC);
    expect(classifyRoutePolicy('/auth/callback')).toBe(ROUTE_POLICY.PUBLIC);
    ERROR_STATUS_CODES.forEach((statusCode) => {
      expect(classifyRoutePolicy(`/${statusCode}`)).toBe(ROUTE_POLICY.PUBLIC);
    });

    expect(classifyRoutePolicy('/429/details')).toBe(ROUTE_POLICY.UNMATCHED);
    expect(classifyRoutePolicy('/auth/callback-extra')).toBe(ROUTE_POLICY.UNMATCHED);
    expect(isPublicPath('/403')).toBe(true);
    expect(isPublicPath('/403/details')).toBe(false);
  });

  it('classifies only the dashboard and exact protected namespaces as protected', () => {
    expect(classifyRoutePolicy('/')).toBe(ROUTE_POLICY.PROTECTED);
    expect(classifyRoutePolicy('/admin')).toBe(ROUTE_POLICY.PROTECTED);
    expect(classifyRoutePolicy('/admin/users')).toBe(ROUTE_POLICY.PROTECTED);
    expect(classifyRoutePolicy('/billing')).toBe(ROUTE_POLICY.PROTECTED);
    expect(classifyRoutePolicy('/billing/example')).toBe(ROUTE_POLICY.PROTECTED);
    expect(classifyRoutePolicy('/administrator')).toBe(ROUTE_POLICY.UNMATCHED);
    expect(classifyRoutePolicy('/billing-example')).toBe(ROUTE_POLICY.UNMATCHED);
  });

  it.each([
    '/login',
    '/auth/callback',
    '/403',
    '/404',
    '/429',
    '/500',
    '/502',
    '/503',
    '/504',
  ])('bypasses Supabase for exact public path %s', async (pathname) => {
    const req = createMockRequest(pathname);
    const response = await middleware(req);

    expect(response.kind).toBe('next');
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(req.cookies.getAll).not.toHaveBeenCalled();
    expect(req.cookies.set).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBeUndefined();
    expect(response.cookies.set).not.toHaveBeenCalled();
  });

  it.each([
    '/route-that-does-not-exist',
    '/administrator',
    '/billing-example',
    '/429/details',
    '/auth/callback-extra',
  ])('lets unmatched path %s continue to Next.js without auth work', async (pathname) => {
    const req = createMockRequest(pathname);
    const response = await middleware(req);

    expect(response.kind).toBe('next');
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(req.cookies.getAll).not.toHaveBeenCalled();
    expect(req.cookies.set).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBeUndefined();
    expect(response.cookies.set).not.toHaveBeenCalled();
  });

  it.each(['/', '/admin', '/admin/users', '/billing', '/billing/example'])(
    'invokes Supabase only for protected path %s',
    async (pathname) => {
      await middleware(createMockRequest(pathname));

      expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
    }
  );

  it('returns an authenticated protected response with private no-store', async () => {
    const response = await middleware(createMockRequest('/'));

    expect(response.kind).toBe('next');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('redirects a missing protected user with private no-store', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const req = createMockRequest('/admin/users');

    const response = await middleware(req);

    expect(response.kind).toBe('redirect');
    expect(response.destination.pathname).toBe('/login');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it.each(['construction', 'getUser'])(
    'degrades gracefully with private no-store after a Supabase %s failure',
    async (failurePoint) => {
      if (failurePoint === 'construction') {
        mockCreateServerClient.mockImplementation(() => {
          throw new Error('Supabase construction failed');
        });
      } else {
        mockGetUser.mockRejectedValue(new Error('Supabase getUser failed'));
      }

      const response = await middleware(createMockRequest('/billing'));

      expect(response.kind).toBe('next');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    }
  );

  it('applies only the final refresh descriptor for each cookie to the next response', async () => {
    let cookieAdapter;
    mockCreateServerClient.mockImplementation((_url, _key, options) => {
      cookieAdapter = options.cookies;
      return { auth: { getUser: mockGetUser } };
    });
    mockGetUser.mockImplementation(async () => {
      cookieAdapter.setAll([
        { name: 'sb-token', value: 'stale', options: { maxAge: 60 } },
        { name: 'sb-token', value: 'fresh', options: { maxAge: 120 } },
        { name: 'sb-refresh', value: 'refresh', options: {} },
      ]);
      return { data: { user: { id: 'user-123' } } };
    });
    const req = createMockRequest('/');

    const response = await middleware(req);

    expect(req.cookies.set).toHaveBeenCalledTimes(3);
    expect(response.cookies.set).toHaveBeenCalledTimes(2);
    expect(response.cookies.set).toHaveBeenNthCalledWith(
      1,
      'sb-token',
      'fresh',
      expect.objectContaining({
        maxAge: 120,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
    );
    expect(response.cookies.set).toHaveBeenNthCalledWith(
      2,
      'sb-refresh',
      'refresh',
      expect.objectContaining({ maxAge: 604800 })
    );
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('applies deletion cookies once to the final redirect with enforced attributes', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let cookieAdapter;
    mockCreateServerClient.mockImplementation((_url, _key, options) => {
      cookieAdapter = options.cookies;
      return { auth: { getUser: mockGetUser } };
    });
    mockGetUser.mockImplementation(async () => {
      cookieAdapter.setAll([
        {
          name: 'sb-token',
          value: '',
          options: {
            maxAge: 0,
            httpOnly: false,
            sameSite: 'none',
            path: '/unsafe',
          },
        },
      ]);
      return { data: { user: null } };
    });

    const response = await middleware(createMockRequest('/admin'));

    expect(response.kind).toBe('redirect');
    expect(response.cookies.set).toHaveBeenCalledTimes(1);
    expect(response.cookies.set).toHaveBeenCalledWith('sb-token', '', {
      maxAge: 0,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    process.env.NODE_ENV = originalNodeEnv;
  });
});

describe('middleware matcher', () => {
  let matcher;

  /**
   * Builds the suite-scoped matcher from middleware config without auth work.
   */
  beforeAll(() => {
    matcher = new RegExp(`^${config.matcher[0]}$`);
  });

  it('excludes both the API root and nested API routes', () => {
    expect(matcher.test('/api')).toBe(false);
    expect(matcher.test('/api/health')).toBe(false);
    expect(matcher.test('/api/auth/session')).toBe(false);
  });

  it('does not exclude nearby page routes that only begin with api', () => {
    expect(matcher.test('/apix')).toBe(true);
    expect(matcher.test('/apiary')).toBe(true);
  });
});

/** Integration keeps the real observer on login while mocking only framework and Supabase. */
describe('middleware runtime candidate', () => {
  const syntheticSecret = 'a'.repeat(64);
  const syntheticChallenge = 'b'.repeat(32);
  const environmentKeys = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV',
    'GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED', 'GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET'];
  let savedEnvironment;

  /** Seed only synthetic diagnostic settings and reset observable response/auth effects. */
  beforeEach(() => {
    savedEnvironment = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview',
      GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED: 'true',
      GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET: syntheticSecret });
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockCreateServerClient.mockImplementation(() => ({ auth: { getUser: mockGetUser } }));
    mockNext.mockImplementation(() => createMockNextResponse('next'));
    mockRedirect.mockImplementation((destination) => createMockNextResponse('redirect', destination));
  });

  /** Restore exactly the environment keys touched by this synthetic suite. */
  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** Attach the dedicated synthetic credential without using ordinary auth or cookies. */
  function diagnosticRequest(pathname = '/login') {
    const req = createMockRequest(pathname);
    req.headers.set(MIDDLEWARE_PROBE_KEY_HEADER, syntheticSecret);
    req.headers.set(MIDDLEWARE_PROBE_CHALLENGE_HEADER, syntheticChallenge);
    return req;
  }

  /** Runtime selection is explicit while the original API exclusion stays in place. */
  it('selects Node.js middleware without widening the matcher', () => {
    expect(config.runtime).toBe('nodejs');
    expect(config.matcher).toEqual([
      '/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ]);
  });

  /** The probe uses NextResponse.next, retaining the login page and stripping private input. */
  it('observes an authenticated login request without replacing the page or calling Supabase', async () => {
    const req = diagnosticRequest();
    const response = await middleware(req);
    expect(response.kind).toBe('next');
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(response.cookies.set).not.toHaveBeenCalled();
    expect(JSON.parse(response.headers.get(MIDDLEWARE_PROBE_RESPONSE_HEADER))).toEqual({
      schemaVersion: 1, scope: 'middleware', challenge: syntheticChallenge,
      nodeVersion: process.version, node22: process.versions.node.startsWith('22.'),
    });
    const forwarded = mockNext.mock.calls[0][0].request.headers;
    expect(forwarded.has(MIDDLEWARE_PROBE_KEY_HEADER)).toBe(false);
    expect(forwarded.has(MIDDLEWARE_PROBE_CHALLENGE_HEADER)).toBe(false);
    expect(req.headers.get(MIDDLEWARE_PROBE_KEY_HEADER)).toBe(syntheticSecret);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  });

  /** A wrong credential never blocks login or manufactures an execution observation. */
  it('continues login without diagnostic output after incorrect authentication', async () => {
    const req = diagnosticRequest();
    req.headers.set(MIDDLEWARE_PROBE_KEY_HEADER, 'c'.repeat(64));
    const response = await middleware(req);
    expect(response.kind).toBe('next');
    expect(response.headers.get(MIDDLEWARE_PROBE_RESPONSE_HEADER)).toBeUndefined();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  /** Even valid probe credentials cannot bypass a protected route or disclose there. */
  it.each(['/admin', '/billing', '/'])('preserves protected auth at %s', async (pathname) => {
    const response = await middleware(diagnosticRequest(pathname));
    expect(response.kind).toBe('redirect');
    expect(response.destination.pathname).toBe('/login');
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(response.headers.get(MIDDLEWARE_PROBE_RESPONSE_HEADER)).toBeUndefined();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  /** Public/unmatched paths and wrong-method login retain their existing continuation. */
  it.each(['/login/', '/auth/callback', '/404', '/route-that-does-not-exist'])(
    'emits no observation for another public/unmatched path %s', async (pathname) => {
      const response = await middleware(diagnosticRequest(pathname));
      expect(response.kind).toBe('next');
      expect(response.headers.get(MIDDLEWARE_PROBE_RESPONSE_HEADER)).toBeUndefined();
      expect(mockCreateServerClient).not.toHaveBeenCalled();
    }
  );

  /** POST is ordinary login traffic even when diagnostic headers are supplied. */
  it('does not observe a login POST', async () => {
    const req = diagnosticRequest();
    req.method = 'POST';
    const response = await middleware(req);
    expect(response.kind).toBe('next');
    expect(response.headers.get(MIDDLEWARE_PROBE_RESPONSE_HEADER)).toBeUndefined();
  });
});
