/**
 * Tests for the responsive JobStatsSidebar disclosure and filter controls.
 *
 * Purpose: verify docked/drawer semantics, filter preservation, explicit reset,
 * focus return, and storage count copy without duplicating responsive inputs.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

/**
 * Renders a React element into a detached jsdom root.
 *
 * @param {import('react').ReactElement} element - Element under test.
 * @returns {HTMLElement} Rendered container.
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
 * Render new props into the existing root while preserving component state.
 *
 * @param {import('react').ReactElement} element - Updated element under test.
 * @returns {void}
 */
function rerender(element) {
  act(() => {
    root.render(element);
  });
}

/**
 * Dispatch a React-compatible click.
 *
 * @param {HTMLElement} target - Element receiving the click.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Replace an input value and dispatch React's input event.
 *
 * @param {HTMLInputElement} input - Controlled input under test.
 * @param {string} value - Next visible value.
 * @returns {void}
 */
function changeInput(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  ).set;

  act(() => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Build a complete stable Filters prop contract with optional overrides.
 *
 * @param {object} overrides - Props that differ for one scenario.
 * @returns {object} Complete JobStatsSidebar props.
 */
function buildProps(overrides = {}) {
  return {
    mode: 'docked',
    isOpen: true,
    onClose: jest.fn(),
    statusCounts: { applied: 3, interviewing: 1, offered: 0, rejected: 0, accepted: 0 },
    total: 4,
    loading: false,
    activeFilter: null,
    onFilterChange: jest.fn(),
    searchQuery: '',
    onSearchChange: jest.fn(),
    jobs: [],
    salaryFilterMin: null,
    salaryFilterMax: null,
    onSalaryFilterMinChange: jest.fn(),
    onSalaryFilterMaxChange: jest.fn(),
    archivedCount: 0,
    ...overrides,
  };
}

/**
 * Removes the active jsdom root and DOM container after each test.
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
  document.body.innerHTML = '';
}

describe('JobStatsSidebar storage counts', () => {
  let JobStatsSidebar;

  beforeAll(() => {
    JobStatsSidebar = require('../JobStatsSidebar').default;
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
  });

  it('labels dashboard totals as active and shows archived count separately', () => {
    const el = render(React.createElement(
      JobStatsSidebar,
      buildProps({ archivedCount: 7 })
    ));

    expect(el.textContent).toContain('Active Applications');
    expect(el.textContent).toContain('Archived');
    expect(el.textContent).toContain('7');
    expect(el.textContent).not.toContain('Total Applications');
  });

  it('keeps one docked control set mounted and preserves immediate debounced edits', () => {
    jest.useFakeTimers();
    const props = buildProps();
    const el = render(React.createElement(JobStatsSidebar, props));
    const panel = el.querySelector('#dashboard-filters-panel');
    const searchInput = el.querySelector('#job-search');
    const salaryMinInput = el.querySelector('#salary-filter-min');
    const salaryMaxInput = el.querySelector('#salary-filter-max');

    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(el.querySelectorAll('#job-search')).toHaveLength(1);
    expect(el.querySelectorAll('#salary-filter-min')).toHaveLength(1);
    expect(el.querySelectorAll('#salary-filter-max')).toHaveLength(1);

    changeInput(searchInput, 'Acme');
    changeInput(salaryMinInput, '60000');
    changeInput(salaryMaxInput, '120000');
    rerender(React.createElement(JobStatsSidebar, { ...props, isOpen: false }));

    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(searchInput.value).toBe('Acme');
    expect(salaryMinInput.value).toBe('60000');
    expect(salaryMaxInput.value).toBe('120000');
    expect(props.onFilterChange).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(300));

    expect(props.onSearchChange).toHaveBeenCalledWith('Acme');
    expect(props.onSalaryFilterMinChange).toHaveBeenCalledWith(60000);
    expect(props.onSalaryFilterMaxChange).toHaveBeenCalledWith(120000);

    rerender(React.createElement(JobStatsSidebar, props));
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(searchInput.value).toBe('Acme');
    expect(salaryMinInput.value).toBe('60000');
    expect(salaryMaxInput.value).toBe('120000');
  });

  it('resets criteria only through Clear All Filters', () => {
    const props = buildProps({
      activeFilter: 'applied',
      searchQuery: 'Acme',
      salaryFilterMin: 60000,
      salaryFilterMax: 120000,
    });
    const el = render(React.createElement(JobStatsSidebar, props));

    rerender(React.createElement(JobStatsSidebar, { ...props, isOpen: false }));
    expect(props.onFilterChange).not.toHaveBeenCalled();
    expect(props.onSearchChange).not.toHaveBeenCalled();
    expect(props.onSalaryFilterMinChange).not.toHaveBeenCalled();
    expect(props.onSalaryFilterMaxChange).not.toHaveBeenCalled();

    rerender(React.createElement(JobStatsSidebar, props));
    click(Array.from(el.querySelectorAll('button')).find(
      button => button.textContent.trim() === 'Clear All Filters'
    ));

    expect(props.onFilterChange).toHaveBeenCalledWith(null);
    expect(props.onSearchChange).toHaveBeenCalledWith('');
    expect(props.onSalaryFilterMinChange).toHaveBeenCalledWith(null);
    expect(props.onSalaryFilterMaxChange).toHaveBeenCalledWith(null);
  });

  it('uses dialog semantics and restores drawer focus after Escape', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Filters trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    const props = buildProps({ mode: 'drawer' });
    const el = render(React.createElement(JobStatsSidebar, props));
    const panel = el.querySelector('#dashboard-filters-panel');

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Close Filters');
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    rerender(React.createElement(JobStatsSidebar, { ...props, isOpen: false }));
    expect(document.activeElement).toBe(trigger);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes the compact drawer from its backdrop and close control', () => {
    const props = buildProps({ mode: 'drawer' });
    const el = render(React.createElement(JobStatsSidebar, props));

    click(el.querySelector('[data-testid="filters-backdrop"]'));
    click(el.querySelector('[aria-label="Close Filters"]'));

    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
