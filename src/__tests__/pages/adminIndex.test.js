/**
 * CHUNK-0 seven-state auth regressions for the Admin index route gate.
 *
 * Purpose: Prevent authority uncertainty and logout states from being treated
 * as confirmed anonymity while preserving the authenticated role redirects.
 * Connects to: src/pages/admin/index.js and the auth consumer matrix.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockUseAuth = jest.fn();
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

const AdminIndex = require('../../pages/admin/index.js').default;

let container;
let root;

/**
 * Mounts the Admin index route and flushes its redirect effect.
 *
 * @returns {void} The route renders no visible private content.
 */
function renderAdminIndex() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(AdminIndex));
  });
}

/**
 * Removes the mounted route between auth-state matrix cases.
 *
 * @returns {void}
 */
function cleanup() {
  if (root) act(() => root.unmount());
  container?.remove();
  container = null;
  root = null;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(cleanup);

describe('Admin index seven-state route gate', () => {
  it('waits in loading without choosing an authorization redirect', () => {
    mockUseAuth.mockReturnValue({
      authStatus: 'loading',
      loading: true,
      user: null,
    });

    renderAdminIndex();

    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['admin', '/admin/users'],
    ['user', '/'],
  ])('routes an authenticated %s through the verified role gate', (role, destination) => {
    mockUseAuth.mockReturnValue({
      authStatus: 'authenticated',
      loading: false,
      user: { id: 'verified-subject', role },
    });

    renderAdminIndex();

    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(destination);
  });

  it('routes only confirmed anonymous auth to ordinary login', () => {
    mockUseAuth.mockReturnValue({
      authStatus: 'anonymous',
      loading: false,
      user: null,
    });

    renderAdminIndex();

    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  });

  it.each([
    'unavailable',
    'signed_out_local',
    'logout_unconfirmed',
    'terminal_unauthenticated',
  ])('does not turn %s into an ordinary-login redirect', (authStatus) => {
    mockUseAuth.mockReturnValue({
      authStatus,
      loading: false,
      user: null,
    });

    renderAdminIndex();

    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
