/**
 * Tests for DashboardSkeleton component.
 *
 * Purpose: verify the initial loading state mirrors the redesigned dashboard
 * shell without exposing decorative placeholders as real controls or content.
 *
 * Connects to: src/client/components/skeletons/DashboardSkeleton.jsx
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const postcss = require('postcss');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const GLOBAL_STYLES_PATH = join(__dirname, '../../../styles/globals.css');

let container;
let root;

/**
 * Replace Next's build-time font loader with deterministic dashboard hooks.
 */
jest.mock('next/font/google', () => ({
  Inter: jest.fn().mockReturnValue({
    variable: 'mock-dashboard-font-variable',
  }),
}));

/**
 * Render one dashboard skeleton into the test document.
 *
 * @param {React.ReactElement} element - Skeleton element under test.
 * @returns {HTMLElement} Mounted test container.
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

/** Remove the active React root and its test container. */
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

  it('renders the real responsive shell regions and scoped dashboard root', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const shell = element.querySelector('.dashboard-root');

    expect(shell).toBeTruthy();
    expect(shell.classList.contains('mock-dashboard-font-variable')).toBe(true);
    expect(element.querySelector('[data-testid="skeleton-navigation"]')).toBeTruthy();
    expect(element.querySelector('[data-testid="skeleton-filters"]')).toBeTruthy();
    expect(element.querySelector('[data-testid="skeleton-toolbar"]')).toBeTruthy();
    expect(element.querySelector('[data-testid="skeleton-pagination"]')).toBeTruthy();
  });

  it('exposes one concise loading status outside the decorative scaffold', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const status = element.querySelector('[role="status"]');
    const visual = element.querySelector('[data-testid="dashboard-skeleton-visual"]');

    expect(status).toBeTruthy();
    expect(status.textContent.trim()).toBe('Loading dashboard');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(visual.getAttribute('aria-hidden')).toBe('true');
    expect(visual.contains(status)).toBe(false);
  });

  it('keeps every placeholder non-interactive, including billing and footer geometry', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const billing = element.querySelector('[data-testid="billing-entry-skeleton"]');

    expect(billing).toBeTruthy();
    expect(billing.tagName).toBe('DIV');
    expect(billing.classList.contains('h-10')).toBe(true);
    expect(element.querySelectorAll('a, button, input, select, textarea').length).toBe(0);
  });

  it('retains the approved six-row and four-card loading density', () => {
    const element = render(React.createElement(DashboardSkeleton));

    expect(element.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(6);
    expect(element.querySelectorAll('[data-testid="skeleton-card"]').length).toBe(4);
  });

  it('matches the locked table/card and wide Filters breakpoints', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const tableFrame = element.querySelector('table').parentElement;
    const cardFrame = element.querySelector('[data-testid="skeleton-card"]').parentElement;
    const filters = element.querySelector('[data-testid="skeleton-filters"]');

    expect(tableFrame.classList.contains('lg:block')).toBe(true);
    expect(tableFrame.classList.contains('hidden')).toBe(true);
    expect(cardFrame.classList.contains('lg:hidden')).toBe(true);
    expect(filters.classList.contains('hidden')).toBe(true);
    expect(filters.classList.contains('wide:flex')).toBe(true);
  });

  it('uses emerald dashboard surfaces without the superseded light palette', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const visualMarkup = element
      .querySelector('[data-testid="dashboard-skeleton-visual"]')
      .innerHTML;

    expect(visualMarkup).toContain('bg-dashboard-surface');
    expect(visualMarkup).toContain('border-dashboard-line');
    expect(visualMarkup).not.toContain('bg-gray');
    expect(visualMarkup).not.toContain('bg-white');
  });

  it('applies the delayed fade-in animation to prevent flicker on fast loads', () => {
    const element = render(React.createElement(DashboardSkeleton));
    const visual = element.querySelector('[data-testid="dashboard-skeleton-visual"]');

    expect(visual.className).toContain('animate-skeleton-in');
  });

  it('neutralizes dashboard transitions and animations for reduced motion', () => {
    render(React.createElement(DashboardSkeleton));
    const stylesheet = postcss.parse(readFileSync(GLOBAL_STYLES_PATH, 'utf8'));
    let reducedMotionRule;
    let scopedMotionRule;

    for (const node of stylesheet.nodes) {
      if (
        node.type === 'atrule'
        && node.name === 'media'
        && node.params === '(prefers-reduced-motion: reduce)'
      ) {
        reducedMotionRule = node;
        break;
      }
    }

    expect(reducedMotionRule).toBeTruthy();

    for (const node of reducedMotionRule.nodes) {
      if (
        node.type === 'rule'
        && node.selector.includes('.dashboard-root *')
        && node.selector.includes('.dashboard-portal-theme *')
        && node.selector.includes('.animate-skeleton-in')
      ) {
        scopedMotionRule = node;
        break;
      }
    }

    expect(scopedMotionRule).toBeTruthy();
    expect(scopedMotionRule.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        prop: 'transition-duration',
        value: '0.01ms',
        important: true,
      }),
      expect.objectContaining({
        prop: 'transition-delay',
        value: '0ms',
        important: true,
      }),
      expect.objectContaining({
        prop: 'animation-duration',
        value: '0.01ms',
        important: true,
      }),
      expect.objectContaining({
        prop: 'animation-iteration-count',
        value: '1',
        important: true,
      }),
    ]));
  });
});
