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

describe('middleware matcher', () => {
  let matcher;

  beforeAll(() => {
    const { config } = require('../middleware.js');
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
