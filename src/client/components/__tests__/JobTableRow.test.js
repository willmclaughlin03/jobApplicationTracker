/**
 * Tests for dense desktop application rows and their Radix action menu.
 *
 * Purpose: verify supported fields, safe dates, canonical statuses, accessible
 * notes, exact action arguments, keyboard dismissal, and deletion guards.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { STATUS_CONFIG } = require('../../../shared/constants/statuses.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let JobTableRow;
let EditModal;
let DeleteModal;
let container;
let root;

const BASE_JOB = {
  id: 'job-123',
  company: 'Acme Incorporated',
  position: 'Senior Software Engineer',
  status: 'applied',
  status_date: '2026-07-29T23:30:00.000Z',
  created_at: '2026-07-30T23:30:00.000Z',
  salary_min: 100000,
  salary_max: 130000,
  notes: 'A'.repeat(120),
};

/**
 * Connect the real desktop row menu to one real page-owned dialog.
 *
 * @param {{dialogType: 'Edit'|'Delete'}} props - Dialog opened by its menu item.
 * @returns {React.ReactElement} Table row plus conditional dialog.
 */
function RowDialogHarness({ dialogType }) {
  const [selectedJob, setSelectedJob] = React.useState(null);
  const row = React.createElement('table', null,
    React.createElement('tbody', null,
      React.createElement(JobTableRow, {
        job: BASE_JOB,
        onEdit: (job) => setSelectedJob(job),
        onDelete: (jobId) => {
          if (jobId === BASE_JOB.id) {
            setSelectedJob(BASE_JOB);
          }
        },
        isDeleting: false,
      })
    )
  );
  const dialog = selectedJob && (dialogType === 'Edit'
    ? React.createElement(EditModal, {
      job: selectedJob,
      onSave: jest.fn(),
      onClose: () => setSelectedJob(null),
      saving: false,
    })
    : React.createElement(DeleteModal, {
      job: selectedJob,
      onConfirm: jest.fn(),
      onClose: () => setSelectedJob(null),
      deleting: false,
    }));

  return React.createElement(React.Fragment, null, row, dialog);
}

/** Render the real row-to-dialog integration into a test-owned root. */
function renderRowDialogHarness(dialogType) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(RowDialogHarness, { dialogType }));
  });
  return container;
}

/**
 * Render one row inside valid table ancestry.
 *
 * @param {object} props - JobTableRow props.
 * @returns {HTMLTableRowElement} Rendered row.
 */
function renderRow(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(
      'table',
      null,
      React.createElement(
        'tbody',
        null,
        React.createElement(JobTableRow, {
          job: BASE_JOB,
          onEdit: jest.fn(),
          onDelete: jest.fn(),
          isDeleting: false,
          ...props,
        })
      )
    ));
  });

  return container.querySelector('tr');
}

/**
 * Dispatch a bubbling click and flush Radix state updates.
 *
 * @param {HTMLElement} target - Element receiving the click.
 * @returns {Promise<void>} Resolves after queued React work.
 */
async function click(target) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/**
 * Flush Radix's deferred close autofocus and the queued dialog-open callback.
 *
 * @returns {Promise<void>} Resolves after the menu-to-dialog focus handoff.
 */
async function flushMenuDialogHandoff() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

/**
 * Dispatch one keyboard command and flush Radix state updates.
 *
 * @param {HTMLElement} target - Focused command target.
 * @param {string} key - Keyboard key value.
 * @returns {Promise<void>} Resolves after queued React work.
 */
async function press(target, key) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await Promise.resolve();
  });
}

