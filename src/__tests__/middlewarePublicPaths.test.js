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

  beforeAll(() => {
    ({ isPublicPath } = require('../middleware.js'));
  });

  it('allows login, callback, and custom error pages', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/auth/callback')).toBe(true);
    expect(isPublicPath('/403')).toBe(true);
    expect(isPublicPath('/404')).toBe(true);
    expect(isPublicPath('/429')).toBe(true);
    expect(isPublicPath('/500')).toBe(true);
    expect(isPublicPath('/502')).toBe(true);
    expect(isPublicPath('/503')).toBe(true);
    expect(isPublicPath('/504')).toBe(true);
  });

  it('keeps unrelated app paths protected', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/admin/users')).toBe(false);
    expect(isPublicPath('/429/details')).toBe(false);
    expect(isPublicPath('/auth/callback-extra')).toBe(false);
  });
});
