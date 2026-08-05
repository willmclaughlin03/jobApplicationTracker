/**
 * Tests for the public login page's OAuth behavior and visual contract.
 *
 * Purpose: Verify the reference-aligned emerald composition preserves loading,
 * callback-error, redirect, and provider-failure behavior without making its
 * decorative artwork available to assistive technology.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockRouter = {
  push: jest.fn(),
  query: {},
};
const mockUseAuth = jest.fn();
const mockSignInWithOAuth = jest.fn();

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

/** Replace Next's font loader with a deterministic public-shell CSS hook. */
jest.mock('next/font/google', () => ({
  Inter: jest.fn().mockReturnValue({
    className: 'mock-login-font',
    variable: 'mock-login-font-variable',
  }),
}));

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: (...args) => mockUseAuth(...args),
}));

let Login;
let container;
let root;

/**
 * Render the login page into a disposable jsdom root.
 *
 * @returns {HTMLElement} Mounted page container.
 */
function renderLogin() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(Login));
  });

  return container;
}

/**
 * Dispatch one bubbling click through React's event system.
 *
 * @param {HTMLElement} target - Login action to activate.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Flush one microtask turn for async OAuth handlers and effects.
 *
 * @returns {Promise<void>}
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Create a controllable promise for the in-flight OAuth presentation test.
 *
 * @returns {{promise: Promise<unknown>, resolve: Function, reject: Function}}
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

/** Unmount and remove the current test root. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  if (container?.parentNode) {
    document.body.removeChild(container);
  }

  container = null;
  root = null;
}

describe('Login', () => {
  beforeAll(() => {
    Login = require('../../pages/login.js').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.query = {};
    mockUseAuth.mockReturnValue({
      user: null,
      loading: false,
      signInWithOAuth: mockSignInWithOAuth,
    });
    mockSignInWithOAuth.mockResolvedValue({ error: null });
  });

  afterEach(cleanup);

  it('renders the emerald sign-in composition and hides its artwork', () => {
    const element = renderLogin();
    const themeRoot = element.querySelector('.public-page-root');
    const brand = element.querySelector('[data-testid="public-page-brand"]');
    const panel = element.querySelector('[data-testid="login-panel"]');
    const heading = element.querySelector('h1');
    const button = element.querySelector('button');
    const wave = element.querySelector('[data-testid="public-dotted-wave"]');
    const googleMark = element.querySelector('[data-testid="google-mark"]');

    expect(themeRoot).toBeTruthy();
    expect(themeRoot.classList.contains('mock-login-font-variable')).toBe(true);
    expect(element.querySelector('.public-page-frame')).toBeTruthy();
    expect(brand.textContent).toContain('TrackTheApp');
    expect(panel.classList.contains('max-w-lg')).toBe(true);
    expect(heading.textContent).toBe('Sign In');
    expect(button.textContent).toContain('Continue with Google');
    expect(button.classList.contains('dashboard-focus-ring')).toBe(true);
    expect(googleMark.getAttribute('aria-hidden')).toBe('true');
    expect(wave.getAttribute('aria-hidden')).toBe('true');
    expect(wave.getAttribute('focusable')).toBe('false');
    expect(wave.getAttribute('preserveAspectRatio')).toBe('none');
    expect(wave.querySelectorAll('[data-wave-strand="true"]')).toHaveLength(22);
  });

  it('keeps the themed shell while authentication is loading', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: true,
      signInWithOAuth: mockSignInWithOAuth,
    });

    const element = renderLogin();
    const status = element.querySelector('[role="status"]');

    expect(element.querySelector('.public-page-root')).toBeTruthy();
    expect(status.textContent).toContain('Loading...');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(element.querySelector('button')).toBeNull();
  });

  it('redirects an authenticated user without rendering login controls', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123' },
      loading: false,
      signInWithOAuth: mockSignInWithOAuth,
    });

    const element = renderLogin();

    expect(mockRouter.push).toHaveBeenCalledWith('/');
    expect(element.childElementCount).toBe(0);
  });

  it('surfaces the OAuth callback failure through a safe alert', () => {
    mockRouter.query = { error: 'sign_in_failed' };

    const element = renderLogin();
    const alert = element.querySelector('[role="alert"]');

    expect(alert.textContent).toBe('Sign in failed. Please try again.');
  });

  it('shows a stable busy action while the OAuth redirect is in flight', async () => {
    const deferred = createDeferred();
    mockSignInWithOAuth.mockReturnValue(deferred.promise);
    const element = renderLogin();
    const button = element.querySelector('button');

    click(button);

    expect(mockSignInWithOAuth).toHaveBeenCalledWith('google');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Redirecting...');

    await act(async () => {
      deferred.resolve({ error: null });
      await deferred.promise;
    });
  });

  /** Verify same-batch clicks cannot start more than one OAuth handoff. */
  it('ignores a second sign-in click before the loading state commits', async () => {
    const deferred = createDeferred();
    mockSignInWithOAuth.mockReturnValue(deferred.promise);
    const element = renderLogin();
    const button = element.querySelector('button');

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1);
    expect(mockSignInWithOAuth).toHaveBeenCalledWith('google');

    await act(async () => {
      deferred.resolve({ error: null });
      await deferred.promise;
    });
  });

  it('restores the OAuth action and shows a provider initiation error', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      error: { message: 'Google sign-in is temporarily unavailable.' },
    });
    const element = renderLogin();

    click(element.querySelector('button'));
    await flushEffects();

    const button = element.querySelector('button');
    const alert = element.querySelector('[role="alert"]');

    expect(alert.textContent).toBe('Google sign-in is temporarily unavailable.');
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.textContent).toContain('Continue with Google');
  });

  /** Verify rejected OAuth requests recover the action without exposing raw errors. */
  it('restores the OAuth action when provider initiation rejects', async () => {
    mockSignInWithOAuth.mockRejectedValue(new Error('Provider request failed.'));
    const element = renderLogin();

    click(element.querySelector('button'));
    await flushEffects();

    const button = element.querySelector('button');
    const alert = element.querySelector('[role=alert]');

    expect(alert.textContent).toBe('Failed to initiate sign in.');
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.textContent).toContain('Continue with Google');
  });
});
