/**
 * Tests for the shared branded public-page shell.
 *
 * Purpose: Verify login and error routes inherit one stable visual frame,
 * brand, centered content rail, and accessibility-hidden particle artwork.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('next/font/google', () => ({
  Inter: jest.fn().mockReturnValue({
    className: 'mock-public-font',
    variable: 'mock-public-font-variable',
  }),
}));

let PublicPageShell;
let container;
let root;

/**
 * Render the public shell into a disposable jsdom root.
 *
 * @returns {HTMLElement} Mounted shell container.
 */
function renderShell() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(
      React.createElement(
        PublicPageShell,
        {
          contentClassName: 'test-content-class',
          contentTestId: 'test-public-content',
        },
        React.createElement('h1', null, 'Public content'),
      ),
    );
  });

  return container;
}

/**
 * Unmount and remove the current shell root.
 *
 * @returns {void}
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

describe('PublicPageShell', () => {
  beforeAll(() => {
    PublicPageShell = require('../PublicPageShell.jsx').default;
  });

  afterEach(cleanup);

  it('renders the approved brand, centered rail, and hidden dotted wave', () => {
    const element = renderShell();
    const themeRoot = element.querySelector('.public-page-root');
    const brand = element.querySelector('[data-testid="public-page-brand"]');
    const panel = element.querySelector('[data-testid="test-public-content"]');
    const wave = element.querySelector('[data-testid="public-dotted-wave"]');

    expect(themeRoot).toBeTruthy();
    expect(themeRoot.classList.contains('mock-public-font-variable')).toBe(true);
    expect(element.querySelector('.public-page-frame')).toBeTruthy();
    expect(brand.textContent).toContain('TrackTheApp');
    expect(panel.classList.contains('public-page-panel')).toBe(true);
    expect(panel.classList.contains('max-w-lg')).toBe(true);
    expect(panel.classList.contains('test-content-class')).toBe(true);
    expect(panel.textContent).toContain('Public content');
    expect(wave.getAttribute('aria-hidden')).toBe('true');
    expect(wave.getAttribute('focusable')).toBe('false');
    expect(wave.getAttribute('preserveAspectRatio')).toBe('none');
    expect(wave.querySelectorAll('[data-wave-strand="true"]')).toHaveLength(22);
  });
});
