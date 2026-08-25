const capturedRateLimitOptions = [];

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler, options) => {
    capturedRateLimitOptions.push(options);
    return handler;
  },
}));

jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: jest.fn(() => ({
    auth: { signOut: jest.fn(async () => ({ error: null })) },
  })),
}));

jest.mock('../../../../server/lib/csrf.js', () => ({
  clearCsrfCookie: jest.fn(),
}));

describe('/api/auth/signout generic AUTH invariants', () => {
  it('remains a public POST route backed by generic AUTH without a skip', () => {
    jest.isolateModules(() => {
      require('../../../../pages/api/auth/signout.js');
    });
    expect(capturedRateLimitOptions).toHaveLength(1);
    expect(capturedRateLimitOptions[0]).toEqual({
      requireAuth: false,
      operation: 'auth',
      allowedMethods: ['POST'],
    });
    expect(capturedRateLimitOptions[0]).not.toHaveProperty('skipRateLimitWhen');
    expect(capturedRateLimitOptions[0]).not.toHaveProperty('preRateLimitGuard');
  });
});
