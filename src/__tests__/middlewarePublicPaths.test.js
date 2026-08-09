/**
 * Tests for middleware public-route classification.
 *
 * Purpose: Ensure custom error pages remain reachable without weakening the
 * auth gate for nearby non-public paths.
 *
 * Connects to: src/middleware.js
 */

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    next: jest.fn(() => ({
      cookies: {
        set: jest.fn(),
      },
      headers: {
        set: jest.fn(),
      },
    })),
    redirect: jest.fn(),
  },
}));

const {
  ROUTE_CLASSIFICATION_FIXTURES,
} = require('../testSupport/authV2ContractFixtures.js');
const { NextURL } = require('next/dist/server/web/next-url');

/**
 * Creates the request surface used by the real middleware function.
 *
 * @param {string} pathname - Page path to classify.
 * @returns {object} Edge request double.
 */
function createMiddlewareRequest(pathname) {
  return {
    cookies: {
      getAll: jest.fn().mockReturnValue([]),
      set: jest.fn(),
    },
    nextUrl: {
      pathname,
      clone: jest.fn(() => ({ pathname })),
    },
  };
}

/**
 * Creates a final middleware response with observable headers and cookies.
 *
 * @param {string} type - Response kind used by final-path assertions.
 * @returns {object} NextResponse-compatible response double.
 */
function createMiddlewareResponse(type) {
  return {
    type,
    cookies: { set: jest.fn() },
    headers: { set: jest.fn() },
  };
}

describe('isPublicPath', () => {
  let isPublicPath;
  let ERROR_STATUS_CODES;

  beforeAll(() => {
    ({ isPublicPath } = require('../middleware.js'));
    ({ ERROR_STATUS_CODES } = require('../shared/constants/errorStatusCodes.js'));
  });

  it('allows login, callback, and custom error pages', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/auth/callback')).toBe(true);
    ERROR_STATUS_CODES.forEach((statusCode) => {
      expect(isPublicPath(`/${statusCode}`)).toBe(true);
    });
  });

  it('keeps unrelated app paths protected', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/admin/users')).toBe(false);
    expect(isPublicPath('/429/details')).toBe(false);
    expect(isPublicPath('/auth/callback-extra')).toBe(false);
  });

  it.each(ROUTE_CLASSIFICATION_FIXTURES.rawRejected)(
    'rejects raw query-string status input %s before exact-path matching',
    (rawPath) => {
      expect(isPublicPath(rawPath)).toBe(false);
    }
  );

  it.each([
    ['http://localhost:3000/%34%30%33', '/%34%30%33', ''],
    ['http://localhost:3000/403%2Fdetails', '/403%2Fdetails', ''],
    ['http://localhost:3000/403?source=test', '/403', '?source=test'],
  ])('freezes installed NextURL boundaries for %s', (rawUrl, pathname, search) => {
    const nextUrl = new NextURL(rawUrl);

    expect(nextUrl.pathname).toBe(pathname);
    expect(nextUrl.search).toBe(search);
  });
});

describe('middleware route ordering', () => {
  let createServerClient;
  let middleware;
  let mockGetUser;
  let NextResponse;

  beforeAll(() => {
    ({ createServerClient } = require('@supabase/ssr'));
    ({ NextResponse } = require('next/server'));
    ({ middleware } = require('../middleware.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser = jest.fn().mockResolvedValue({ data: { user: null }, error: null });
    createServerClient.mockReturnValue({ auth: { getUser: mockGetUser } });
    NextResponse.next.mockImplementation(() => createMiddlewareResponse('next'));
    NextResponse.redirect.mockImplementation((url) => ({
      ...createMiddlewareResponse('redirect'),
      url,
    }));
  });

  it.each(ROUTE_CLASSIFICATION_FIXTURES.public)(
    'classifies public route %s before constructing Supabase',
    async (pathname) => {
      await middleware(createMiddlewareRequest(pathname));

      expect(createServerClient).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTE_CLASSIFICATION_FIXTURES.unmatched)(
    'passes unmatched route %s through without Supabase or an auth redirect',
    async (pathname) => {
      await middleware(createMiddlewareRequest(pathname));

      expect(createServerClient).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTE_CLASSIFICATION_FIXTURES.protected)(
    'keeps protected route %s behind the Supabase auth gate',
    async (pathname) => {
      await middleware(createMiddlewareRequest(pathname));

      expect(createServerClient).toHaveBeenCalledTimes(1);
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      expect(NextResponse.redirect).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['next', { data: { user: { id: 'authenticated-subject' } } }, false],
    ['redirect', { data: { user: null } }, false],
    ['next after authority exception', null, true],
  ])('sets private no-store and preserves the exact refresh cookie on final %s', async (
    _label,
    getUserResult,
    rejects
  ) => {
    createServerClient.mockImplementation((_url, _key, options) => ({
      auth: {
        getUser: jest.fn(async () => {
          options.cookies.setAll([{
            name: 'auth-cookie-marker',
            value: 'synthetic-cookie-value',
            options: { maxAge: 120, path: '/' },
          }]);

          if (rejects) throw new Error('sanitized authority failure');

          return getUserResult;
        }),
      },
    }));

    const response = await middleware(createMiddlewareRequest('/admin/users'));

    expect(response.type).toBe(_label === 'redirect' ? 'redirect' : 'next');
    expect(response.cookies.set).toHaveBeenCalledTimes(1);
    expect(response.cookies.set).toHaveBeenCalledWith(
      'auth-cookie-marker',
      'synthetic-cookie-value',
      {
        httpOnly: true,
        maxAge: 120,
        path: '/',
        sameSite: 'lax',
        secure: false,
      }
    );
    expect(response.headers.set).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
  });

  it('sets private no-store on a protected authority exception', async () => {
    mockGetUser.mockRejectedValue(new Error('sanitized authority failure'));
    createServerClient.mockReturnValue({ auth: { getUser: mockGetUser } });

    const response = await middleware(createMiddlewareRequest('/admin'));

    expect(response.headers.set).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
  });
});
