/**
 * Tests for the billing page auth/error and action-guard handling
 *
 * Purpose: Verify the billing page sends unauthorized status loads back into
 * the auth flow while preserving the existing generic outage UI for other
 * shared-client failures.
 *
 * Connects to:
 * - src/pages/billing/index.js
 * - src/client/contexts/AuthContext.js
 * - src/client/hooks/useBillingActions.js
 * - src/client/lib/api.js
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};

const mockUseAuth = jest.fn();
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockRandomUUID = jest.fn();
const checkoutAttemptUuid = '01234567-89ab-cdef-0123-456789abcdef';
const checkoutAttemptNonce = '0123456789abcdef0123456789abcdef';
const retryCheckoutAttemptUuid = 'fedcba98-7654-3210-fedc-ba9876543210';
const retryCheckoutAttemptNonce = 'fedcba9876543210fedcba9876543210';

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('next/link', () => {
  const React = require('react');

  return function MockLink({ href, children, ...props }) {
    return React.createElement('a', { href, ...props }, children);
  };
});

jest.mock('../../../client/components/ProfileDropdown', () => {
  const React = require('react');

  return function MockProfileDropdown() {
    return React.createElement('div', { 'data-testid': 'profile-dropdown' });
  };
});

jest.mock('../../../client/contexts/AuthContext', () => ({
  useAuth: mockUseAuth,
}));

jest.mock('../../../client/lib/api.js', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
    post: (...args) => mockApiPost(...args),
  },
}));

let BillingPage;
let container;
let root;

/**
 * Render the billing page into a detached jsdom root and flush the initial
 * mount effects so load-state assertions can inspect the settled UI.
 *
 * @returns {Promise<HTMLElement>}
 */
async function renderBillingPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(BillingPage));
  });

  await flushEffects();
  return container;
}

/**
 * Flush one microtask turn for async effects triggered by the billing page's
 * initial load request.
 *
 * @returns {Promise<void>}
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Create a deferred promise so action-button tests can keep the redirect flow
 * in-flight while they trigger repeated clicks against the same handler.
 *
 * @returns {{ promise: Promise<any>, resolve: (value: any) => void, reject: (reason?: any) => void }}
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

/**
 * Build a shared-client response containing one successful API payload.
 *
 * @param {object} data - Endpoint-specific response data.
 * @returns {object} Shared-client success result.
 */
function buildApiSuccess(data) {
  return {
    data: { data },
    error: null,
    meta: { status: 200, retryAfterSeconds: null },
  };
}

/**
 * Build a standardized action failure without exposing its raw message to UI.
 *
 * @param {string} code - Public server error code.
 * @param {number} status - HTTP response status.
 * @param {number|null} retryAfterSeconds - Optional shared cooldown metadata.
 * @returns {object} Shared-client error result.
 */
function buildActionError(code, status, retryAfterSeconds = null) {
  return {
    data: { error: code, message: 'raw action details must not render' },
    error: null,
    meta: { status, retryAfterSeconds },
  };
}

/**
 * Configure a canonical canceled subscription that permits both page actions.
 *
 * Purpose: exercise page-level Checkout/portal mutual exclusion with both
 * controls rendered from one verified local billing snapshot.
 */
function allowCheckoutAndPortal() {
  mockApiGet.mockResolvedValue(buildApiSuccess({
    status: 'canceled',
    hasSubscription: true,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasPortalCustomer: true,
  }));
}

/**
 * Dispatch a bubbling click event that React's event system will receive.
 *
 * @param {HTMLElement} target
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Dispatch two clicks in one React turn to reproduce a pre-render action race.
 *
 * @param {HTMLElement} firstTarget - First billing action.
 * @param {HTMLElement} secondTarget - Competing billing action.
 */
