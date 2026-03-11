/**
 * Tests for InfoTooltip component
 *
 * Purpose: Verify tooltip visibility, keyboard dismissal, focus management,
 * and ARIA accessibility attributes.
 *
 * Connects to: src/client/components/InfoTooltip.jsx
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

function getButton(el) {
  return el.querySelector('button[aria-label="Application info"]');
}

function getTooltip(el) {
  return el.querySelector('[role="tooltip"]');
}

/** Dispatch a bubbling event that React's delegation will pick up */
function mouseEnter(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function mouseLeave(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
}

function focusIn(target) {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function focusOut(target, relatedTarget) {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget }));
  });
}

describe('InfoTooltip', () => {
  let InfoTooltip;

  beforeAll(() => {
    InfoTooltip = require('../InfoTooltip').default;
  });

  it('renders the trigger button with correct aria-label', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('Application info');
  });

  it('tooltip is hidden by default', () => {
    const el = render(React.createElement(InfoTooltip));
    expect(getTooltip(el)).toBeNull();
  });

  it('button has aria-expanded="false" when tooltip is hidden', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  // --- Mouse interactions ---

  it('shows tooltip on mouseenter and hides on mouseleave', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    mouseEnter(btn);
    expect(getTooltip(el)).toBeTruthy();

    mouseLeave(btn);
    expect(getTooltip(el)).toBeNull();
  });

  // --- Focus interactions ---

  it('shows tooltip on focus', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    focusIn(btn);
    expect(getTooltip(el)).toBeTruthy();
  });

  it('keeps tooltip open when focus moves within the container', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    focusIn(btn);
    expect(getTooltip(el)).toBeTruthy();

    // Blur from button but relatedTarget is the tooltip (still inside container)
    const tooltip = getTooltip(el);
    focusOut(btn, tooltip);
    expect(getTooltip(el)).toBeTruthy();
  });

  it('closes tooltip when focus leaves the container entirely', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    focusIn(btn);
    expect(getTooltip(el)).toBeTruthy();

    // Blur with relatedTarget outside the container
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    focusOut(btn, outside);
    expect(getTooltip(el)).toBeNull();
    document.body.removeChild(outside);
  });

  // --- Escape key ---

  it('dismisses tooltip on Escape key', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    mouseEnter(btn);
    expect(getTooltip(el)).toBeTruthy();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(getTooltip(el)).toBeNull();
  });

  // --- ARIA attributes when visible ---

  it('sets aria-expanded="true" and aria-describedby when visible', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    mouseEnter(btn);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(getTooltip(el).getAttribute('id')).toBe(describedBy);
  });

  it('displays tier limit values in tooltip content', () => {
    const el = render(React.createElement(InfoTooltip));
    const btn = getButton(el);

    mouseEnter(btn);

    const tooltip = getTooltip(el);
    expect(tooltip.textContent).toContain('300');
    expect(tooltip.textContent).toContain('30');
  });
});
