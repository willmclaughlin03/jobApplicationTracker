/**
 * Tests for the shared dashboard overlay accessibility coordinator.
 *
 * Purpose: prove independently rendered focus owners share one Escape stack,
 * focus trap, return-focus path, and counted body-scroll lock.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let useOverlayAccessibility;
let container;
let root;

/**
 * Render one test overlay that joins the production accessibility stack.
 *
 * @param {object} props - Open state, close callback, and visible label.
 * @returns {React.ReactElement|null} Focus-owning test panel when open.
 */
function TestOverlay({ isOpen, onClose, label }) {
  const { containerRef } = useOverlayAccessibility(isOpen, onClose);

  if (!isOpen) {
    return null;
  }

  return React.createElement('div', {
    ref: containerRef,
    role: 'dialog',
    tabIndex: -1,
    'data-overlay': label,
  }, [
    React.createElement('button', { key: 'first', type: 'button' }, `${label} first`),
    React.createElement('button', { key: 'last', type: 'button' }, `${label} last`),
  ]);
}

/**
 * Mount a React element into the shared test document.
 *
 * @param {React.ReactElement} element - Overlay harness to render.
 * @returns {HTMLElement} Test-owned DOM container.
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
 * Re-render the active root so effect cleanup can be asserted directly.
 *
 * @param {React.ReactElement|null} element - Next overlay tree.
 * @returns {void}
 */
function rerender(element) {
  act(() => {
    root.render(element);
  });
}

/**
 * Dispatch a document-level keyboard event through the production listener.
 *
 * @param {string} key - Keyboard key value.
 * @param {boolean} [shiftKey] - Whether Shift is held.
 * @returns {KeyboardEvent} Dispatched keyboard event.
 */
function press(key, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });

  act(() => {
    document.dispatchEvent(event);
  });

  return event;
}

/** Remove the mounted tree and restore all test-owned document state. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = null;
  root = null;
}

describe('useOverlayAccessibility', () => {
  beforeAll(() => {
    useOverlayAccessibility = require('../useOverlayAccessibility.js').useOverlayAccessibility;
  });

  afterEach(cleanup);

  it('moves initial focus inside and wraps Tab in both directions', () => {
    const element = render(React.createElement(TestOverlay, {
      isOpen: true,
      onClose: jest.fn(),
      label: 'Primary',
    }));
    const buttons = element.querySelectorAll('button');

    expect(document.activeElement).toBe(buttons[0]);

    buttons[1].focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);

    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('lets only the top overlay handle one Escape and restores stacked locks in order', () => {
    const lowerClose = jest.fn();
    const upperClose = jest.fn();
    const origin = document.createElement('button');
    origin.textContent = 'Origin';
    document.body.appendChild(origin);
    document.body.style.overflow = 'clip';
    origin.focus();

    const tree = (showUpper) => React.createElement(React.Fragment, null, [
      React.createElement(TestOverlay, {
        key: 'lower',
        isOpen: true,
        onClose: lowerClose,
        label: 'Lower',
      }),
      showUpper && React.createElement(TestOverlay, {
        key: 'upper',
        isOpen: true,
        onClose: upperClose,
        label: 'Upper',
      }),
    ]);

    const element = render(tree(true));
    const lowerFirst = element.querySelector('[data-overlay="Lower"] button');

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement.textContent).toBe('Upper first');

    const escapeEvent = press('Escape');
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(upperClose).toHaveBeenCalledTimes(1);
    expect(lowerClose).not.toHaveBeenCalled();

    rerender(tree(false));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(lowerFirst);

    rerender(null);
    expect(document.body.style.overflow).toBe('clip');
    expect(document.activeElement).toBe(origin);
  });

  it('uses the latest close callback without re-registering the open overlay', () => {
    const staleClose = jest.fn();
    const latestClose = jest.fn();
    render(React.createElement(TestOverlay, {
      isOpen: true,
      onClose: staleClose,
      label: 'Latest',
    }));

    rerender(React.createElement(TestOverlay, {
      isOpen: true,
      onClose: latestClose,
      label: 'Latest',
    }));
    press('Escape');

    expect(latestClose).toHaveBeenCalledTimes(1);
    expect(staleClose).not.toHaveBeenCalled();
  });

  it('returns focus only to a connected, focusable origin', () => {
    const origin = document.createElement('button');
    origin.textContent = 'Temporary origin';
    document.body.appendChild(origin);
    origin.focus();
    render(React.createElement(TestOverlay, {
      isOpen: true,
      onClose: jest.fn(),
      label: 'Temporary',
    }));

    origin.disabled = true;
    rerender(null);

    expect(document.activeElement).not.toBe(origin);
  });

  it('cleans listeners and the original body overflow through Strict Mode replay and unmount', () => {
    const onClose = jest.fn();
    document.body.style.overflow = 'scroll';
    render(React.createElement(React.StrictMode, null,
      React.createElement(TestOverlay, {
        isOpen: true,
        onClose,
        label: 'Strict',
      })
    ));

    expect(document.body.style.overflow).toBe('hidden');

    act(() => root.unmount());
    root = null;
    expect(document.body.style.overflow).toBe('scroll');

    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});
