/**
 * Tests for JobStatsSidebar storage count display.
 *
 * Purpose: verify dashboard analytics label active applications separately
 * from archived rows when storage degradation metadata reports locked jobs.
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
}

describe('JobStatsSidebar storage counts', () => {
  let JobStatsSidebar;

  beforeAll(() => {
    JobStatsSidebar = require('../JobStatsSidebar').default;
  });

  afterEach(cleanup);

  it('labels dashboard totals as active and shows archived count separately', () => {
    const el = render(React.createElement(JobStatsSidebar, {
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
      archivedCount: 7,
    }));

    expect(el.textContent).toContain('Active Applications');
    expect(el.textContent).toContain('Archived');
    expect(el.textContent).toContain('7');
    expect(el.textContent).not.toContain('Total Applications');
  });
});
