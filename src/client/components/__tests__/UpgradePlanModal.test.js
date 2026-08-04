/**
 * Tests for the Dashboard Premium upgrade modal controller.
 *
 * Purpose: verify canonical-status loading, lifecycle race protection,
 * Checkout outcome routing, and accessible idle/busy dismissal behavior.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockApiGet = jest.fn();
const mockUseBillingActions = jest.fn();
const mockResetActionState = jest.fn();
const mockStartCheckout = jest.fn();

jest.mock('../../lib/api.js', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
  },
}));

jest.mock('../../hooks/useBillingActions.js', () => ({
  BILLING_ACTION_RESULT_STATUSES: Object.freeze({
    REDIRECTING: 'redirecting',
    ERROR: 'error',
    IGNORED: 'ignored',
  }),
  useBillingActions: (...args) => mockUseBillingActions(...args),
}));

let UpgradePlanModal;
let container;
let root;
let billingActions;

const TEST_PLAN = Object.freeze({
  planId: 'premium_monthly',
  displayName: 'Premium',
  title: 'Premium Features',
  checkoutHelperText: "You'll review pricing and payment details in Stripe Checkout before confirming.",
  benefits: Object.freeze([
    'Up to 1,000 active applications, compared with 300 on Free.',
  ]),
});

const FREE_BILLING_STATUS = Object.freeze({
  entitled: false,
  entitlement: null,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  hasCustomerMapping: false,
  hasPortalCustomer: false,
  hasSubscription: false,
});

/**
 * Build a complete canonical billing snapshot with selected field overrides.
 *
 * @param {object} [overrides] - Canonical billing field overrides.
 * @returns {object} Complete local billing snapshot.
 */
function buildBillingStatus(overrides = {}) {
  return { ...FREE_BILLING_STATUS, ...overrides };
}

/**
 * Build a successful canonical billing-status response.
 *
 * @param {object} billingStatus - Local billing snapshot.
 * @returns {object} Shared-client response fixture.
 */
function buildStatusSuccess(billingStatus = buildBillingStatus()) {
  return {
    data: { data: billingStatus, error: null },
    error: null,
    meta: { status: 200, retryAfterSeconds: null },
  };
}

/**
 * Create a controllable promise for close/reopen race tests.
 *
 * @returns {{promise: Promise<object>, resolve: Function}} Deferred handle.
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Render the modal with stable default callbacks.
 *
 * @param {object} [props] - Modal prop overrides.
 * @returns {HTMLElement} Rendered DOM container.
 */
function renderModal(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(UpgradePlanModal, {
      isOpen: true,
      plan: TEST_PLAN,
      onClose: jest.fn(),
      onUnauthorized: jest.fn(),
      onGoToBilling: jest.fn(),
      ...props,
    }));
  });

  return container;
}

/**
 * Re-render the active modal root with a complete prop set.
 *
 * @param {object} props - Complete next modal props.
 * @returns {void}
 */
function rerenderModal(props) {
  act(() => {
    root.render(React.createElement(UpgradePlanModal, props));
  });
}

/**
 * Flush pending promise continuations and React effect state.
 *
 * @returns {Promise<void>}
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Dispatch a bubbling click through React's event delegation.
 *
 * @param {HTMLElement} target - Element to click.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Click a control and flush its asynchronous callback.
 *
 * @param {HTMLElement} target - Element to click.
 * @returns {Promise<void>}
 */
async function clickAsync(target) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/**
 * Find a button by exact visible text.
 *
 * @param {HTMLElement} element - Root element to search.
 * @param {string} text - Exact button label.
 * @returns {HTMLButtonElement|undefined} Matching button.
 */
