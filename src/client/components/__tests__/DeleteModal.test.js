/**
 * Tests for the dashboard Delete Application dialog.
 *
 * Purpose: protect safe confirmation rendering and callback behavior while
 * covering disabled state, dismissal, focus ownership, and the mobile trigger.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let DeleteModal;
let JobCardMobile;
let container;
let root;

const TEST_JOB = Object.freeze({
  id: 'job-delete-1',
  company: '<img src=x onerror=alert(1)>',
  position: '<script>unsafe()</script>',
  status: 'applied',
  notes: '',
  salary_min: null,
  salary_max: null,
  created_at: '2026-08-01T12:00:00.000Z',
});

/** Render a React element into a test-owned root. */
function render(element) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return container;
}

/** Re-render the current test root. */
function rerender(element) {
  act(() => {
    root.render(element);
  });
}

/** Dispatch a React-compatible click. */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Dispatch a document keyboard event through the shared overlay hook. */
function press(key, shiftKey = false) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }));
  });
}

/** Find a button by exact visible text inside the current container. */
function findButton(text) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/**
 * Integrate the real mobile Delete button with conditional modal ownership.
 *
 * @param {object} props - Job fixture and confirmation callback.
 * @returns {React.ReactElement} Mobile card plus conditional DeleteModal.
 */
function MobileDeleteHarness({ job, onConfirm }) {
  const [deletingJob, setDeletingJob] = React.useState(null);

  return React.createElement(React.Fragment, null, [
    React.createElement(JobCardMobile, {
      key: 'card',
      job,
      onEdit: jest.fn(),
      onDelete: (jobId) => {
        if (jobId === job.id) {
          setDeletingJob(job);
        }
      },
      isDeleting: false,
    }),
    deletingJob && React.createElement(DeleteModal, {
      key: 'modal',
      job: deletingJob,
      onConfirm,
      onClose: () => setDeletingJob(null),
      deleting: false,
    }),
  ]);
}

/** Remove the mounted tree and restore body state. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = null;
  root = null;
}

describe('DeleteModal', () => {
  beforeAll(() => {
    DeleteModal = require('../DeleteModal.jsx').default;
    JobCardMobile = require('../JobCardMobile.jsx').default;
  });

  afterEach(cleanup);

  it('renders a safely named irreversible confirmation and calls onConfirm with no arguments', () => {
    const onConfirm = jest.fn();
    const element = render(React.createElement(DeleteModal, {
      job: TEST_JOB,
      onConfirm,
      onClose: jest.fn(),
      deleting: false,
    }));
    const dialog = element.querySelector('[role="dialog"]');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('delete-application-dialog-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('delete-application-dialog-description');
    expect(element.querySelector('#delete-application-dialog-title').textContent)
      .toBe('Delete Application');
    expect(element.querySelector('#delete-application-dialog-description').textContent)
      .toContain('<img src=x onerror=alert(1)>');
    expect(element.querySelector('#delete-application-dialog-description').textContent)
      .toContain('<script>unsafe()</script>');
    expect(element.textContent).toContain('This cannot be undone.');
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('script')).toBeNull();

    click(findButton('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it('marks the dialog busy and disables mutable actions while deleting', () => {
    const element = render(React.createElement(DeleteModal, {
      job: TEST_JOB,
      onConfirm: jest.fn(),
      onClose: jest.fn(),
      deleting: true,
    }));
    const dialog = element.querySelector('[role="dialog"]');
    const deletingButton = findButton('Deleting...');

    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(findButton('Cancel').disabled).toBe(true);
    expect(deletingButton.disabled).toBe(true);
    expect(deletingButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('supports Cancel, backdrop, and top-level Escape dismissal', () => {
    const onClose = jest.fn();
    const element = render(React.createElement(DeleteModal, {
      job: TEST_JOB,
      onConfirm: jest.fn(),
      onClose,
      deleting: false,
    }));
    const dialog = element.querySelector('[role="dialog"]');

    click(findButton('Cancel'));
    click(dialog.parentElement);
    press('Escape');

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('traps focus, locks scroll, and returns to the connected trigger on cleanup', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Delete origin';
    document.body.appendChild(trigger);
    trigger.focus();
    const element = render(React.createElement(DeleteModal, {
      job: TEST_JOB,
      onConfirm: jest.fn(),
      onClose: jest.fn(),
      deleting: false,
    }));
    const closeButton = element.querySelector('[aria-label="Close delete application dialog"]');
    const deleteButton = findButton('Delete');

    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe('hidden');

    press('Tab', true);
    expect(document.activeElement).toBe(deleteButton);
    press('Tab');
    expect(document.activeElement).toBe(closeButton);

    rerender(null);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('opens from the real mobile Delete control and returns focus after Cancel', () => {
    const element = render(React.createElement(MobileDeleteHarness, {
      job: TEST_JOB,
      onConfirm: jest.fn(),
    }));
    const mobileDeleteButton = findButton('Delete');
    mobileDeleteButton.focus();

    click(mobileDeleteButton);
    expect(element.querySelector('[role="dialog"]')).toBeTruthy();
    expect(element.textContent).toContain('This cannot be undone.');

    click(findButton('Cancel'));
    expect(element.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(mobileDeleteButton);
  });
});
