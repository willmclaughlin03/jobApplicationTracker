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
    })),
    redirect: jest.fn(),
  },
}));

const {
  ROUTE_CLASSIFICATION_FIXTURES,
} = require('../testSupport/authV2ContractFixtures.js');

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
    NextResponse.redirect.mockImplementation((url) => ({ type: 'redirect', url }));
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
});
