/**
 * Direct-request authorization tests for the Admin users page.
 *
 * Purpose: verify server rendering rejects authenticated non-admins before the
 * client-side role guard or protected Admin shell can run.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockGetUserFromRequest = jest.fn();
const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockLatestProfileProps;

jest.mock('../../server/lib/supabaseServer.js', () => ({
  getUserFromRequest: (...args) => mockGetUserFromRequest(...args),
}));

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../client/hooks/useAdminUsers', () => ({
  useAdminUsers: jest.fn(),
}));

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('../../client/components/ProfileDropdown', () => {
  const React = require('react');

  /** Captures admin profile actions without rendering dropdown internals. */
  return function MockProfileDropdown(props) {
    mockLatestProfileProps = props;
    return React.createElement('div', { 'data-testid': 'admin-profile' });
  };
});

jest.mock('../../client/components/admin/AdminUserTable', () => {
  const React = require('react');

  /** Replaces the private user table with a non-sensitive marker. */
  return function MockAdminUserTable() {
    return React.createElement('div', { 'data-testid': 'admin-user-table' });
  };
});

jest.mock('../../client/components/admin/AdminDeleteUserModal', () => {
  /** Omits delete-modal internals from auth-state tests. */
  return function MockAdminDeleteUserModal() {
    return null;
  };
});

jest.mock('../../client/components/Spinner', () => {
  const React = require('react');

  /** Replaces the loading spinner with an accessible status marker. */
  return function MockSpinner() {
    return React.createElement('div', { role: 'status' });
  };
});

const {
  default: AdminUsersPage,
  getServerSideProps,
} = require('../../pages/admin/users.js');
const { useAuth } = require('../../client/contexts/AuthContext');
const { useAdminUsers } = require('../../client/hooks/useAdminUsers');

let container;
let root;

/**
 * Mounts the Admin users page with the active auth and hook fixtures.
 *
 * @returns {HTMLElement} Rendered page container.
 */
function renderAdminUsersPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(AdminUsersPage));
  });

  return container;
}

/**
 * Removes the mounted Admin page between client-state assertions.
 *
 * @returns {void}
 */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
  container = null;
  root = null;
}

describe('/admin/users direct-request authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLatestProfileProps = null;
    useAuth.mockReturnValue({
      user: { id: 'admin-subject', role: 'admin' },
      loading: false,
      authStatus: 'authenticated',
      signOut: jest.fn().mockResolvedValue({ status: 'complete' }),
    });
    useAdminUsers.mockReturnValue({
      users: [],
      loading: false,
      error: null,
      page: 1,
      setPage: jest.fn(),
      hasMore: false,
      deleting: null,
      deleteUser: jest.fn(),
      clearError: jest.fn(),
    });
  });

  afterEach(cleanup);

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

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(result).toEqual({
      redirect: { destination: '/login', permanent: false },
    });
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

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json; charset=utf-8'
    );
    expect(JSON.parse(res.body)).toEqual({
      data: null,
      error: 'ADMIN_FORBIDDEN',
      message: 'Admin access required.',
    });
    expect(res.finished).toBe(true);
    expect(result).toEqual({ props: {} });
  });

  /** Verify successful admin authorization leaves the page response untouched. */
  it('renders props for an authenticated admin without mutating the response', async () => {
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

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockGetUserFromRequest).toHaveBeenCalledWith(req, res);
    expect(result).toEqual({ props: {} });
    expect(res.statusCode).toBe(200);
    expect(res.finished).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('body');
  });
});

describe('/admin/users client auth outcomes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLatestProfileProps = null;
    useAdminUsers.mockReturnValue({
      users: [],
      loading: false,
      error: null,
      page: 1,
      setPage: jest.fn(),
      hasMore: false,
      deleting: null,
      deleteUser: jest.fn(),
      clearError: jest.fn(),
    });
  });

  afterEach(cleanup);

  it('does not redirect or expose the private table while auth is unavailable', () => {
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      authStatus: 'unavailable',
      canPerformUserWork: false,
      signOut: jest.fn(),
    });

    const element = renderAdminUsersPage();

    expect(mockRouter.replace).not.toHaveBeenCalledWith('/login');
    expect(element.querySelector('[data-testid=admin-user-table]')).toBeNull();
  });

  it('does not navigate to login when explicit admin sign-out is unconfirmed', async () => {
    const signOut = jest.fn().mockResolvedValue({
      status: 'logout_unconfirmed',
      requestPending: false,
      retryAllowed: true,
    });
    useAuth.mockReturnValue({
      user: { id: 'admin-subject', role: 'admin' },
      loading: false,
      authStatus: 'authenticated',
      signOut,
    });
    renderAdminUsersPage();

    await act(async () => {
      await mockLatestProfileProps.onSignOut();
    });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalledWith('/login');
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/login');
  });
});
