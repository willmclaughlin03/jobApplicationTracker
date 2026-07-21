/**
 * Tests for the global profile dropdown navigation contract.
 *
 * Purpose: prove removing the global Billing entry does not change conditional
 * Admin navigation or the parent-owned Sign Out action.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('next/link', () => {
  const React = require('react');

  /** Render Next links as ordinary anchors for focused DOM assertions. */
  return function MockLink({ href, children, ...props }) {
    return React.createElement('a', { href, ...props }, children);
  };
});

let ProfileDropdown;
let container;
let root;

/**
 * Render one user-specific dropdown into a detached jsdom root.
 *
 * @param {object} user - User identity and optional admin role.
 * @param {Function} onSignOut - Parent-owned sign-out callback.
 * @returns {HTMLElement} Rendered container.
 */
function renderDropdown(user, onSignOut = jest.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(ProfileDropdown, { user, onSignOut }));
  });

  return container;
}

/**
 * Dispatch a bubbling click through React's delegated event handler.
 *
 * @param {HTMLElement} target - Element to click.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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

describe('ProfileDropdown', () => {
  beforeAll(() => {
    ProfileDropdown = require('../ProfileDropdown.jsx').default;
  });

  afterEach(cleanup);

  it('contains no Billing or Admin link for an ordinary user and keeps Sign Out functional', () => {
    const onSignOut = jest.fn();
    const element = renderDropdown({
      email: 'member@example.com',
      role: 'user',
    }, onSignOut);

    click(element.querySelector('button'));

    expect(element.textContent).not.toContain('Billing');
    expect(element.textContent).not.toContain('Admin');
    expect(element.querySelector('a[href="/billing"]')).toBeNull();

    const signOutButton = Array.from(element.querySelectorAll('button')).find(
      (button) => button.textContent.trim() === 'Sign Out'
    );
    click(signOutButton);

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps Admin conditional without restoring a Billing link', () => {
    const element = renderDropdown({
      email: 'admin@example.com',
      role: 'admin',
    });

    click(element.querySelector('button'));

    expect(element.textContent).not.toContain('Billing');
    expect(element.querySelector('a[href="/billing"]')).toBeNull();
    expect(element.querySelector('a[href="/admin/users"]')?.textContent.trim()).toBe('Admin');
    expect(Array.from(element.querySelectorAll('button')).some(
      (button) => button.textContent.trim() === 'Sign Out'
    )).toBe(true);
  });
});
