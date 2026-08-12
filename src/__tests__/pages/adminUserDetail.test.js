/**
 * CHUNK-0 auth-state regressions for the Admin user-detail caller.
 *
 * Purpose: Cover the sign-out caller omitted by the original checkpoint and
 * prevent unavailable/local-cleanup states from becoming false login access.
 * Connects to: src/pages/admin/users/[id].js and CHUNK-3/4 caller fixes.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockUseAuth = jest.fn();
const mockUseAdminUser = jest.fn();
const mockRouter = {
  push: jest.fn(),
  query: { id: 'target-subject' },
  replace: jest.fn(),
};
let latestProfileProps;

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('../../client/hooks/useAdminUser', () => ({
  useAdminUser: (...args) => mockUseAdminUser(...args),
}));

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('../../client/components/ProfileDropdown', () => {
  const React = require('react');

  /** Captures the detail page's profile actions for caller assertions. */
  return function MockProfileDropdown(props) {
    latestProfileProps = props;
    return React.createElement('div', { 'data-testid': 'profile' });
  };
});

jest.mock('../../client/components/admin/AdminRoleControl', () => () => null);
jest.mock('../../client/components/admin/AdminActivitySummary', () => () => null);
jest.mock('../../client/components/admin/AdminDeleteUserModal', () => () => null);
jest.mock('../../client/components/Spinner', () => () => null);

const AdminUserDetailPage = require('../../pages/admin/users/[id].js').default;

let container;
let root;

/**
 * Renders the Admin user-detail page with the current hook fixtures.
 *
 * @returns {HTMLElement} Mounted page container.
 */
function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(AdminUserDetailPage));
  });

  return container;
}

/**
 * Removes the mounted page between auth-state cases.
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

beforeEach(() => {
  jest.clearAllMocks();
  latestProfileProps = null;
  mockUseAdminUser.mockReturnValue({
    activity: {},
    clearError: jest.fn(),
    deleteUser: jest.fn(),
    deleting: false,
    error: null,
    loading: false,
    updateRole: jest.fn(),
    updating: false,
    user: { id: 'target-subject', role: 'user' },
  });
});

afterEach(cleanup);

describe('Admin user-detail auth outcomes', () => {
  it('keeps loading auth from enabling selected-user work or navigation', () => {
    mockUseAuth.mockReturnValue({
      authStatus: 'loading',
      canPerformUserWork: false,
      loading: true,
      signOut: jest.fn(),
      user: null,
    });

    renderPage();

    expect(mockUseAdminUser).toHaveBeenCalledWith('target-subject', { enabled: false });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(latestProfileProps).toBeNull();
  });

  it('redirects only confirmed anonymous auth to ordinary login', () => {
    mockUseAuth.mockReturnValue({
      authStatus: 'anonymous',
      canPerformUserWork: false,
      loading: false,
      signOut: jest.fn(),
      user: null,
    });

    renderPage();

    expect(mockUseAdminUser).toHaveBeenCalledWith('target-subject', { enabled: false });
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  });

  it('enables selected-user work only for an authenticated admin', () => {
    mockUseAuth.mockReturnValue({
      authStatus: 'authenticated',
      canPerformUserWork: true,
      loading: false,
      signOut: jest.fn(),
      user: { id: 'admin-subject', role: 'admin' },
    });

    renderPage();

    expect(mockUseAdminUser).toHaveBeenCalledWith('target-subject', { enabled: true });
    expect(latestProfileProps).toEqual(expect.objectContaining({
      user: { id: 'admin-subject', role: 'admin' },
    }));
  });

  it.each([
    'unavailable',
    'signed_out_local',
    'logout_unconfirmed',
    'terminal_unauthenticated',
  ])('does not redirect %s authority to the ordinary login page', (authStatus) => {
    mockUseAuth.mockReturnValue({
      authStatus,
      canPerformUserWork: false,
      loading: false,
      signOut: jest.fn(),
      user: null,
    });

    renderPage();

    expect(mockUseAdminUser).toHaveBeenCalledWith('target-subject', { enabled: false });
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/login');
    expect(latestProfileProps).toBeNull();
  });

  it.each(['signed_out_local', 'logout_unconfirmed'])(
    'does not navigate to login after a %s sign-out result',
    async (status) => {
      const signOut = jest.fn().mockResolvedValue({ status });
      mockUseAuth.mockReturnValue({
        authStatus: 'authenticated',
        loading: false,
        signOut,
        user: { id: 'admin-subject', role: 'admin' },
      });
      renderPage();

      await act(async () => {
        await latestProfileProps.onSignOut();
      });

      expect(signOut).toHaveBeenCalledTimes(1);
      expect(mockRouter.push).not.toHaveBeenCalledWith('/login');
      expect(mockRouter.replace).not.toHaveBeenCalledWith('/login');
    }
  );
});
