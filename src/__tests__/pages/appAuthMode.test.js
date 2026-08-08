/**
 * CHUNK-0 regression tests for auth-free error-page rendering.
 *
 * Purpose: Prove status pages carry the fixed authMode marker and that _app
 * does not construct AuthProvider when that allowlisted marker is present.
 * Connects to: src/pages/_app.js, createStatusPage.jsx, and src/pages/_error.js.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockAuthProviderRender = jest.fn();

jest.mock('../../client/styles/globals.css', () => ({}));

jest.mock('next/head', () => {
  const React = require('react');

  /**
   * Renders metadata children inline for the app-shell test.
   *
   * @param {object} props - Mock Head props.
   * @returns {JSX.Element} Fragment containing metadata children.
   */
  function MockHead({ children }) {
    return React.createElement(React.Fragment, null, children);
  }

  return MockHead;
});

jest.mock('../../client/contexts/AuthContext.js', () => {
  const React = require('react');

  /**
   * Marks every AuthProvider construction while preserving child rendering.
   *
   * @param {object} props - Provider props.
   * @returns {JSX.Element} Provider marker containing children.
   */
  function MockAuthProvider({ children }) {
    mockAuthProviderRender();
    return React.createElement('div', { 'data-testid': 'auth-provider' }, children);
  }

  return { AuthProvider: MockAuthProvider };
});

jest.mock('../../client/components/ErrorPage.jsx', () => {
  const React = require('react');
  const content = Object.fromEntries(
    [403, 404, 429, 500, 502, 503, 504].map((statusCode) => [statusCode, { statusCode }])
  );

  /**
   * Replaces the visual error component with a stable status marker.
   *
   * @param {object} props - Error-page props.
   * @returns {JSX.Element} Status marker.
   */
  function MockErrorPage({ statusCode }) {
    return React.createElement('div', { 'data-status': statusCode });
  }

  return {
    __esModule: true,
    default: MockErrorPage,
    ERROR_PAGE_CONTENT: content,
    getErrorPageContent: (statusCode) => content[statusCode] ?? content[500],
  };
});

const App = require('../../pages/_app.js').default;

let container;
let root;

/**
 * Renders the Next application wrapper with a selected page component.
 *
 * @param {React.ComponentType} Component - Page component under test.
 * @returns {HTMLElement} Mounted DOM container.
 */
function renderApp(Component) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(App, { Component, pageProps: {} }));
  });

  return container;
}

/**
 * Removes the current app root between provider-construction assertions.
 *
 * @returns {void}
 */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
  container = null;
  root = null;
}

beforeEach(() => {
  mockAuthProviderRender.mockClear();
});

afterEach(cleanup);

describe('_app authMode contract', () => {
  it('does not construct AuthProvider for the exact authMode none marker', () => {
    /** Renders a non-sensitive page with the fixed auth bypass marker. */
    function AuthFreePage() {
      return React.createElement('main', null, 'public status');
    }
    AuthFreePage.authMode = 'none';

    const el = renderApp(AuthFreePage);

    expect(mockAuthProviderRender).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid=auth-provider]')).toBeNull();
    expect(el.textContent).toContain('public status');
  });

  it('continues to construct AuthProvider for ordinary pages', () => {
    /** Renders an ordinary page that must remain inside the auth provider. */
    function ProtectedPage() {
      return React.createElement('main', null, 'protected');
    }

    const el = renderApp(ProtectedPage);

    expect(mockAuthProviderRender).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid=auth-provider]')).toBeTruthy();
  });

  it.each([
    '../../pages/403.js',
    '../../pages/404.js',
    '../../pages/429.js',
    '../../pages/500.js',
    '../../pages/502.js',
    '../../pages/503.js',
    '../../pages/504.js',
  ])('marks generated status page %s as authMode none', (modulePath) => {
    const Page = require(modulePath).default;

    expect(Page.authMode).toBe('none');
  });

  it('marks the framework _error page as authMode none', () => {
    const NextErrorPage = require('../../pages/_error.js').default;

    expect(NextErrorPage.authMode).toBe('none');
  });
});
