/**
 * Direct-request authorization tests for the Admin users page.
 *
 * Purpose: verify server rendering rejects authenticated non-admins before the
 * client-side role guard or protected Admin shell can run.
 */

const mockGetUserFromRequest = jest.fn();

jest.mock('../../server/lib/supabaseServer.js', () => ({
  getUserFromRequest: (...args) => mockGetUserFromRequest(...args),
}));

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../client/hooks/useAdminUsers', () => ({
  useAdminUsers: jest.fn(),
}));

const { getServerSideProps } = require('../../pages/admin/users.js');

describe('/admin/users direct-request authorization', () => {
  /** Verify every auth branch receives all cache headers before provider work. */
  afterEach(() => {
    const [, res] = mockGetUserFromRequest.mock.calls[0];
    for (const [name, value] of [
      ['Cache-Control', 'private, no-store'],
      ['CDN-Cache-Control', 'no-store'],
      ['Vercel-CDN-Cache-Control', 'no-store'],
    ]) {
      const index = res.setHeader.mock.calls.findIndex((call) => call[0] === name);
      expect(res.setHeader).toHaveBeenCalledWith(name, value);
      expect(res.setHeader.mock.invocationCallOrder[index]).toBeLessThan(
        mockGetUserFromRequest.mock.invocationCallOrder[0]
      );
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Verify missing sessions use a framework redirect without rendering. */
  it('redirects a missing user to login', async () => {
    const req = { headers: {} };
    const res = {
      statusCode: 200,
      finished: false,
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    mockGetUserFromRequest.mockResolvedValue({
      user: null,
      error: 'User not found',
    });

    const result = await getServerSideProps({ req, res });

    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetUserFromRequest.mock.invocationCallOrder[0]
    );
    expect(result).toEqual({
      redirect: { destination: '/login', permanent: false },
    });
  });

  /** Verify current auth-backend failures still redirect with private cache policy. */
  it('treats an unavailable auth result as missing without losing no-store', async () => {
    const req = { headers: {} };
    const res = {
      statusCode: 200,
      finished: false,
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    mockGetUserFromRequest.mockResolvedValue({
      user: null,
      error: 'Authentication service unavailable',
    });

    const result = await getServerSideProps({ req, res });

    expect(result).toEqual({
      redirect: { destination: '/login', permanent: false },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it('rejects an authenticated non-admin before rendering the page shell', async () => {
    const req = { headers: { cookie: 'session=present' } };
    const res = {
      statusCode: 200,
      finished: false,
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    res.end.mockImplementation((body) => {
      res.body = body;
      res.finished = true;
    });
    mockGetUserFromRequest.mockResolvedValue({
      user: {
        id: 'member-123',
        role: 'authenticated',
        app_metadata: { role: 'user' },
      },
      error: null,
    });

    const result = await getServerSideProps({ req, res });

    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json; charset=utf-8'
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(JSON.parse(res.body)).toEqual({
      data: null,
      error: 'ADMIN_FORBIDDEN',
      message: 'Admin access required.',
    });
    expect(res.finished).toBe(true);
    expect(result).toEqual({ props: {} });
  });

  /** Verify successful admin authorization adds only the required cache policy. */
  it('renders props for an authenticated admin with private no-store', async () => {
    const req = { headers: { cookie: 'session=admin' } };
    const res = {
      statusCode: 200,
      finished: false,
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    mockGetUserFromRequest.mockResolvedValue({
      user: {
        id: 'admin-123',
        role: 'authenticated',
        app_metadata: { role: 'admin' },
      },
      error: null,
    });

    const result = await getServerSideProps({ req, res });

    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(result).toEqual({ props: {} });
    expect(res.statusCode).toBe(200);
    expect(res.finished).toBe(false);
    expect(res.setHeader).toHaveBeenCalledTimes(3);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.end).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('body');
  });
});
