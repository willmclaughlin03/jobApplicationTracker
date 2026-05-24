jest.mock('../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockSupabaseAdmin = {
  from: jest.fn(),
  auth: {
    admin: {
      getUserById: jest.fn(),
      deleteUser: jest.fn(),
    },
  },
};

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

const handler = require('../../../pages/api/admin/users/[id].js').default;

describe('/api/admin/users/[id] delete billing preflight', () => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const actorId = '22222222-2222-4222-8222-222222222222';
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  /**
   * Create a mock Next.js request for the admin user route.
   *
   * Purpose: the route is wrapped as identity in these tests, so request auth
   * state is attached directly in the same shape the middleware normally uses.
   *
   * @param {string} method
   * @returns {object}
   */
  function createMockReq(method = 'DELETE') {
    return {
      method,
      query: { id: targetId },
      _rateLimitUser: {
        id: actorId,
        app_metadata: { role: 'admin' },
      },
      log: mockLog,
    };
  }

  /**
   * Create a minimal mock Next.js response object.
   *
   * Purpose: admin route tests only need status/json chaining to verify the
   * shared response envelope.
   *
   * @returns {object}
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  /**
   * Build a Supabase query builder for billing preflight count reads.
   *
   * Purpose: each billing table should be checked with a service-role count
   * before the route creates any jobs delete or auth delete builders.
   *
   * @param {number} count
   * @param {object | null} error
   * @returns {object}
   */
  function createBillingCountBuilder(count = 0, error = null) {
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ count, error }),
    };
  }

  /**
   * Build a Supabase query builder for the jobs delete path.
   *
   * Purpose: successful-delete tests need the explicit jobs delete chain to
   * resolve like Supabase without touching unrelated table mocks.
   *
   * @param {object | null} error
   * @returns {object}
   */
  function createJobsDeleteBuilder(error = null) {
    return {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error }),
    };
  }

  /**
   * Configure service-role table builders for one route invocation.
   *
   * Purpose: tests can vary which billing table blocks deletion while keeping
   * the route's Supabase boundary observable.
   *
   * @param {Record<string, number>} countsByTable
   * @returns {Record<string, object>}
   */
  function mockSupabaseTables(countsByTable = {}) {
    const builders = {};

    mockSupabaseAdmin.from.mockImplementation((tableName) => {
      if (tableName === 'jobs') {
        builders.jobs = createJobsDeleteBuilder();
        return builders.jobs;
      }

      builders[tableName] = createBillingCountBuilder(countsByTable[tableName] ?? 0);
      return builders[tableName];
    });

    return builders;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseTables();
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ error: null });
  });

  it.each([
    'billing_customers',
    'billing_subscriptions',
    'billing_checkout_sessions',
  ])('blocks deletion before jobs/auth delete when %s rows exist', async (blockingTable) => {
    const builders = mockSupabaseTables({
      [blockingTable]: 1,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(builders[blockingTable].select).toHaveBeenCalledWith(
      'user_id',
      { count: 'exact', head: true }
    );
    expect(mockSupabaseAdmin.from).not.toHaveBeenCalledWith('jobs');
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'ADMIN_BILLING_TEARDOWN_REQUIRED',
      })
    );
  });

  it('deletes jobs before auth only when no billing rows exist', async () => {
    const builders = mockSupabaseTables();
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(builders.jobs.delete).toHaveBeenCalledTimes(1);
    expect(builders.jobs.eq).toHaveBeenCalledWith('user_id', targetId);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(targetId);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 503 and skips destructive work when billing preflight fails', async () => {
    const preflightError = new Error('billing table unavailable');
    mockSupabaseAdmin.from.mockImplementation((tableName) => {
      if (tableName === 'billing_customers') {
        return createBillingCountBuilder(0, preflightError);
      }

      return createBillingCountBuilder(0);
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSupabaseAdmin.from).not.toHaveBeenCalledWith('jobs');
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'ADMIN_DELETE_FAILED',
      })
    );
  });
});
