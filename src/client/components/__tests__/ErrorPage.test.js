/**
 * Tests for the shared custom error page component.
 *
 * Purpose: Verify public-safe copy, recovery actions, and status-code content
 * mapping for branded full-page errors.
 *
 * Connects to: src/client/components/ErrorPage.jsx
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const {
  ERROR_STATUS_CODES: PUBLIC_ERROR_STATUS_CODES,
} = require('../../../shared/constants/errorStatusCodes.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockBack = jest.fn();
const mockHeadChildren = jest.fn();

jest.mock('next/router', () => ({
  useRouter: () => ({
    back: mockBack,
  }),
}));

/** Replace Next's font loader with a deterministic public-shell CSS hook. */
jest.mock('next/font/google', () => ({
  Inter: jest.fn().mockReturnValue({
    className: 'mock-public-font',
    variable: 'mock-public-font-variable',
  }),
}));

jest.mock('next/head', () => {
  const React = require('react');

  /**
   * Renders Head children inline so component tests can mount Next pages.
   *
   * @param {object} props - Mock Head props.
   * @returns {JSX.Element} Fragment containing head children.
   */
  function MockHead({ children }) {
    mockHeadChildren(children);
    return React.createElement(React.Fragment, null, children);
  }

  return MockHead;
});

let container;
let root;

/**
 * Renders an element into a disposable jsdom root.
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
 * Finds a button by exact visible text.
 *
 * @param {HTMLElement} el - Container to search.
 * @param {string} text - Button text to match.
 * @returns {HTMLButtonElement|null} Matching button if present.
 */
function findButtonByText(el, text) {
  return Array.from(el.querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
}

/**
 * Dispatches a click event through React's delegated event system.
 *
 * @param {HTMLElement} target - Element to click.
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Unmounts the active React root and resets DOM state.
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
  mockBack.mockClear();
  mockHeadChildren.mockClear();
}

afterEach(cleanup);

describe('ErrorPage', () => {
  let ErrorPage;
  let ERROR_PAGE_CONTENT;
  let ERROR_STATUS_CODES;
  let getErrorPageContent;

  beforeAll(() => {
    const errorPageModule = require('../ErrorPage.jsx');
    ErrorPage = errorPageModule.default;
    ERROR_PAGE_CONTENT = errorPageModule.ERROR_PAGE_CONTENT;
    ERROR_STATUS_CODES = errorPageModule.ERROR_STATUS_CODES;
    getErrorPageContent = errorPageModule.getErrorPageContent;
  });

  it('keeps page content aligned with the shared public error statuses', () => {
    expect(Object.keys(ERROR_PAGE_CONTENT).map(Number).sort()).toEqual([...ERROR_STATUS_CODES].sort());
  });

  it('renders the 429 recovery page with vague public-safe copy', () => {
    const el = render(React.createElement(ErrorPage, ERROR_PAGE_CONTENT[429]));
    const themeRoot = el.querySelector('.public-page-root');
    const brand = el.querySelector('[data-testid="public-page-brand"]');
    const panel = el.querySelector('[data-testid="error-page-panel"]');
    const statusCode = el.querySelector('[data-testid="error-status-code"]');
    const wave = el.querySelector('[data-testid="public-dotted-wave"]');

    expect(themeRoot).toBeTruthy();
    expect(themeRoot.classList.contains('mock-public-font-variable')).toBe(true);
    expect(brand.textContent).toContain('TrackTheApp');
    expect(panel.classList.contains('text-center')).toBe(true);
    expect(statusCode.textContent).toBe('429');
    expect(statusCode.classList.contains('text-dashboard-accent')).toBe(true);
    expect(wave.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toContain('429');
    expect(el.textContent).toContain('Too many requests');
    expect(el.textContent).toContain('Please wait a moment');
    expect(el.textContent).toContain('Go to dashboard');
    expect(el.textContent).not.toContain('Try again');
    expect(el.textContent).not.toContain('Redis');
    expect(el.textContent).not.toContain('Upstash');
  });

  it('links the primary action back to the dashboard', () => {
    const el = render(React.createElement(ErrorPage, ERROR_PAGE_CONTENT[404]));
    const link = el.querySelector('a');

    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toBe('Go to dashboard');
    expect(link.classList.contains('dashboard-focus-ring')).toBe(true);
    expect(link.classList.contains('border-dashboard-accent/60')).toBe(true);
    expect(link.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('uses browser history for the back action', () => {
    const el = render(React.createElement(ErrorPage, ERROR_PAGE_CONTENT[403]));
    const backButton = findButtonByText(el, 'Back');

    expect(backButton).toBeTruthy();

    click(backButton);

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('omits the retry action for non-temporary pages', () => {
    const el = render(React.createElement(ErrorPage, ERROR_PAGE_CONTENT[404]));

    expect(findButtonByText(el, 'Try again')).toBeNull();
  });

  it.each(PUBLIC_ERROR_STATUS_CODES)('omits every retry interface for status %s', (statusCode) => {
    const content = ERROR_PAGE_CONTENT[statusCode];

    expect(content).toBeDefined();
    const el = render(React.createElement(ErrorPage, content));

    expect(Object.prototype.hasOwnProperty.call(content, 'showRetry')).toBe(false);
    expect(findButtonByText(el, 'Try again')).toBeNull();
  });

  it('ignores a dormant showRetry prop so reload behavior cannot be re-enabled', () => {
    const el = render(React.createElement(ErrorPage, {
      ...ERROR_PAGE_CONTENT[500],
      showRetry: true,
    }));

    expect(findButtonByText(el, 'Try again')).toBeNull();
  });

  it('renders the document title with exactly one React child', () => {
    render(React.createElement(ErrorPage, ERROR_PAGE_CONTENT[503]));
    const headChildren = mockHeadChildren.mock.calls.at(-1)[0];
    const title = React.Children.toArray(headChildren).find((child) => child.type === 'title');

    expect(title).toBeTruthy();
    expect(React.Children.count(title.props.children)).toBe(1);
    expect(title.props.children).toBe('503 - Track The App');
  });

  it('maps unknown status codes to the generic 500 content', () => {
    expect(getErrorPageContent(418)).toBe(ERROR_PAGE_CONTENT[500]);
    expect(getErrorPageContent('503')).toBe(ERROR_PAGE_CONTENT[503]);
  });
});
