/**
 * Tests for Skeleton primitive.
 *
 * Purpose: Verify the generic pulse-block primitive renders with expected
 * classes, respects className overrides, and is hidden from assistive tech.
 *
 * Connects to: src/client/components/skeletons/Skeleton.jsx
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

describe('Skeleton', () => {
  let Skeleton;

  beforeAll(() => {
    Skeleton = require('../Skeleton').default;
  });

  it('renders a dashboard-scoped emerald pulse block', () => {
    const el = render(React.createElement(Skeleton));
    const div = el.firstChild;
    expect(div.tagName).toBe('DIV');
    expect(div.className).toContain('animate-pulse');
    expect(div.className).toContain('dashboard-motion');
    expect(div.className).toContain('bg-dashboard-surface-hover/80');
    expect(div.className).not.toContain('bg-gray');
    expect(div.className).toContain('rounded');
  });

  it('appends caller-provided className', () => {
    const el = render(React.createElement(Skeleton, { className: 'h-4 w-24' }));
    const div = el.firstChild;
    expect(div.className).toContain('h-4');
    expect(div.className).toContain('w-24');
  });

  it('is hidden from assistive technology', () => {
    const el = render(React.createElement(Skeleton));
    const div = el.firstChild;
    expect(div.getAttribute('aria-hidden')).toBe('true');
  });
});