function findButtonByText(element, text) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/** Remove the active React root and all test-owned DOM nodes. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = null;
  root = null;
}

describe('UpgradePlanModal', () => {
  beforeAll(() => {
    UpgradePlanModal = require('../UpgradePlanModal.jsx').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGet.mockResolvedValue(buildStatusSuccess());
    mockStartCheckout.mockResolvedValue({ status: 'redirecting', error: null });
    billingActions = {
      actionLoading: '',
      actionError: null,
      retryAfterSeconds: null,
      resetActionState: mockResetActionState,
      startCheckout: mockStartCheckout,
      openPortal: jest.fn(),
    };
    mockUseBillingActions.mockImplementation(() => billingActions);
  });

  afterEach(cleanup);

  it('does not read status while closed and reads once when opened', async () => {
    const baseProps = {
      isOpen: false,
      plan: TEST_PLAN,
      onClose: jest.fn(),
      onUnauthorized: jest.fn(),
      onGoToBilling: jest.fn(),
    };
    renderModal(baseProps);

    expect(mockApiGet).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    rerenderModal({ ...baseProps, isOpen: true });
    await flushEffects();

    expect(mockApiGet).toHaveBeenCalledTimes(1);
    expect(mockApiGet).toHaveBeenCalledWith('/api/billing/status');
    expect(mockStartCheckout).not.toHaveBeenCalled();
    const dashboardCard = container.querySelector('section[aria-labelledby]');
    expect(dashboardCard.className).toContain('dashboard-raised-panel');
    expect(dashboardCard.className).not.toContain('bg-white');
    expect(document.body.style.overflow).toBe('hidden');

    rerenderModal(baseProps);
    expect(document.body.style.overflow).toBe('');
  });

  it('enables Upgrade only after canonical eligibility and submits the catalog plan', async () => {
    const element = renderModal();

    expect(findButtonByText(element, 'Checking availability…').disabled).toBe(true);
    await flushEffects();

    const upgradeButton = findButtonByText(element, 'Upgrade');
    expect(upgradeButton.disabled).toBe(false);

    await clickAsync(upgradeButton);
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
    expect(mockStartCheckout).toHaveBeenCalledWith('premium_monthly');
  });

  it.each([
    'canceled',
    'incomplete_expired',
  ])('preserves Upgrade eligibility for canonical %s subscriptions', async (status) => {
    mockApiGet.mockResolvedValue(buildStatusSuccess(buildBillingStatus({
      status,
      hasCustomerMapping: true,
      hasPortalCustomer: true,
      hasSubscription: true,
    })));
    const element = renderModal();
    await flushEffects();

    expect(findButtonByText(element, 'Upgrade').disabled).toBe(false);
  });

  it('routes a canonical ineligible snapshot to Billing', async () => {
    const onGoToBilling = jest.fn();
    mockApiGet.mockResolvedValue(buildStatusSuccess(buildBillingStatus({
      hasSubscription: true,
      status: 'active',
    })));
    const element = renderModal({ onGoToBilling });
    await flushEffects();

    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    click(findButtonByText(element, 'Go to billing'));

    expect(onGoToBilling).toHaveBeenCalledTimes(1);
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('keeps Upgrade unavailable after failure and retries the canonical read', async () => {
    mockApiGet
      .mockResolvedValueOnce({
        data: { error: 'SERVICE_UNAVAILABLE', message: 'raw server detail' },
        error: null,
        meta: { status: 503, retryAfterSeconds: null },
      })
      .mockResolvedValueOnce(buildStatusSuccess());
    const element = renderModal();
    await flushEffects();

    expect(element.textContent).not.toContain('raw server detail');
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();

    click(findButtonByText(element, 'Retry'));
    expect(mockApiGet).toHaveBeenCalledTimes(2);
    await flushEffects();

    expect(findButtonByText(element, 'Upgrade').disabled).toBe(false);
  });

  it.each([
    ['a null snapshot', null],
    ['an empty object', {}],
    ['an incomplete object', { hasSubscription: false }],
    ['a non-boolean subscription flag', buildBillingStatus({
      hasSubscription: 'false',
    })],
    ['an unknown subscription status', buildBillingStatus({
      status: 'trialing',
      hasSubscription: true,
    })],
    ['entitled access without an entitlement', buildBillingStatus({
      entitled: true,
    })],
    ['an entitlement without entitled access', buildBillingStatus({
      entitlement: 'premium',
    })],
  ])('treats %s as a retryable status error', async (_label, billingStatus) => {
    mockApiGet.mockResolvedValue(buildStatusSuccess(billingStatus));
    const element = renderModal();
    await flushEffects();

    expect(findButtonByText(element, 'Retry')).toBeTruthy();
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
  });

  it('routes an unauthorized status read to the supplied recovery callback', async () => {
    const onUnauthorized = jest.fn();
    mockApiGet.mockResolvedValue({
      data: null,
      error: ERROR_MESSAGES.UNAUTHORIZED,
      meta: { status: 401, retryAfterSeconds: null },
    });
    renderModal({ onUnauthorized });
    await flushEffects();

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('ignores a status response that resolves after the modal closes', async () => {
    const deferred = createDeferred();
    const props = {
      isOpen: true,
      plan: TEST_PLAN,
      onClose: jest.fn(),
      onUnauthorized: jest.fn(),
      onGoToBilling: jest.fn(),
    };
    mockApiGet.mockReturnValue(deferred.promise);
    renderModal(props);

    rerenderModal({ ...props, isOpen: false });
    await act(async () => {
      deferred.resolve(buildStatusSuccess());
      await deferred.promise;
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('applies only the newest response after a close and reopen', async () => {
    const firstRequest = createDeferred();
    const secondRequest = createDeferred();
    const props = {
      isOpen: true,
      plan: TEST_PLAN,
      onClose: jest.fn(),
      onUnauthorized: jest.fn(),
      onGoToBilling: jest.fn(),
    };
    mockApiGet
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const element = renderModal(props);

    rerenderModal({ ...props, isOpen: false });
    rerenderModal({ ...props, isOpen: true });

    await act(async () => {
      secondRequest.resolve(buildStatusSuccess(buildBillingStatus({
        hasSubscription: true,
        status: 'active',
      })));
      await secondRequest.promise;
    });
    expect(findButtonByText(element, 'Go to billing')).toBeTruthy();

    await act(async () => {
      firstRequest.resolve(buildStatusSuccess());
      await firstRequest.promise;
    });

    expect(findButtonByText(element, 'Go to billing')).toBeTruthy();
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
  });

  it('routes typed Checkout unauthorized outcomes to auth recovery', async () => {
    const onUnauthorized = jest.fn();
    mockStartCheckout.mockResolvedValue({
      status: 'error',
      error: {
        code: 'UNAUTHORIZED',
        message: ERROR_MESSAGES.UNAUTHORIZED,
        httpStatus: 401,
        retryAfterSeconds: null,
      },
    });
    const element = renderModal({ onUnauthorized });
    await flushEffects();

    await clickAsync(findButtonByText(element, 'Upgrade'));

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(mockResetActionState).toHaveBeenCalledTimes(2);
  });

  it('converts a Checkout 409 into the Billing fallback', async () => {
    mockStartCheckout.mockResolvedValue({
      status: 'error',
      error: {
        code: 'CHECKOUT_SESSION_FAILED',
        message: 'Your billing status changed. Review billing before continuing.',
        httpStatus: 409,
        retryAfterSeconds: null,
      },
    });
    const element = renderModal();
    await flushEffects();

    await clickAsync(findButtonByText(element, 'Upgrade'));

    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    expect(findButtonByText(element, 'Go to billing')).toBeTruthy();
  });

  it('closes from backdrop and Escape while content clicks remain inert', async () => {
    const onClose = jest.fn();
    const element = renderModal({ onClose });
    await flushEffects();
    const dialog = element.querySelector('[role="dialog"]');
    const backdrop = dialog.parentElement;
    const closeButton = dialog.querySelector('button');

    click(dialog.querySelector('section'));
    expect(onClose).not.toHaveBeenCalled();

    click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);

    click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('traps Tab focus and restores the previously focused trigger', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Dashboard Upgrade';
    document.body.appendChild(trigger);
    trigger.focus();
    mockApiGet.mockResolvedValue({
      data: { error: 'SERVICE_UNAVAILABLE' },
      error: null,
      meta: { status: 503, retryAfterSeconds: null },
    });
    const props = {
      isOpen: true,
      plan: TEST_PLAN,
      onClose: jest.fn(),
      onUnauthorized: jest.fn(),
      onGoToBilling: jest.fn(),
    };
    const element = renderModal(props);
    await flushEffects();
    const closeButton = element.querySelector('[aria-label="Close upgrade modal"]');
    const goToBillingButton = findButtonByText(element, 'Go to billing');

    expect(document.activeElement).toBe(closeButton);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      }));
    });
    expect(document.activeElement).toBe(goToBillingButton);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
      }));
    });
    expect(document.activeElement).toBe(closeButton);

    rerenderModal({ ...props, isOpen: false });
    expect(document.activeElement).toBe(trigger);
  });

  it('blocks close button, backdrop, and Escape dismissal during Checkout', async () => {
    const onClose = jest.fn();
    billingActions.actionLoading = 'checkout';
    const element = renderModal({ onClose });
    await flushEffects();
    const dialog = element.querySelector('[role="dialog"]');
    const backdrop = dialog.parentElement;
    const closeButton = element.querySelector('[aria-label="Close upgrade modal"]');

    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(closeButton.disabled).toBe(true);

    click(closeButton);
    click(backdrop);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
