/**
 * Tests for the presentational Premium upgrade card.
 *
 * Purpose: lock approved plan content, semantic structure, CTA states, and
 * callback behavior without coupling the card to billing APIs or routing.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let PlanUpgradeCard;
let UPGRADE_ELIGIBILITY_STATES;
let container;
let root;

const TEST_PLAN = Object.freeze({
  planId: 'premium_monthly',
  displayName: 'Premium',
  title: 'Premium Features',
  checkoutHelperText: "You'll review pricing and payment details in Stripe Checkout before confirming.",
  benefits: Object.freeze([
    'Up to 1,000 active applications, compared with 300 on Free.',
  ]),
});

/**
 * Render one card state into a detached jsdom root.
 *
 * @param {object} [props] - Card prop overrides.
 * @returns {HTMLElement} Rendered container.
 */
function renderCard(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(PlanUpgradeCard, {
      plan: TEST_PLAN,
      headingId: 'premium-card-title',
      eligibilityState: UPGRADE_ELIGIBILITY_STATES.ELIGIBLE,
      actionLoading: false,
      actionError: null,
      retryAfterSeconds: null,
      onUpgrade: jest.fn(),
      onRetryStatus: jest.fn(),
      onGoToBilling: jest.fn(),
      ...props,
    }));
  });

  return container;
}

/**
 * Find a rendered button by exact visible text.
 *
 * @param {HTMLElement} element - Root element to search.
 * @param {string} text - Exact visible button label.
 * @returns {HTMLButtonElement|undefined} Matching button.
 */
function findButtonByText(element, text) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/**
 * Dispatch one bubbling click through React's event delegation.
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
 * Assert the opt-in dashboard variant does not fall back to light/blue styles.
 *
 * @param {HTMLElement} element - Rendered dashboard card container.
 * @returns {void}
 */
function expectDashboardAppearance(element) {
  const card = element.querySelector('section');
  expect(card.className).toContain('dashboard-raised-panel');
  expect(element.innerHTML).not.toContain('bg-white');
  expect(element.innerHTML).not.toContain('blue-');
  expect(element.innerHTML).not.toContain('gray-');
}

/** Remove the active React root and DOM container after each test. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  container?.remove();
  container = null;
  root = null;
}

describe('PlanUpgradeCard', () => {
  beforeAll(() => {
    ({
      default: PlanUpgradeCard,
      UPGRADE_ELIGIBILITY_STATES,
    } = require('../PlanUpgradeCard.jsx'));
  });

  afterEach(cleanup);

  it('renders the approved outlined plan structure and full-width Upgrade control', () => {
    const onUpgrade = jest.fn();
    const element = renderCard({ onUpgrade });
    const card = element.querySelector('section');
    const heading = element.querySelector('#premium-card-title');
    const upgradeButton = findButtonByText(element, 'Upgrade');

    expect(card.className).toContain('border');
    expect(card.className).toContain('max-w-md');
    expect(card.className).toContain('bg-white');
    expect(card.getAttribute('aria-labelledby')).toBe('premium-card-title');
    expect(heading.textContent).toBe('Premium Features');
    expect(element.textContent).toContain('Premium');
    expect(element.querySelectorAll('ul li')).toHaveLength(1);
    expect(element.querySelector('ul').textContent).toContain(TEST_PLAN.benefits[0]);
    expect(element.textContent).toContain(TEST_PLAN.checkoutHelperText);
    expect(upgradeButton.disabled).toBe(false);
    expect(upgradeButton.className).toContain('w-full');
    expect(upgradeButton.className).toContain('bg-blue-600');

    click(upgradeButton);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('keeps Upgrade disabled while canonical availability is checking', () => {
    const element = renderCard({
      eligibilityState: UPGRADE_ELIGIBILITY_STATES.CHECKING,
      appearance: 'dashboard',
    });
    const button = findButtonByText(element, 'Checking availability…');

    expect(button.disabled).toBe(true);
    expect(element.querySelector('[role="status"]').textContent).toContain(
      'Checking your current billing status.'
    );
    expectDashboardAppearance(element);
  });

  it('uses the dashboard appearance for an eligible Upgrade action', () => {
    const element = renderCard({ appearance: 'dashboard' });
    const button = findButtonByText(element, 'Upgrade');

    expectDashboardAppearance(element);
    expect(button.className).toContain('bg-dashboard-accent');
    expect(button.className).toContain('text-dashboard-accent-ink');
  });

  it('shows an active redirect label and disables the primary action', () => {
    const element = renderCard({ actionLoading: true, appearance: 'dashboard' });
    const button = findButtonByText(element, 'Redirecting to checkout…');

    expect(button.disabled).toBe(true);
    expectDashboardAppearance(element);
  });

  it('renders a bounded cooldown and sanitized rate-limit error', () => {
    const element = renderCard({
      actionError: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded. Please try again later.',
        httpStatus: 429,
        retryAfterSeconds: 12,
      },
      retryAfterSeconds: 12,
      appearance: 'dashboard',
    });
    const button = findButtonByText(element, 'Try again in 12s');

    expect(button.disabled).toBe(true);
    expect(element.querySelector('[role="alert"]').textContent).toBe(
      'Rate limit exceeded. Please try again later.'
    );
    expectDashboardAppearance(element);
  });

  it('replaces Upgrade with the Billing fallback when status is ineligible', () => {
    const onGoToBilling = jest.fn();
    const element = renderCard({
      eligibilityState: UPGRADE_ELIGIBILITY_STATES.INELIGIBLE,
      onGoToBilling,
      appearance: 'dashboard',
    });

    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    expect(element.textContent).toContain(
      'Your billing status changed. Review billing before continuing.'
    );

    click(findButtonByText(element, 'Go to billing'));
    expect(onGoToBilling).toHaveBeenCalledTimes(1);
    expectDashboardAppearance(element);
  });

  it('renders Retry and Billing callbacks after a status-read failure', () => {
    const onRetryStatus = jest.fn();
    const onGoToBilling = jest.fn();
    const element = renderCard({
      eligibilityState: UPGRADE_ELIGIBILITY_STATES.ERROR,
      onRetryStatus,
      onGoToBilling,
      appearance: 'dashboard',
    });

    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    expect(element.querySelector('[role="alert"]').textContent).toContain(
      'We could not verify your billing status right now.'
    );

    click(findButtonByText(element, 'Retry'));
    click(findButtonByText(element, 'Go to billing'));

    expect(onRetryStatus).toHaveBeenCalledTimes(1);
    expect(onGoToBilling).toHaveBeenCalledTimes(1);
    expectDashboardAppearance(element);
  });

  it('shows a sanitized recoverable Checkout error without removing Upgrade', () => {
    const element = renderCard({
      actionError: {
        code: 'CHECKOUT_SESSION_FAILED',
        message: 'Unable to start checkout right now. Please try again later.',
        httpStatus: 503,
        retryAfterSeconds: null,
      },
      appearance: 'dashboard',
    });

    expect(element.querySelector('[role="alert"]').textContent).toContain(
      'Unable to start checkout right now. Please try again later.'
    );
    expect(findButtonByText(element, 'Upgrade').disabled).toBe(false);
    expectDashboardAppearance(element);
  });
});
