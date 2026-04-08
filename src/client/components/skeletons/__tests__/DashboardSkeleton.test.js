/**
 * Tests for DashboardSkeleton component.
 *
 * Purpose: Verify the full-page dashboard loading skeleton renders the real
 * page chrome (header title, footer attribution, skeleton rows/cards) and
 * exposes a status role for assistive tech.
 *
 * Connects to: src/client/components/skeletons/DashboardSkeleton.jsx
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

function render(element) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

function cleanup() {
  if (root) {
    act(() => root.unmount());
  }
  if (container && container.parentNode) {
    document.body.removeChild(container);
  }
  container = null;
  root = null;
}

afterEach(cleanup);

describe('DashboardSkeleton', () => {
  let DashboardSkeleton;

  beforeAll(() => {
    DashboardSkeleton = require('../DashboardSkeleton').default;
  });

  it('renders the real header title so the shell matches the live dashboard', () => {
    const el = render(React.createElement(DashboardSkeleton));
    expect(el.querySelector('h1').textContent).toBe('Track The App');
  });

  it('exposes a status role with an sr-only loading label', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const status = el.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('Loading dashboard');
  });

  it('renders the footer attribution link outside the status region', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const footer = el.querySelector('footer');
    expect(footer).toBeTruthy();
    expect(footer.textContent).toContain('Icon');

    // Footer must not be announced as part of the loading status
    const status = el.querySelector('[role="status"]');
    expect(status.contains(footer)).toBe(false);
  });

  it('renders 6 desktop skeleton rows', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const rows = el.querySelectorAll('[data-testid="skeleton-row"]');
    expect(rows.length).toBe(6);
  });

  it('renders 4 mobile skeleton cards', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const cards = el.querySelectorAll('[data-testid="skeleton-card"]');
    expect(cards.length).toBe(4);
  });

  it('applies the delayed fade-in animation to prevent flicker on fast loads', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const outer = el.firstChild;
    expect(outer.className).toContain('animate-skeleton-in');
  });
});