/** Remove the active React tree, portal content, and test container. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = null;
  root = null;
}

describe('JobTableRow', () => {
  beforeAll(() => {
    if (!global.ResizeObserver) {
      global.ResizeObserver = class ResizeObserver {
        /** Observe is a no-op for deterministic jsdom layout. */
        observe() {}

        /** Unobserve is a no-op for deterministic jsdom layout. */
        unobserve() {}

        /** Disconnect is a no-op for deterministic jsdom layout. */
        disconnect() {}
      };
    }

    JobTableRow = require('../JobTableRow.jsx').default;
    EditModal = require('../EditModal.jsx').default;
    DeleteModal = require('../DeleteModal.jsx').default;
  });

  afterEach(cleanup);

  it('combines position/company and renders safe Added and status dates', () => {
    const row = renderRow();
    const cells = row.querySelectorAll('td');

    expect(cells).toHaveLength(6);
    expect(cells[0].textContent).toContain('Senior Software Engineer');
    expect(cells[0].textContent).toContain('Acme Incorporated');
    expect(cells[1].textContent.trim()).toBe('Jul 30, 2026');
    expect(cells[2].textContent).toContain('Applied');
    expect(cells[2].textContent).toContain('Jul 29, 2026');
    expect(cells[3].textContent).toContain('$100k - $130k');
  });

  it('renders zero epoch timestamps for both Added and status dates', () => {
    const row = renderRow({
      job: {
        ...BASE_JOB,
        created_at: 0,
        status_date: 0,
      },
    });
    const cells = row.querySelectorAll('td');

    expect(cells[1].textContent.trim()).toBe('Jan 1, 1970');
    expect(cells[2].textContent).toContain('Jan 1, 1970');
    expect(row.textContent).not.toContain('Invalid Date');
  });

  it.each(Object.entries(STATUS_CONFIG).map(([value, config]) => [value, config.label]))(
    'renders canonical status %s as %s',
    (value, label) => {
      const row = renderRow({ job: { ...BASE_JOB, status: value } });

      expect(row.textContent).toContain(label);
    }
  );

  it('uses safe fallbacks for missing dates, notes, and unsupported status', () => {
    const row = renderRow({
      job: {
        ...BASE_JOB,
        created_at: null,
        status: 'future-status',
        status_date: 'not-a-date',
        notes: null,
      },
    });
    const cells = row.querySelectorAll('td');

    expect(cells[1].textContent.trim()).toBe('—');
    expect(cells[2].textContent).toContain('Status unavailable');
    expect(cells[2].textContent).not.toContain('future-status');
    expect(cells[4].textContent.trim()).toBe('—');
  });

  it('expands and collapses long notes with linked accessible state', async () => {
    const row = renderRow();
    const expandButton = row.querySelector('[aria-label="Expand notes"]');
    const notes = document.getElementById(expandButton.getAttribute('aria-controls'));

    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    expect(notes.getAttribute('title')).toBe(BASE_JOB.notes);

    await click(expandButton);

    const collapseButton = row.querySelector('[aria-label="Collapse notes"]');
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true');
    expect(notes.hasAttribute('title')).toBe(false);

    await click(collapseButton);
    expect(row.querySelector('[aria-label="Expand notes"]').getAttribute('aria-expanded'))
      .toBe('false');
  });

  it('passes exact Edit/Delete arguments and returns focus after Escape', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const row = renderRow({ onEdit, onDelete });
    const trigger = row.querySelector('[aria-label^="Actions for"]');

    trigger.focus();
    await press(trigger, 'Enter');
    const themedMenu = document.body.querySelector('[role=menu]');
    expect(themedMenu.className).toContain('dashboard-portal-theme');
    expect(document.body.querySelector('[role="menu"]')).toBeTruthy();

    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      item => item.textContent.trim() === 'Edit'
    ));
    await flushMenuDialogHandoff();
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(BASE_JOB);

    await press(trigger, 'Enter');
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      item => item.textContent.trim() === 'Delete'
    ));
    await flushMenuDialogHandoff();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('job-123');

    await press(trigger, 'Enter');
    await press(document.activeElement, 'Escape');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['Edit', 'Delete'])(
    'transfers focus from the row menu to the real %s dialog and back to the trigger',
    async (dialogType) => {
      const element = renderRowDialogHarness(dialogType);
      const trigger = element.querySelector('[aria-label^=Actions]');
      trigger.focus();

      await press(trigger, 'Enter');
      const menuItem = Array.from(document.body.querySelectorAll('[role=menuitem]')).find(
        (item) => item.textContent.trim() === dialogType
      );
      await click(menuItem);
      await flushMenuDialogHandoff();
      const dialog = element.querySelector('[role=dialog]');

      expect(dialog).toBeTruthy();
      expect(document.activeElement).toBe(dialog.querySelector('button'));
      expect(document.body.style.overflow).toBe('hidden');

      await click(Array.from(dialog.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === 'Cancel'
      ));
      expect(element.querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(document.body.style.overflow).toBe('');
    }
  );

  it('disables the overflow trigger while this application is deleting', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const row = renderRow({ onEdit, onDelete, isDeleting: true });
    const trigger = row.querySelector('[aria-label^="Actions for"]');

    expect(trigger.disabled).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
