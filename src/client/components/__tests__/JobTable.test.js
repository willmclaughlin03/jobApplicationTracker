/**
 * Tests for the responsive application table/card composition.
 *
 * Purpose: lock the six-column desktop contract, 1024px switch classes,
 * excluded mock controls, and directly visible mobile actions.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let JobTable;
let container;
let root;

const JOB = {
  id: 'job-456',
  company: 'Example Company',
  position: 'Product Designer',
  status: 'interviewing',
  created_at: '2026-07-25T12:00:00.000Z',
  status_date: null,
  salary_min: 90000,
  salary_max: 110000,
  notes: 'Portfolio review scheduled.',
};

/**
 * Render one responsive result collection.
 *
 * @param {object} overrides - JobTable props that differ by scenario.
 * @returns {HTMLElement} Rendered test container.
 */
function renderTable(overrides = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(JobTable, {
      jobs: [JOB],
      onEdit: jest.fn(),
      onDelete: jest.fn(),
      deleting: null,
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

describe('JobTable', () => {
  beforeAll(() => {
    JobTable = require('../JobTable.jsx').default;
  });

  afterEach(cleanup);

  it('renders exactly the six approved desktop columns', () => {
    const element = renderTable();
    const headers = Array.from(element.querySelectorAll('th')).map(
      header => header.textContent.trim()
    );

    expect(headers).toEqual([
      'Application',
      'Added',
      'Status',
      'Salary',
      'Notes',
      'Actions',
    ]);
    expect(headers).not.toContain('Company');
    expect(headers).not.toContain('Position');
    expect(element.querySelector('img')).toBeNull();
  });

  it('uses desktop table at lg and cards below lg without mock controls', () => {
    const element = renderTable();
    const desktopFrame = element.querySelector('table').parentElement;
    const mobileFrame = element.querySelector('article').parentElement;

    expect(desktopFrame.classList.contains('lg:block')).toBe(true);
    expect(desktopFrame.classList.contains('hidden')).toBe(true);
    expect(mobileFrame.classList.contains('lg:hidden')).toBe(true);
    expect(element.textContent).not.toContain('Columns');
    expect(element.textContent).not.toContain('Export');
    expect(element.textContent).not.toContain('Page size');
  });

  it('reserves an eight-percent desktop track for the 36px Actions control', () => {
    const element = renderTable();
    const columnClasses = Array.from(element.querySelectorAll('col'))
      .map(column => column.className);

    expect(columnClasses).toEqual([
      'w-[27%]',
      'w-[14%]',
      'w-[16%]',
      'w-[15%]',
      'w-[20%]',
      'w-[8%]',
    ]);
  });

  it('keeps direct mobile Edit/Delete actions with exact existing arguments', () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const element = renderTable({ onEdit, onDelete });
    const card = element.querySelector('article');
    const buttons = Array.from(card.querySelectorAll('button'));

    click(buttons.find(button => button.textContent.trim() === 'Edit'));
    click(buttons.find(button => button.textContent.trim() === 'Delete'));

    expect(onEdit).toHaveBeenCalledWith(JOB);
    expect(onDelete).toHaveBeenCalledWith('job-456');
    expect(buttons.find(button => button.textContent.trim() === 'Edit')
      .classList.contains('min-h-9')).toBe(true);
    expect(buttons.find(button => button.textContent.trim() === 'Delete')
      .classList.contains('min-h-9')).toBe(true);
  });

  it('disables direct mobile actions and the desktop trigger during deletion', () => {
    const element = renderTable({ deleting: 'job-456' });
    const cardButtons = element.querySelector('article').querySelectorAll('button');
    const menuTrigger = element.querySelector('[aria-label^="Actions for"]');

    expect(Array.from(cardButtons).every(button => button.disabled)).toBe(true);
    expect(menuTrigger.disabled).toBe(true);
  });
});
