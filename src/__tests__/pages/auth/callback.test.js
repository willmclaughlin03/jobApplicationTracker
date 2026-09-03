/**
 * Server-side OAuth callback cache and cookie tests.
 *
 * Purpose: ensure every callback redirect is private/no-store from the first
 * response mutation while preserving auth and CSRF cookie writes on success.
 */

const mockCreateApiRouteClient = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockGenerateCsrfToken = jest.fn();
const mockSetCsrfCookie = jest.fn();

jest.mock('../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: (...args) => mockCreateApiRouteClient(...args),
}));

jest.mock('../../../server/lib/csrf.js', () => ({
  generateCsrfToken: (...args) => mockGenerateCsrfToken(...args),
  setCsrfCookie: (...args) => mockSetCsrfCookie(...args),
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../client/components/Spinner', () => function MockSpinner() {
  return null;
});

const { getServerSideProps } = require('../../../pages/auth/callback.js');

/**
 * Builds a response mock that retains response headers across callback work.
 *
 * @returns {object} Minimal Node response header interface.
 */
function createMockResponse() {
  const headers = {};
  return {
    getHeader: jest.fn((name) => headers[name]),
    setHeader: jest.fn((name, value) => {
      headers[name] = value;
    }),
    headers,
  };
}

describe('/auth/callback getServerSideProps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateCsrfToken.mockReturnValue('csrf-token');
    mockCreateApiRouteClient.mockImplementation((_req, res) => ({
      auth: {
        exchangeCodeForSession: async (...args) => {
          res.setHeader('Set-Cookie', ['auth-cookie=refreshed']);
          return mockExchangeCodeForSession(...args);
        },
      },
    }));
    mockSetCsrfCookie.mockImplementation((res) => {
      const existing = res.getHeader('Set-Cookie') ?? [];
      res.setHeader('Set-Cookie', [...existing, 'csrf-cookie=csrf-token']);
    });
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-string', ['code']],
  ])('sets private no-store before redirecting for a %s code', async (_case, code) => {
    const res = createMockResponse();

    const result = await getServerSideProps({ req: {}, res, query: { code } });

    expect(res.setHeader.mock.calls[0]).toEqual([
      'Cache-Control',
      'private, no-store',
    ]);
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(result).toEqual({
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    });
  });

  it('sets private no-store before rejecting an overlong code', async () => {
    const res = createMockResponse();

    const result = await getServerSideProps({
      req: {},
      res,
      query: { code: 'x'.repeat(2049) },
    });

    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(mockCreateApiRouteClient).not.toHaveBeenCalled();
    expect(result.redirect.destination).toBe('/login?error=sign_in_failed');
  });

  it('keeps private no-store on a failed exchange redirect', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: new Error('invalid code'),
    });
    const res = createMockResponse();

    const result = await getServerSideProps({
      req: {},
      res,
      query: { code: 'valid-shape' },
    });

    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(result.redirect.destination).toBe('/login?error=sign_in_failed');
  });

  it('keeps auth and CSRF cookies on a successful validated redirect', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });
    const req = { cookies: {} };
    const res = createMockResponse();

    const result = await getServerSideProps({
      req,
      res,
      query: { code: 'valid-code', next: '/billing' },
    });

    expect(res.setHeader.mock.calls[0]).toEqual([
      'Cache-Control',
      'private, no-store',
    ]);
    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateApiRouteClient.mock.invocationCallOrder[0]
    );
    expect(mockGenerateCsrfToken).toHaveBeenCalledWith('user-123');
    expect(mockSetCsrfCookie).toHaveBeenCalledWith(res, 'csrf-token');
    expect(res.headers['Set-Cookie']).toEqual([
      'auth-cookie=refreshed',
      'csrf-cookie=csrf-token',
    ]);
    expect(result).toEqual({
      redirect: { destination: '/billing', permanent: false },
    });
  });

  it('keeps private no-store and the safe destination on a thrown exchange', async () => {
    mockExchangeCodeForSession.mockRejectedValue(new Error('exchange unavailable'));
    const res = createMockResponse();

    const result = await getServerSideProps({
      req: {},
      res,
      query: { code: 'valid-code', next: '//attacker.example' },
    });

    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(result).toEqual({
      redirect: { destination: '/login?error=sign_in_failed', permanent: false },
    });
  });
});
