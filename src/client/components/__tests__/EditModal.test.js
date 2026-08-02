/**
 * Tests for the dashboard Edit Application dialog.
 *
 * Purpose: preserve validation and update payloads while covering dialog
 * semantics, dismissal paths, focus ownership, and the real mobile trigger.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { COMPANY_MAX_LENGTH } = require('../../../shared/validations/jobSchema.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let EditModal;
let JobCardMobile;
let container;
let root;

const TEST_JOB = Object.freeze({
  id: 'job-edit-1',
  company: 'Acme',
  position: 'Engineer',
  status: 'interviewing',
  notes: 'Initial notes',
  salary_min: 70000,
  salary_max: 90000,
  created_at: '2026-08-01T12:00:00.000Z',
  status_date: '2026-08-02T12:00:00.000Z',
});

/**
 * Render a React element into a test-owned root.
 *
 * @param {React.ReactElement} element - Element under test.
 * @returns {HTMLElement} Rendered DOM container.
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

/** Re-render the current test root. */
function rerender(element) {
  act(() => {
    root.render(element);
  });
}

/**
 * Update one controlled modal field through its native value setter.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} field - Field to update.
 * @param {string} value - Next visible value.
 * @returns {void}
 */
function changeField(field, value) {
  const prototype = field instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;

  act(() => {
    valueSetter.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
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

/** Submit the modal form through React's delegated handler. */
function submit(form) {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Find a button by exact visible text inside the current container. */
function findButton(text) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/**
 * Integrate the real mobile Edit button with conditional modal ownership.
 *
 * @param {object} props - Job fixture and save callback.
 * @returns {React.ReactElement} Mobile card plus conditional EditModal.
 */
function MobileEditHarness({ job, onSave }) {
  const [editingJob, setEditingJob] = React.useState(null);

  return React.createElement(React.Fragment, null, [
    React.createElement(JobCardMobile, {
      key: 'card',
      job,
      onEdit: setEditingJob,
      onDelete: jest.fn(),
      isDeleting: false,
    }),
    editingJob && React.createElement(EditModal, {
      key: 'modal',
      job: editingJob,
      onSave,
      onClose: () => setEditingJob(null),
      saving: false,
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

describe('EditModal', () => {
  beforeAll(() => {
    EditModal = require('../EditModal.jsx').default;
    JobCardMobile = require('../JobCardMobile.jsx').default;
  });

  afterEach(cleanup);

  it('names the modal dialog and populates every current application value', () => {
    const element = render(React.createElement(EditModal, {
      job: TEST_JOB,
      onSave: jest.fn(),
      onClose: jest.fn(),
      saving: false,
    }));
    const dialog = element.querySelector('[role="dialog"]');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('edit-application-dialog-title');
    expect(element.querySelector('#edit-application-dialog-title').textContent)
      .toBe('Edit Job Application');
    expect(element.querySelector('[name="company"]').value).toBe('Acme');
    expect(element.querySelector('[name="position"]').value).toBe('Engineer');
    expect(element.querySelector('[name="status"]').value).toBe('interviewing');
    expect(element.querySelector('[name="notes"]').value).toBe('Initial notes');
    expect(element.querySelector('[name="salary_min"]').value).toBe('70000');
    expect(element.querySelector('[name="salary_max"]').value).toBe('90000');
    expect(element.textContent).toContain('Status since: Aug 2, 2026');
  });

  it('blocks invalid values, then sends the exact normalized save payload', () => {
    const onSave = jest.fn();
    const element = render(React.createElement(EditModal, {
      job: TEST_JOB,
      onSave,
      onClose: jest.fn(),
      saving: false,
    }));
    const company = element.querySelector('[name="company"]');

    changeField(company, 'C'.repeat(COMPANY_MAX_LENGTH + 1));
    submit(element.querySelector('form'));
    expect(onSave).not.toHaveBeenCalled();
    expect(company.getAttribute('aria-invalid')).toBe('true');
    expect(company.getAttribute('aria-describedby')).toBe('edit-company-error');

    changeField(company, 'Updated Co');
    changeField(element.querySelector('[name="position"]'), 'Staff Engineer');
    changeField(element.querySelector('[name="status"]'), 'offered');
    changeField(element.querySelector('[name="notes"]'), 'Offer received');
    changeField(element.querySelector('[name="salary_min"]'), '100000');
    changeField(element.querySelector('[name="salary_max"]'), '');
    submit(element.querySelector('form'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('job-edit-1', {
      company: 'Updated Co',
      position: 'Staff Engineer',
      status: 'offered',
      notes: 'Offer received',
      salary_min: 100000,
      salary_max: null,
    });
  });

  it('supports Cancel, backdrop, and top-level Escape dismissal', () => {
    const onClose = jest.fn();
    const element = render(React.createElement(EditModal, {
      job: TEST_JOB,
      onSave: jest.fn(),
      onClose,
      saving: false,
    }));
    const dialog = element.querySelector('[role="dialog"]');

    click(findButton('Cancel'));
    click(dialog.parentElement);
    press('Escape');

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('traps focus, locks scroll, and returns to the connected trigger on cleanup', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Edit origin';
    document.body.appendChild(trigger);
    trigger.focus();
    const element = render(React.createElement(EditModal, {
      job: TEST_JOB,
      onSave: jest.fn(),
      onClose: jest.fn(),
      saving: false,
    }));
    const closeButton = element.querySelector('[aria-label="Close edit application dialog"]');
    const saveButton = findButton('Save Changes');

    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe('hidden');

    press('Tab', true);
    expect(document.activeElement).toBe(saveButton);
    press('Tab');
    expect(document.activeElement).toBe(closeButton);

    rerender(null);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('opens from the real mobile Edit control and returns focus after Cancel', () => {
    const element = render(React.createElement(MobileEditHarness, {
      job: TEST_JOB,
      onSave: jest.fn(),
    }));
    const mobileEditButton = findButton('Edit');
    mobileEditButton.focus();

    click(mobileEditButton);
    expect(element.querySelector('[role="dialog"]')).toBeTruthy();
    expect(element.querySelector('[name="company"]').value).toBe('Acme');

    click(findButton('Cancel'));
    expect(element.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(mobileEditButton);
  });
});
