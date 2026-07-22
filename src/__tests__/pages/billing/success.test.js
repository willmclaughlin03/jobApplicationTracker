/**
 * Tests for the billing success page rejected-poll handling
 *
 * Purpose: Verify a rejected checkout-status poll settles the page into a
 * terminal error state instead of leaving the UI in the continuing poll flow.
 *
 * Connects to:
 * - src/pages/billing/success.js
 * - src/client/contexts/AuthContext.js
 * - src/client/lib/api.js
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockRouter = {
  isReady: true,
  push: jest.fn(),
  query: { session_id: 'cs_test_123' },
};

const mockUseAuth = jest.fn();
const mockApiPost = jest.fn();

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('next/link', () => {
  const React = require('react');

  return function MockLink({ href, children, ...props }) {
    return React.createElement('a', { href, ...props }, children);
  };
});

jest.mock('../../../client/contexts/AuthContext', () => ({
  useAuth: mockUseAuth,
}));

jest.mock('../../../client/lib/api.js', () => ({
  api: {
    post: (...args) => mockApiPost(...args),
  },
}));

let BillingSuccessPage;
let container;
let root;

/**
 * Render the billing success page into a detached jsdom root and flush the
 * initial mount work so assertions can inspect the settled UI.
 *
 * @returns {Promise<HTMLElement>}
 */
async function renderBillingSuccessPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(BillingSuccessPage));
  });

  await flushAsyncWork();
  return container;
}

/**
 * Flush pending microtasks created by async poll work and state updates.
 *
 * @returns {Promise<void>}
 */
async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Advance fake timers and flush the async work triggered by the fired poll.
 *
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
async function advanceTimersAndFlush(delayMs) {
  await act(async () => {
    jest.advanceTimersByTime(delayMs);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Unmount the current React root and remove the test container so each test
 * starts from a clean DOM and mock state.
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

describe('BillingSuccessPage', () => {
  beforeAll(() => {
    BillingSuccessPage = require('../../../pages/billing/success.js').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockRouter.isReady = true;
    mockRouter.query = { session_id: 'cs_test_123' };
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'billing@example.com' },
      loading: false,
    });
    mockApiPost.mockReset();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('stops polling and shows a terminal error when a checkout-status poll rejects', async () => {
    mockApiPost
      .mockResolvedValueOnce({
        data: { data: { state: 'pending' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      })
      .mockRejectedValueOnce(new Error('checkout-status failed'));

    const el = await renderBillingSuccessPage();

    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/api/billing/checkout-status', {
      sessionId: 'cs_test_123',
    });
    expect(el.textContent).toContain('Finalizing billing');

    await advanceTimersAndFlush(3000);

    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Checkout could not be confirmed');
    expect(el.textContent).toContain(
      'The redirect completed, but premium access was not confirmed from local billing state.'
    );
    expect(el.textContent).not.toContain('Please wait for payment status to update');
    expect(el.textContent).not.toContain('Finalizing billing');
    expect(el.textContent).not.toContain('Polling schedule');
    expect(el.textContent).not.toContain('0s, 3s, 10s, 30s, and 60s');
    expect(el.textContent).not.toContain('Refresh status');

    await advanceTimersAndFlush(60000);

    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });

  it('shows a terminal error without polling when the checkout session id is missing', async () => {
    mockRouter.query = {};

    const el = await renderBillingSuccessPage();

    expect(mockApiPost).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Checkout could not be confirmed');
    expect(el.textContent).not.toContain('Please wait for payment status to update');
    expect(el.textContent).not.toContain('Refresh status');
  });

  it('reserves payment-status wait copy for an explicit unresolved status', async () => {
    mockApiPost
      .mockResolvedValueOnce({
        data: { data: { state: 'error' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      })
      .mockResolvedValueOnce({
        data: { data: { state: 'active' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      });

    const el = await renderBillingSuccessPage();
    const refreshButton = el.querySelector('button');

    if (!refreshButton) {
      throw new Error('Expected the unresolved payment-status refresh button to render.');
    }

    expect(el.textContent).toContain('Please wait for payment status to update');
    expect(el.textContent).not.toContain('Checkout could not be confirmed');
    expect(el.textContent).not.toContain('Polling schedule');
    expect(el.textContent).not.toContain('0s, 3s, 10s, 30s, and 60s');
    expect(refreshButton.textContent).toBe('Refresh status');
    expect(refreshButton.disabled).toBe(false);

    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/api/billing/checkout-status', {
      sessionId: 'cs_test_123',
    });
    expect(el.textContent).toContain('Premium access is active');
    expect(el.textContent).not.toContain('Please wait for payment status to update');

    await advanceTimersAndFlush(60_001);

    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });

  it('latches manual refresh clicks until the refresh-triggered poll settles', async () => {
    mockApiPost
      .mockResolvedValueOnce({
        data: { error: 'RATE_LIMIT_EXCEEDED' },
        error: null,
        meta: { status: 429, retryAfterSeconds: 0 },
      })
      .mockImplementationOnce(() => new Promise(() => {}));

    const el = await renderBillingSuccessPage();
    const refreshButton = el.querySelector('button[type="button"]');

    if (!refreshButton) {
      throw new Error('Expected the manual refresh button to render.');
    }

    expect(refreshButton.disabled).toBe(false);
    expect(el.textContent).toContain('Polling paused');

    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });

    await flushAsyncWork();

    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(refreshButton.disabled).toBe(true);

    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });

    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });
});
