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
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const postcss = require('postcss');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const GLOBAL_STYLES_PATH = join(__dirname, '../../../styles/globals.css');

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

  /**
   * Protects the link between the skeleton's animation utility and the global
   * reduced-motion override so the delayed fade does not run for opted-out users.
   */
  it('neutralizes the skeleton animation when reduced motion is enabled', () => {
    const el = render(React.createElement(DashboardSkeleton));
    const outer = el.firstChild;
    const stylesheet = postcss.parse(readFileSync(GLOBAL_STYLES_PATH, 'utf8'));
    let reducedMotionRule;
    let skeletonAnimationRule;
    let animationDuration;
    let animationIterationCount;

    expect(outer.className).toContain('animate-skeleton-in');

    for (const node of stylesheet.nodes) {
      if (node.type === 'atrule' && node.name === 'media' && node.params === '(prefers-reduced-motion: reduce)') {
        reducedMotionRule = node;
        break;
      }
    }

    expect(reducedMotionRule).toBeTruthy();

    for (const node of reducedMotionRule.nodes) {
      if (node.type === 'rule' && node.selector.includes('.animate-skeleton-in')) {
        skeletonAnimationRule = node;
        break;
      }
    }

    expect(skeletonAnimationRule.selector).toContain('.dashboard-root .dashboard-motion');

    for (const node of skeletonAnimationRule.nodes) {
      if (node.prop === 'animation-duration') {
        animationDuration = node;
      }
      if (node.prop === 'animation-iteration-count') {
        animationIterationCount = node;
      }
    }

    expect(animationDuration).toMatchObject({ value: '0.01ms', important: true });
    expect(animationIterationCount).toMatchObject({ value: '1', important: true });
  });
});
