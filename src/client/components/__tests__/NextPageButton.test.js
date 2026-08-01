/**
 * Tests for defensive fixed-size application pagination.
 *
 * Purpose: verify exact first/middle/final/partial/zero ranges, accessible
 * navigation state, and unchanged page callback arguments.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let NextPageButton;
let container;
let root;

/**
 * Render pagination with the repository's fixed ten-row page size.
 *
 * @param {object} overrides - Pagination props that differ by scenario.
 * @returns {HTMLElement} Rendered test container.
 */
function renderPagination(overrides = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(NextPageButton, {
      currentPage: 1,
      totalCount: 35,
      pageSize: 10,
      onPageChange: jest.fn(),
      ...overrides,
    }));
  });

  return container;
}

/**
 * Dispatch a bubbling click through React's delegated event handling.
 *
 * @param {HTMLElement} target - Button receiving the click.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Remove the active React root and DOM container. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  container = null;
  root = null;
}

describe('NextPageButton', () => {
  beforeAll(() => {
    NextPageButton = require('../NextPageButton.js').default;
  });

  afterEach(cleanup);

  it('renders first-page range and accessible boundary controls', () => {
    const onPageChange = jest.fn();
    const element = renderPagination({ onPageChange });
    const previous = element.querySelector('[aria-label="Previous page"]');
    const next = element.querySelector('[aria-label="Next page"]');
    const active = element.querySelector('[aria-current="page"]');

    expect(element.textContent).toContain('Showing 1-10 of 35 applications');
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(active.getAttribute('aria-label')).toBe('Page 1');
    expect(element.querySelector('nav').getAttribute('aria-label')).toBe('Applications pagination');
    expect(element.querySelector('nav > div').hasAttribute('aria-label')).toBe(false);

    click(element.querySelector('[aria-label="Page 2"]'));
    click(next);
    expect(onPageChange).toHaveBeenNthCalledWith(1, 2);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 2);
  });

  it.each([
    ['middle', 3, 35, 'Showing 21-30 of 35 applications'],
    ['final partial', 4, 35, 'Showing 31-35 of 35 applications'],
    ['second partial', 2, 13, 'Showing 11-13 of 13 applications'],
  ])('renders the %s range accurately', (_label, currentPage, totalCount, copy) => {
    const element = renderPagination({ currentPage, totalCount });

    expect(element.textContent).toContain(copy);
  });

  it('disables Next on the final partial page', () => {
    const element = renderPagination({ currentPage: 4, totalCount: 35 });

    expect(element.querySelector('[aria-label="Next page"]').disabled).toBe(true);
    expect(element.querySelector('[aria-label="Previous page"]').disabled).toBe(false);
  });

  it('renders zero-result copy without unnecessary page controls', () => {
    const element = renderPagination({ currentPage: 8, totalCount: 0 });

    expect(element.textContent).toContain('Showing 0-0 of 0 applications');
    expect(element.querySelector('button')).toBeNull();
  });

  it('keeps one-page count copy visible without page buttons', () => {
    const element = renderPagination({ totalCount: 7 });

    expect(element.textContent).toContain('Showing 1-7 of 7 applications');
    expect(element.querySelector('button')).toBeNull();
  });

  it('shows no more than five numbered pages for large result sets', () => {
    const element = renderPagination({ currentPage: 7, totalCount: 120 });
    const numberedButtons = Array.from(element.querySelectorAll('[aria-label^="Page "]'));

    expect(numberedButtons).toHaveLength(5);
    expect(numberedButtons.map(button => button.textContent.trim())).toEqual([
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });
});