function clickInSameTurn(firstTarget, secondTarget) {
  act(() => {
    firstTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    secondTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Find a rendered button by its visible text content.
 *
 * @param {HTMLElement} el
 * @param {string} text
 * @returns {HTMLButtonElement | null}
 */
function findButtonByText(el, text) {
  return Array.from(el.querySelectorAll('button')).find((button) => button.textContent.includes(text)) ?? null;
}

/**
 * Unmount the current React root and remove the test container so each test
 * starts with a clean DOM and router/auth mock state.
 */
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

describe('BillingPage', () => {
  beforeAll(() => {
    BillingPage = require('../../../pages/billing/index.js').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    if (!globalThis.crypto) {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    }

    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: mockRandomUUID,
      configurable: true,
    });
    mockRandomUUID.mockReturnValue(checkoutAttemptUuid);
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut: jest.fn().mockResolvedValue({ error: null }),
    });
    mockApiGet.mockResolvedValue({
      data: {
        data: {
          status: 'free',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasPortalCustomer: false,
        },
      },
      error: null,
      meta: { status: 200, retryAfterSeconds: null },
    });
    mockApiPost.mockReset();
  });

  afterEach(cleanup);

  it('signs out and redirects to login on shared-client 401 errors', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut,
    });
    mockApiGet.mockResolvedValue({
      data: null,
      error: ERROR_MESSAGES.UNAUTHORIZED,
      meta: { status: 401, retryAfterSeconds: null },
    });

    const el = await renderBillingPage();

    expect(mockApiGet).toHaveBeenCalledWith('/api/billing/status');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
    expect(el.textContent).not.toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  });

  it('signs out and redirects to login on body-coded unauthorized results', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut,
    });
    mockApiGet.mockResolvedValue({
      data: {
        error: 'UNAUTHORIZED',
        status: 401,
        message: ERROR_MESSAGES.UNAUTHORIZED,
      },
      error: null,
      meta: { status: 401, retryAfterSeconds: null },
    });

    const el = await renderBillingPage();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
    expect(el.textContent).not.toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  });

  it('keeps showing service unavailable for non-401 shared-client request failures', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut,
    });
    mockApiGet.mockResolvedValue({
      data: null,
      error: ERROR_MESSAGES.FETCH_FAILED,
      meta: { status: null, retryAfterSeconds: null },
    });

    const el = await renderBillingPage();

    expect(signOut).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(el.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  });

  it('shows service unavailable when the billing status request rejects', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut,
    });
    mockApiGet.mockRejectedValue(new Error('network unavailable'));

    const el = await renderBillingPage();

    expect(signOut).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(el.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(el.textContent).not.toContain('Loading...');
  });

  it('prevents duplicate checkout submissions while the redirect action is in flight', async () => {
    const deferredPost = createDeferred();
    mockApiPost.mockImplementation(() => deferredPost.promise);

    const el = await renderBillingPage();
    const checkoutButton = findButtonByText(el, 'Start checkout');

    expect(checkoutButton).toBeTruthy();

    click(checkoutButton);
    click(checkoutButton);

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/billing/checkout', expect.objectContaining({
      plan: 'premium_monthly',
      checkoutAttemptNonce,
    }));
  });

  it('prevents duplicate portal submissions while the redirect action is in flight', async () => {
    const deferredPost = createDeferred();
    mockApiGet.mockResolvedValue({
      data: {
        data: {
          status: 'past_due',
          hasSubscription: true,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasPortalCustomer: true,
        },
      },
      error: null,
      meta: { status: 200, retryAfterSeconds: null },
    });
    mockApiPost.mockImplementation(() => deferredPost.promise);

    const el = await renderBillingPage();
    const portalButton = findButtonByText(el, 'Open billing portal');

    expect(portalButton).toBeTruthy();

    click(portalButton);
    click(portalButton);

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/billing/portal', {});
  });

  it.each([
    ['Checkout then portal', 'Start checkout', 'Open billing portal', '/api/billing/checkout'],
    ['portal then Checkout', 'Open billing portal', 'Start checkout', '/api/billing/portal'],
  ])('prevents overlapping actions for %s in the same render turn', async (
    _label,
    firstButtonText,
    secondButtonText,
    expectedEndpoint
  ) => {
    const deferredPost = createDeferred();
    allowCheckoutAndPortal();
    mockApiPost.mockImplementation(() => deferredPost.promise);

    const el = await renderBillingPage();
    const firstButton = findButtonByText(el, firstButtonText);
    const secondButton = findButtonByText(el, secondButtonText);

    expect(firstButton).toBeTruthy();
    expect(secondButton).toBeTruthy();

    clickInSameTurn(firstButton, secondButton);

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost.mock.calls[0][0]).toBe(expectedEndpoint);
  });

  it('renders sanitized action errors and retries Checkout with a fresh nonce', async () => {
    mockRandomUUID
      .mockReturnValueOnce(checkoutAttemptUuid)
      .mockReturnValueOnce(retryCheckoutAttemptUuid);
    mockApiPost.mockResolvedValue(buildActionError('CHECKOUT_SESSION_FAILED', 503));

    const el = await renderBillingPage();

    click(findButtonByText(el, 'Start checkout'));
    await flushEffects();

    expect(el.textContent).toContain(ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
    expect(el.textContent).not.toContain('raw action details must not render');
    expect(findButtonByText(el, 'Start checkout').disabled).toBe(false);

    click(findButtonByText(el, 'Start checkout'));
    await flushEffects();

    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/api/billing/checkout', {
      plan: 'premium_monthly',
      checkoutAttemptNonce,
    });
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/api/billing/checkout', {
      plan: 'premium_monthly',
      checkoutAttemptNonce: retryCheckoutAttemptNonce,
    });
  });

  it('routes typed Checkout authorization failures through auth recovery', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
      signOut,
    });
    mockApiPost.mockResolvedValue(buildActionError('UNAUTHORIZED', 401));

    const el = await renderBillingPage();

    click(findButtonByText(el, 'Start checkout'));
    await flushEffects();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
    expect(el.textContent).not.toContain('raw action details must not render');
  });

  it('presents Retry-After and blocks both actions during the shared cooldown', async () => {
    allowCheckoutAndPortal();
    mockApiPost.mockResolvedValue(buildActionError('RATE_LIMIT_EXCEEDED', 429, 12));

    const el = await renderBillingPage();

    click(findButtonByText(el, 'Start checkout'));
    await flushEffects();

    const checkoutButton = findButtonByText(el, 'Start checkout');
    const portalButton = findButtonByText(el, 'Open billing portal');

    expect(el.textContent).toContain(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED);
    expect(el.textContent).toContain('Try again in 12s.');
    expect(checkoutButton.disabled).toBe(true);
    expect(portalButton.disabled).toBe(true);

    clickInSameTurn(checkoutButton, portalButton);
    expect(mockApiPost).toHaveBeenCalledTimes(1);
  });

  it('shows exact storage downgrade counts for canceling Premium overflow', async () => {
    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api/storage/status') {
        return Promise.resolve({
          data: {
            data: {
              status: 'premium_canceling',
              activeLimit: 300,
              absoluteRetainedLimit: 1000,
              activeCount: 450,
              lockedCount: 0,
              retainedTotalCount: 450,
              projectedOverflowCount: 150,
              cancelAtPeriodEnd: true,
              currentPeriodEnd: '2026-07-15T12:00:00.000Z',
            },
          },
          error: null,
          meta: { status: 200, retryAfterSeconds: null },
        });
      }

      return Promise.resolve({
        data: {
          data: {
            status: 'active',
            currentPeriodEnd: '2026-07-15T12:00:00.000Z',
            cancelAtPeriodEnd: true,
            hasPortalCustomer: true,
          },
        },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      });
    });

    const el = await renderBillingPage();

    expect(mockApiGet).toHaveBeenCalledWith('/api/storage/status');
    expect(el.textContent).toContain('Storage after cancellation');
    expect(el.textContent).toContain('July 15, 2026');
    expect(el.textContent).toContain('450');
    expect(el.textContent).toContain('150');
    expect(el.textContent).toContain('Nothing will be deleted');
  });

  it('does not show confirmed downgrade copy for billing-unavailable storage status', async () => {
    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api/storage/status') {
        return Promise.resolve({
          data: {
            data: {
              status: 'billing_unavailable',
              activeLimit: 300,
              activeCount: 450,
              lockedCount: 0,
              projectedOverflowCount: 150,
              cancelAtPeriodEnd: true,
              currentPeriodEnd: '2026-07-15T12:00:00.000Z',
            },
          },
          error: null,
          meta: { status: 200, retryAfterSeconds: null },
        });
      }

      return Promise.resolve({
        data: {
          data: {
            status: 'active',
            currentPeriodEnd: '2026-07-15T12:00:00.000Z',
            cancelAtPeriodEnd: true,
            hasPortalCustomer: true,
          },
        },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      });
    });

    const el = await renderBillingPage();

    expect(el.textContent).not.toContain('Storage after cancellation');
    expect(el.textContent).not.toContain('Free storage archive');
  });

  it('shows free storage archive notice and export link for terminal_free status', async () => {
    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api/storage/status') {
        return Promise.resolve({
          data: {
            data: {
              status: 'terminal_free',
              activeLimit: 300,
              activeCount: 280,
              lockedCount: 25,
              projectedOverflowCount: 0,
              cancelAtPeriodEnd: false,
              currentPeriodEnd: null,
            },
          },
          error: null,
          meta: { status: 200, retryAfterSeconds: null },
        });
      }

      return Promise.resolve({
        data: {
          data: {
            status: 'free',
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            hasPortalCustomer: false,
          },
        },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      });
    });

    const el = await renderBillingPage();

    expect(el.textContent).toContain('Free storage archive');
    expect(el.textContent).toContain('280');
    expect(el.textContent).toContain('25 archived applications');
    expect(el.querySelector('a[href="/api/storage/export"]')).toBeTruthy();
  });

  it('shows a storage-status warning when storage metadata fails after billing loads', async () => {
    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api/storage/status') {
        return Promise.resolve({
          data: {
            error: 'SERVICE_UNAVAILABLE',
            message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
          },
          error: null,
          meta: { status: 503, retryAfterSeconds: null },
        });
      }

      return Promise.resolve({
        data: {
          data: {
            status: 'active',
            currentPeriodEnd: '2026-07-15T12:00:00.000Z',
            cancelAtPeriodEnd: true,
            hasPortalCustomer: true,
          },
        },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      });
    });

    const el = await renderBillingPage();

    expect(mockApiGet).toHaveBeenCalledWith('/api/storage/status');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Storage details are temporarily unavailable');
    expect(el.textContent).toContain('Local status');
    expect(el.textContent).not.toContain('Storage after cancellation');
    expect(el.textContent).not.toContain('Free storage archive');
  });
});
