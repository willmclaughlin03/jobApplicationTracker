/**
 * Tests for the dashboard Add Application form.
 *
 * Purpose: protect the existing payload and validation contract while proving
 * the redesigned form exposes errors and saving state accessibly.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const {
  COMPANY_MAX_LENGTH,
  POSITION_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  SALARY_MAX_VALUE,
} = require('../../../shared/validations/jobSchema.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let JobForm;
let container;
let root;

/**
 * Render the form with stable callback defaults.
 *
 * @param {object} [props] - JobForm prop overrides.
 * @returns {HTMLElement} Rendered form container.
 */
function renderForm(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(JobForm, {
      onSubmit: jest.fn(),
      onCancel: jest.fn(),
      saving: false,
      ...props,
    }));
  });

  return container;
}

/**
 * Update one controlled form field through its native value setter.
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

/**
 * Submit the rendered form through React's delegated submit handler.
 *
 * @param {HTMLFormElement} form - Form under test.
 * @returns {void}
 */
function submit(form) {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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

/** Find a button by exact visible text. */
function findButton(text) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/** Remove the mounted form and test-owned DOM. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  container = null;
  root = null;
}

describe('JobForm', () => {
  beforeAll(() => {
    JobForm = require('../JobForm.jsx').default;
  });

  afterEach(cleanup);

  it('distinguishes the Add heading from the Save action and supports cancellation', () => {
    const onCancel = jest.fn();
    const element = renderForm({ onCancel });

    expect(element.querySelector('h2').textContent).toBe('Add Application');
    expect(findButton('Save Application')).toBeTruthy();

    click(findButton('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('links visible validation errors to invalid fields and blocks submission', () => {
    const onSubmit = jest.fn();
    const element = renderForm({ onSubmit });
    const company = element.querySelector('[name="company"]');
    const notes = element.querySelector('[name="notes"]');
    const salaryMin = element.querySelector('[name="salary_min"]');
    const salaryMax = element.querySelector('[name="salary_max"]');

    changeField(company, 'C'.repeat(COMPANY_MAX_LENGTH + 1));
    changeField(notes, 'N'.repeat(NOTES_MAX_LENGTH + 1));
    changeField(salaryMin, '90000');
    changeField(salaryMax, '80000');
    submit(element.querySelector('form'));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(company.getAttribute('aria-invalid')).toBe('true');
    expect(company.getAttribute('aria-describedby')).toBe('company-error');
    expect(element.querySelector('#company-error').textContent).toContain('100 characters or fewer');
    expect(notes.getAttribute('aria-describedby')).toBe('notes-error');
    expect(element.querySelector('#notes-error').textContent).toContain('250 characters or fewer');
    expect(salaryMax.getAttribute('aria-describedby')).toBe('salary_max-error');
    expect(element.querySelector('#salary_max-error').textContent)
      .toBe('Max salary must be greater than or equal to min salary');
  });

  it('announces every rendered field validation error', () => {
    const element = renderForm();

    changeField(element.querySelector('[name="company"]'), 'C'.repeat(COMPANY_MAX_LENGTH + 1));
    changeField(element.querySelector('[name="position"]'), 'P'.repeat(POSITION_MAX_LENGTH + 1));
    changeField(element.querySelector('[name="salary_min"]'), '-1');
    changeField(element.querySelector('[name="salary_max"]'), String(SALARY_MAX_VALUE + 1));
    changeField(element.querySelector('[name="notes"]'), 'N'.repeat(NOTES_MAX_LENGTH + 1));
    submit(element.querySelector('form'));

    for (const errorId of [
      'company-error',
      'position-error',
      'salary_min-error',
      'salary_max-error',
      'notes-error',
    ]) {
      expect(element.querySelector(`#${errorId}`).getAttribute('role')).toBe('alert');
    }
  });

  it('submits the exact valid payload with numeric and empty salaries normalized', () => {
    const onSubmit = jest.fn();
    const element = renderForm({ onSubmit });

    changeField(element.querySelector('[name="company"]'), 'Acme');
    changeField(element.querySelector('[name="position"]'), 'Engineer');
    changeField(element.querySelector('[name="status"]'), 'interviewing');
    changeField(element.querySelector('[name="notes"]'), 'Follow up Friday');
    changeField(element.querySelector('[name="salary_min"]'), '65000');
    submit(element.querySelector('form'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      company: 'Acme',
      position: 'Engineer',
      status: 'interviewing',
      notes: 'Follow up Friday',
      salary_min: 65000,
      salary_max: null,
    });
  });

  it('disables submission and shows the spinner while saving', () => {
    renderForm({ saving: true });
    const submitButton = findButton('Adding...');

    expect(submitButton.disabled).toBe(true);
    expect(submitButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(findButton('Cancel').disabled).toBe(false);
  });
});
