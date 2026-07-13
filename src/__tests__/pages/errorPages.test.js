/**
 * Tests for custom Next.js error pages.
 *
 * Purpose: Verify status-specific pages use the shared secure error UI and the
 * framework catch-all page does not render raw thrown messages.
 *
 * Connects to:
 * - src/pages/403.js through src/pages/504.js
 * - src/pages/_error.js
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockLoggerError = jest.fn();

jest.mock('../../shared/logger.js', () => ({
  logger: {
    error: mockLoggerError,
  },
}));

jest.mock('next/router', () => ({
  useRouter: () => ({
    back: jest.fn(),
  }),
}));

jest.mock('next/head', () => {
  const React = require('react');

  /**
   * Renders Head children inline so page tests can mount Next page components.
   *
   * @param {object} props - Mock Head props.
   * @returns {JSX.Element} Fragment containing head children.
   */
  function MockHead({ children }) {
    return React.createElement(React.Fragment, null, children);
  }

  return MockHead;
});

let container;
let root;

/**
 * Renders a page component into a disposable jsdom root.
 *
 * @param {React.ReactElement} element - Element under test.
 * @returns {HTMLElement} Root container.
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
 * Unmounts the current React test root.
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
  mockLoggerError.mockClear();
}

afterEach(cleanup);

describe('custom error pages', () => {
  const pageCases = [
    ['../../pages/403.js', '403', 'Access is restricted'],
    ['../../pages/404.js', '404', 'Page not found'],
    ['../../pages/429.js', '429', 'Too many requests'],
    ['../../pages/500.js', '500', 'Something went wrong'],
    ['../../pages/502.js', '502', 'Temporary connection issue'],
    ['../../pages/503.js', '503', 'Service temporarily unavailable'],
    ['../../pages/504.js', '504', 'Request timed out'],
  ];

  it.each(pageCases)('renders %s with the expected safe copy', (modulePath, statusCode, title) => {
    const Page = require(modulePath).default;
    const el = render(React.createElement(Page));

    expect(el.textContent).toContain(statusCode);
    expect(el.textContent).toContain(title);
    expect(el.textContent).toContain('Go to dashboard');
  });

  it.each([
    ['../../pages/403.js', 403],
    ['../../pages/429.js', 429],
    ['../../pages/502.js', 502],
    ['../../pages/503.js', 503],
    ['../../pages/504.js', 504],
  ])('sets direct route status for %s', (modulePath, statusCode) => {
    const { getServerSideProps } = require(modulePath);
    const res = { statusCode: 200 };

    expect(getServerSideProps({ res })).toEqual({ props: {} });
    expect(res.statusCode).toBe(statusCode);
  });

  it('prefers response status code in the framework error page props', () => {
    const NextErrorPage = require('../../pages/_error.js').default;

    expect(NextErrorPage.getInitialProps({
      res: { statusCode: 429 },
      err: { statusCode: 500 },
    })).toEqual({ statusCode: 429 });
  });

  it('falls back to thrown status code when response status is absent', () => {
    const NextErrorPage = require('../../pages/_error.js').default;

    expect(NextErrorPage.getInitialProps({
      res: null,
      err: { statusCode: 502 },
    })).toEqual({ statusCode: 502 });
  });

  it('logs thrown framework errors on the server without changing safe props', () => {
    const NextErrorPage = require('../../pages/_error.js').default;
    const err = new Error('server-only diagnostic');
    err.statusCode = 503;
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });

    try {
      expect(NextErrorPage.getInitialProps({
        res: null,
        err,
      })).toEqual({ statusCode: 503 });
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
      } else {
        delete globalThis.window;
      }
    }

    expect(mockLoggerError).toHaveBeenCalledWith(
      { err, statusCode: 503 },
      'Unhandled page error'
    );
  });

  it('does not log framework errors during client-side error rendering', () => {
    const NextErrorPage = require('../../pages/_error.js').default;
    const err = new Error('client-side diagnostic');
    err.statusCode = 500;

    expect(NextErrorPage.getInitialProps({
      res: null,
      err,
    })).toEqual({ statusCode: 500 });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('renders unknown framework errors as the generic 500 page without raw details', () => {
    const NextErrorPage = require('../../pages/_error.js').default;
    const el = render(React.createElement(NextErrorPage, {
      statusCode: 418,
      err: new Error('database password leaked in stack'),
    }));

    expect(el.textContent).toContain('500');
    expect(el.textContent).toContain('Something went wrong');
    expect(el.textContent).not.toContain('database password leaked in stack');
  });
});
