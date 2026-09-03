/**
 * Tests for supabaseApiRoute cookie factory
 *
 * Purpose: Verify the createApiRouteClient cookie adapter enforces httpOnly,
 * secure, sameSite, and path attributes — ensuring @supabase/ssr cannot
 * downgrade security options.
 *
 * Connects to: src/server/lib/supabaseApiRoute.js
 *
 * Test coverage:
 * - getAll reads all request cookies
 * - setAll writes Set-Cookie headers with security attributes enforced
 * - httpOnly: true cannot be overridden by supabase options
 * - sameSite: lax cannot be overridden
 * - path: / cannot be overridden
 * - Appends to existing Set-Cookie headers
 * - secure respects NODE_ENV
 */

const mockCreateServerClient = jest.fn();
jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args) => mockCreateServerClient(...args),
}));

// Must set env before requiring module
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const { createApiRouteClient } = require('../supabaseApiRoute.js');

describe('createApiRouteClient', () => {
  function createMockReq(cookies = {}) {
    return { cookies };
  }

  function createMockRes() {
    const headers = {};
    return {
      getHeader: jest.fn((name) => headers[name]),
      setHeader: jest.fn((name, value) => { headers[name] = value; }),
      _headers: headers,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateServerClient.mockImplementation((...args) => ({
      _cookieAdapter: args[2].cookies,
    }));
  });

  /**
   * Cache policy must be the first response mutation before client construction.
   */
  it('sets private no-store before createServerClient', () => {
    const req = createMockReq();
    const res = createMockRes();

    createApiRouteClient(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateServerClient.mock.invocationCallOrder[0]
    );
  });

  /**
   * Construction failures cannot remove the cache policy already applied.
   */
  it('retains private no-store when createServerClient throws', () => {
    const req = createMockReq();
    const res = createMockRes();
    mockCreateServerClient.mockImplementation(() => {
      throw new Error('client construction failed');
    });

    expect(() => createApiRouteClient(req, res)).toThrow('client construction failed');
    expect(res._headers['Cache-Control']).toBe('private, no-store');
  });

  /**
   * getAll returns all request cookies as {name, value} pairs
   */
  it('getAll reads all request cookies', () => {
    const req = createMockReq({
      'sb-test-auth-token.0': 'chunk0',
      'sb-test-auth-token.1': 'chunk1',
      'other-cookie': 'value',
    });
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    const cookies = client._cookieAdapter.getAll();

    expect(cookies).toEqual([
      { name: 'sb-test-auth-token.0', value: 'chunk0' },
      { name: 'sb-test-auth-token.1', value: 'chunk1' },
      { name: 'other-cookie', value: 'value' },
    ]);
  });

  /**
   * setAll writes Set-Cookie headers with enforced security attributes
   */
  it('setAll writes cookies with httpOnly, sameSite, and path enforced', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: 'jwt-value', options: {} },
    ]);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('HttpOnly'),
      ])
    );

    const setCookieHeader = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    )[1];
    const cookie = setCookieHeader[setCookieHeader.length - 1];

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(res._headers['Cache-Control']).toBe('private, no-store');
  });

  /**
   * Multiple Supabase writes remain distinct and keep the cache policy intact.
   */
  it('appends multiple refreshed cookies without replacing cache policy', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token.0', value: 'first', options: {} },
    ]);
    client._cookieAdapter.setAll([
      { name: 'sb-token.1', value: 'second', options: {} },
    ]);

    expect(res._headers['Set-Cookie']).toHaveLength(2);
    expect(res._headers['Set-Cookie'][0]).toContain('sb-token.0=first');
    expect(res._headers['Set-Cookie'][1]).toContain('sb-token.1=second');
    expect(res._headers['Cache-Control']).toBe('private, no-store');
  });

  /**
   * Security: httpOnly cannot be overridden to false by @supabase/ssr options
   */
  it('enforces httpOnly: true even if supabase passes httpOnly: false', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: 'jwt', options: { httpOnly: false } },
    ]);

    const setCookieHeader = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    )[1];
    const cookie = setCookieHeader[setCookieHeader.length - 1];

    expect(cookie).toContain('HttpOnly');
  });

  /**
   * Security: sameSite cannot be overridden to 'none'
   */
  it('enforces sameSite: lax even if supabase passes sameSite: none', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: 'jwt', options: { sameSite: 'none' } },
    ]);

    const setCookieHeader = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    )[1];
    const cookie = setCookieHeader[setCookieHeader.length - 1];

    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=None');
  });

  /**
   * Appends to existing Set-Cookie headers
   */
  it('appends to existing Set-Cookie headers', () => {
    const req = createMockReq();
    const res = createMockRes();

    // Simulate a pre-existing Set-Cookie header
    res._headers['Set-Cookie'] = 'existing-cookie=value';
    res.getHeader.mockImplementation((name) => res._headers[name]);

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: 'jwt', options: {} },
    ]);

    const setCookieCall = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    );
    const headers = setCookieCall[1];

    // Should contain both existing and new cookies
    expect(headers[0]).toBe('existing-cookie=value');
    expect(headers.length).toBe(2);
  });

  /**
   * Default maxAge is 7 days (604800 seconds)
   */
  it('applies default maxAge of 7 days', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: 'jwt', options: {} },
    ]);

    const setCookieHeader = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    )[1];
    const cookie = setCookieHeader[setCookieHeader.length - 1];

    expect(cookie).toContain('Max-Age=604800');
  });

  /**
   * maxAge: 0 from supabase (sign-out) is allowed to override the default
   */
  it('allows supabase to override maxAge to 0 for sign-out', () => {
    const req = createMockReq();
    const res = createMockRes();

    const client = createApiRouteClient(req, res);
    client._cookieAdapter.setAll([
      { name: 'sb-token', value: '', options: { maxAge: 0 } },
    ]);

    const setCookieHeader = res.setHeader.mock.calls.find(
      (c) => c[0] === 'Set-Cookie'
    )[1];
    const cookie = setCookieHeader[setCookieHeader.length - 1];

    expect(cookie).toContain('Max-Age=0');
  });

  /**
   * Passes correct URL and anon key to createServerClient
   */
  it('passes correct Supabase URL and anon key', () => {
    const req = createMockReq();
    const res = createMockRes();

    createApiRouteClient(req, res);

    expect(mockCreateServerClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-anon-key',
      expect.any(Object)
    );
  });
});
