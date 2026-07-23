/**
 * Tests for StorageDowngradeBanner.
 *
 * Purpose: verify scheduled downgrade warnings render only from safe
 * premium_canceling storage summaries with positive projected overflow.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

/**
 * Renders a React element into a detached jsdom root.
 *
 * @param {import('react').ReactElement} element - Element under test.
 * @returns {HTMLElement} Rendered container.
 */
function render(element) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return container;
}

/**
 * Removes the active jsdom root and DOM container after each test.
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

describe('StorageDowngradeBanner', () => {
  let StorageDowngradeBanner;

  beforeAll(() => {
    StorageDowngradeBanner = require('../StorageDowngradeBanner').default;
  });

  afterEach(cleanup);

  it('renders exact date and counts for canceling Premium overflow', () => {
    const el = render(React.createElement(StorageDowngradeBanner, {
      storageSummary: {
        status: STORAGE_STATUSES.PREMIUM_CANCELING,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-07-15T12:00:00.000Z',
        activeLimit: 300,
        activeCount: 450,
        projectedOverflowCount: 150,
      },
    }));

    expect(el.textContent).toContain('Premium storage ending');
    expect(el.textContent).toContain('July 15, 2026');
    expect(el.textContent).toContain('300 active');
    expect(el.textContent).toContain('450');
    expect(el.textContent).toContain('150');
    expect(el.textContent).toContain('Nothing will be deleted');
    const billingLink = Array.from(el.querySelectorAll('a')).find(
      (link) => link.textContent === 'Review billing',
    );
    expect(billingLink?.getAttribute('href')).toBe('/billing');
  });

  it('does not render downgrade copy for ambiguous storage states', () => {
    const el = render(React.createElement(StorageDowngradeBanner, {
      storageSummary: {
        status: STORAGE_STATUSES.BILLING_UNAVAILABLE,
        cancelAtPeriodEnd: true,
        activeLimit: 300,
        activeCount: 450,
        projectedOverflowCount: 150,
      },
    }));

    expect(el.textContent).toBe('');
  });
});
