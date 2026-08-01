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

  /**
   * Render Next links as ref-forwarding anchors for Radix asChild semantics.
   *
   * @param {object} props - Mock anchor props.
   * @param {React.Ref<HTMLAnchorElement>} ref - Radix focus-management ref.
   * @returns {React.ReactElement} Ordinary anchor used by focused DOM assertions.
   */
  const MockLink = React.forwardRef(function MockLink({ href, children, ...props }, ref) {
    return React.createElement('a', { ref, href, ...props }, children);
  });

  return MockLink;
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
 * @returns {Promise<void>} Resolves after queued Radix work.
 */
async function click(target) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/**
 * Dispatch one keyboard command through the focused Radix control.
 *
 * @param {HTMLElement} target - Element receiving the key command.
 * @param {string} key - Keyboard key value.
 * @returns {Promise<void>} Resolves after queued Radix work.
 */
async function press(target, key) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await Promise.resolve();
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

  it('uses the Account fallback when the user email is missing', () => {
    const element = renderDropdown({ role: 'user' });
    const trigger = element.querySelector('button');

    expect(trigger.textContent.trim()).toBe('Account');
    expect(trigger.getAttribute('aria-label')).toBe('Account menu for current user');
  });

  it('contains no Billing or Admin link for an ordinary user and keeps Sign Out functional', async () => {
    const onSignOut = jest.fn();
    const element = renderDropdown({
      email: 'member@example.com',
      role: 'user',
    }, onSignOut);

    const trigger = element.querySelector('button');
    expect(trigger.textContent).toContain('member@example.com');
    expect(element.querySelector('img')).toBeNull();
    await press(trigger, 'Enter');

    expect(document.body.textContent).not.toContain('Billing');
    expect(document.body.textContent).not.toContain('Admin');
    expect(document.body.querySelector('a[href="/billing"]')).toBeNull();

    const signOutButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent.trim() === 'Sign Out'
    );
    await click(signOutButton);

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps Admin conditional without restoring a Billing link', async () => {
    const element = renderDropdown({
      email: 'admin@example.com',
      role: 'admin',
    });

    await press(element.querySelector('button'), 'Enter');

    expect(document.body.textContent).not.toContain('Billing');
    expect(document.body.querySelector('a[href="/billing"]')).toBeNull();
    expect(document.body.querySelector('a[href="/admin/users"]')?.textContent.trim()).toBe('Admin');
    expect(Array.from(document.body.querySelectorAll('button')).some(
      (button) => button.textContent.trim() === 'Sign Out'
    )).toBe(true);
  });

  it('opens from the keyboard, closes with Escape, and returns focus', async () => {
    const element = renderDropdown({
      email: 'member@example.com',
      role: 'user',
    });
    const trigger = element.querySelector('button');

    trigger.focus();
    await press(trigger, 'Enter');
    expect(document.body.querySelector('[role="menu"]')).toBeTruthy();

    await press(document.activeElement, 'Escape');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
