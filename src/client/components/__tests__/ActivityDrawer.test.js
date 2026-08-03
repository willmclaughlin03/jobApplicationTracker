/**
 * Tests for the dashboard Activity drawer with the real calendar.
 *
 * Purpose: cover drawer focus ownership and the complete selected-date
 * interaction without creating a separate ActivityCalendar suite.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let ActivityDrawer;
let container;
let root;

const TEST_JOBS = Object.freeze([
  Object.freeze({ id: 'job-1', created_at: '2026-08-02T12:00:00.000' }),
  Object.freeze({ id: 'job-2', created_at: '2026-08-02T18:00:00.000' }),
  Object.freeze({ id: 'job-3', created_at: '2026-08-04T12:00:00.000' }),
]);

/**
 * Own Activity open state and selected dates like the Dashboard page.
 *
 * @param {object} props - Initial selected dates and jobs.
 * @returns {React.ReactElement} Trigger plus real ActivityDrawer integration.
 */
function ActivityHarness({ initialSelected = [], jobs = TEST_JOBS }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [selectedDates, setSelectedDates] = React.useState(() => new Set(initialSelected));

  /** Toggle one date while retaining the production seven-date boundary. */
  const handleDateToggle = (dateKey) => {
    setSelectedDates((current) => {
      const next = new Set(current);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else if (next.size < 7) {
        next.add(dateKey);
      }
      return next;
    });
  };

  return React.createElement(React.Fragment, null, [
    React.createElement('button', {
      key: 'trigger',
      type: 'button',
      onClick: () => setIsOpen(true),
    }, 'Open Activity'),
    React.createElement(ActivityDrawer, {
      key: 'drawer',
      isOpen,
      onClose: () => setIsOpen(false),
      jobs,
      selectedDates,
      onDateToggle: handleDateToggle,
      onClearDates: () => setSelectedDates(new Set()),
    }),
  ]);
}

/** Render the Activity harness into a test-owned root. */
function renderHarness(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(ActivityHarness, props));
  });

  return container;
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

/** Open the controlled Activity drawer through its persistent trigger. */
function openDrawer() {
  const trigger = findButton('Open Activity');
  trigger.focus();
  click(trigger);
  return trigger;
}

/** Remove the mounted tree and restore timers and body state. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  jest.useRealTimers();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  container = null;
  root = null;
}

describe('ActivityDrawer', () => {
  beforeAll(() => {
    ActivityDrawer = require('../ActivityDrawer.jsx').default;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
  });

  afterEach(cleanup);

  it('opens as a modal dialog, traps focus, locks scroll, and returns focus on Escape', () => {
    const element = renderHarness();
    const trigger = openDrawer();
    const drawer = element.querySelector('[role="dialog"]');
    const closeButton = element.querySelector('[aria-label="Close activity drawer"]');
    const enabledButtons = Array.from(drawer.querySelectorAll('button:not([disabled])'));
    const lastButton = enabledButtons.at(-1);

    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.getAttribute('aria-label')).toBe('Activity calendar drawer');
    expect(drawer.className).toContain('translate-x-0');
    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe('hidden');

    closeButton.focus();
    press('Tab', true);
    expect(document.activeElement).toBe(lastButton);
    press('Tab');
    expect(document.activeElement).toBe(closeButton);

    press('Escape');
    expect(drawer.className).toContain('-translate-x-full');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
    expect(drawer.getAttribute('inert')).toBe('');
    expect(drawer.className).toContain('pointer-events-none');
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('selects, removes, and clears dates through the real calendar integration', () => {
    const element = renderHarness();
    openDrawer();
    const augustSecond = element.querySelector('[aria-label="August 2: 2 applications"]');

    expect(augustSecond.getAttribute('aria-pressed')).toBe('false');
    click(augustSecond);

    expect(augustSecond.getAttribute('aria-pressed')).toBe('true');
    expect(element.textContent).toContain('Selected Dates (1/7)');
    expect(augustSecond.getAttribute('aria-label')).toContain('selected');

    click(element.querySelector('[aria-label="Remove Aug 2, 2026"]'));
    expect(augustSecond.getAttribute('aria-pressed')).toBe('false');
    expect(element.textContent).not.toContain('Selected Dates');

    click(augustSecond);
    click(element.querySelector('[aria-label="August 4: 1 application"]'));
    expect(element.textContent).toContain('Selected Dates (2/7)');

    click(findButton('Clear All'));
    expect(element.textContent).not.toContain('Selected Dates');
    expect(augustSecond.getAttribute('aria-pressed')).toBe('false');
  });

  it('exposes selected meaning and disables additional dates at the seven-date maximum', () => {
    const initialSelected = Array.from({ length: 7 }, (_, index) => (
      `2026-08-${String(index + 1).padStart(2, '0')}`
    ));
    const element = renderHarness({ initialSelected });
    openDrawer();
    const dayButtons = Array.from(element.querySelectorAll('[role="dialog"] button'));
    const selectedDay = dayButtons.find((button) => button.textContent.trim() === '2');
    const blockedDay = dayButtons.find((button) => button.textContent.trim() === '8');

    expect(element.textContent).toContain('Selected Dates (7/7)');
    expect(selectedDay.getAttribute('aria-pressed')).toBe('true');
    expect(selectedDay.disabled).toBe(false);
    expect(selectedDay.getAttribute('aria-label')).toContain('selected');
    expect(blockedDay.disabled).toBe(true);
    expect(blockedDay.getAttribute('aria-label')).toBe('Max 7 dates selected');
  });

  it('closes from the close control and backdrop as well as Escape', () => {
    const element = renderHarness();
    const trigger = openDrawer();

    click(element.querySelector('[aria-label="Close activity drawer"]'));
    expect(document.activeElement).toBe(trigger);

    openDrawer();
    click(element.querySelector('[aria-hidden="true"].fixed'));
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
  });
});
