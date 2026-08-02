/**
 * Tests for LockedArchivePanel.
 *
 * Purpose: verify the archive preview uses the locked teaser API route, renders
 * only teaser-safe fields, exposes CSV export, and gates locked bulk delete
 * behind confirmed terminal-Free state plus a second confirmation.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockApiGet = jest.fn();
const mockApiDelete = jest.fn();

jest.mock('../../lib/api.js', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
    delete: (...args) => mockApiDelete(...args),
  },
}));

let container;
let root;
let useOverlayAccessibility;

/**
 * Create a controllable promise for loading-state assertions.
 *
 * @returns {{promise: Promise<object>, resolve: Function}} Deferred handle.
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Register a simple underlying focus owner for stacked-lock coverage.
 *
 * @param {{onClose: Function}} props - Background overlay close callback.
 * @returns {React.ReactElement} Focus-owning background panel.
 */
function BackgroundOverlay({ onClose }) {
  const { containerRef } = useOverlayAccessibility(true, onClose);
  return React.createElement('div', { ref: containerRef, tabIndex: -1 },
    React.createElement('button', { type: 'button' }, 'Background focus')
  );
}

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

/** Re-render the active test root while preserving component state by key. */
function rerender(element) {
  act(() => {
    root.render(element);
  });
}

/**
 * Flushes pending microtasks after async React effects.
 *
 * @returns {Promise<void>}
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Dispatches a bubbling click event through React's delegated listeners.
 *
 * @param {HTMLElement} target - Click target.
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Finds a button by its exact text content.
 *
 * @param {HTMLElement} el - Root element to search.
 * @param {string} text - Expected button text.
 * @returns {HTMLButtonElement|undefined} Matching button.
 */
function findButtonByText(el, text) {
  return Array.from(el.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
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
  document.body.style.overflow = '';
}

describe('LockedArchivePanel', () => {
  let LockedArchivePanel;

  beforeAll(() => {
    LockedArchivePanel = require('../LockedArchivePanel').default;
    useOverlayAccessibility = require('../../hooks/useOverlayAccessibility.js').useOverlayAccessibility;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGet.mockResolvedValue({
      error: null,
      data: {
        data: {
          data: [
            {
              id: 'locked-1',
              created_at: '2026-05-01T12:00:00.000Z',
              locked_at: '2026-06-01T12:00:00.000Z',
              locked_reason: 'premium_to_free_over_plan_limit',
              locked_policy_version: 'v1',
              company: 'Hidden Company',
              position: 'Hidden Role',
              notes: 'Hidden notes',
              salary_min: 100000,
              salary_max: 140000,
              status: 'interviewing',
              history: [{ status: 'applied' }],
            },
          ],
          count: 1,
        },
      },
    });
    mockApiDelete.mockResolvedValue({
      error: null,
      data: {
        data: { deletedCount: 1 },
        error: null,
        message: 'Locked archive deleted successfully',
      },
    });
  });

  afterEach(cleanup);

  it('renders nothing when there are no locked rows', () => {
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: { lockedCount: 0 },
    }));

    expect(el.textContent).toBe('');
  });

  it('loads and renders teaser-only archive preview rows', async () => {
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: { lockedCount: 1 },
    }));

    expect(el.textContent).toContain('Locked archive');
    expect(el.querySelector('a[href="/api/storage/export"]')).toBeTruthy();
    expect(findButtonByText(el, 'Delete Archive')).toBeUndefined();

    click(findButtonByText(el, 'View archive'));
    await flushEffects();

    expect(mockApiGet).toHaveBeenCalledWith('/api?storage_state=locked&from=0&to=14');
    expect(el.textContent).toContain('Archived application 1');
    expect(el.textContent).toContain('May 1, 2026');
    expect(el.textContent).toContain('June 1, 2026');
    expect(el.textContent).toContain('Moved after Premium ended');
    expect(el.textContent).not.toContain('Hidden Company');
    expect(el.textContent).not.toContain('Hidden Role');
    expect(el.textContent).not.toContain('Hidden notes');
    expect(el.textContent).not.toContain('100000');
    expect(el.textContent).not.toContain('140000');
    expect(el.textContent).not.toContain('interviewing');
    expect(el.textContent).not.toContain('history');
  });

  it('links disclosure state to the archive content and collapses it without another fetch', async () => {
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: { lockedCount: 1 },
    }));
    const viewButton = findButtonByText(el, 'View archive');
    const contentId = viewButton.getAttribute('aria-controls');

    expect(viewButton.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(contentId)).toBeNull();

    click(viewButton);
    await flushEffects();
    const hideButton = findButtonByText(el, 'Hide archive');
    expect(hideButton.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(contentId)).toBeTruthy();

    click(hideButton);
    expect(document.getElementById(contentId)).toBeNull();
    click(findButtonByText(el, 'View archive'));
    await flushEffects();
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it('announces loading and renders the empty preview state safely', async () => {
    const deferred = createDeferred();
    mockApiGet.mockReturnValueOnce(deferred.promise);
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: { lockedCount: 2 },
    }));

    click(findButtonByText(el, 'View archive'));
    expect(el.querySelector('[role=status]').textContent).toBe('Loading archive...');

    await act(async () => {
      deferred.resolve({
        error: null,
        data: { data: { data: [], count: 0 } },
      });
      await deferred.promise;
    });

    expect(el.querySelector('[role=status]')).toBeNull();
    expect(el.textContent).toContain('No archived applications were returned for this preview.');
    expect(el.textContent).toContain('Showing 0 of 2 archived applications.');
  });

  it('announces preview errors without rendering teaser details', async () => {
    mockApiGet.mockResolvedValueOnce({
      error: null,
      data: { data: null, error: 'ARCHIVE_UNAVAILABLE', message: 'Archive preview is unavailable.' },
    });
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: { lockedCount: 1 },
    }));

    click(findButtonByText(el, 'View archive'));
    await flushEffects();

    expect(el.querySelector('[role=alert]').textContent).toBe('Archive preview is unavailable.');
    expect(el.textContent).not.toContain('Archived application 1');
  });

  it('shows locked bulk delete only for terminal-Free archive summaries', () => {
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: {
        status: 'premium_canceling',
        lockedCount: 2,
        activeCount: 300,
        activeLimit: 300,
      },
    }));

    expect(findButtonByText(el, 'Delete Archive')).toBeUndefined();
  });

  it('requires a second confirmation before calling locked bulk delete', async () => {
    const onArchiveDeleted = jest.fn().mockResolvedValue({ success: true });
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: {
        status: 'terminal_free',
        lockedCount: 1,
        activeCount: 300,
        activeLimit: 300,
      },
      onArchiveDeleted,
    }));

    click(findButtonByText(el, 'Delete Archive'));

    expect(el.textContent).toContain('Permanently delete 1 archived application?');
    expect(el.textContent).toContain('You currently have 300 active.');
    expect(mockApiDelete).not.toHaveBeenCalled();

    click(findButtonByText(el, 'Permanently Delete Archive'));
    await flushEffects();
    await flushEffects();

    expect(mockApiDelete).toHaveBeenCalledWith('/api/storage/locked-jobs', {
      confirmation: 'permanently_delete_locked_jobs',
    });
    expect(onArchiveDeleted).toHaveBeenCalledWith({ deletedCount: 1 });
    expect(el.textContent).not.toContain('Permanently delete 1 archived application?');
  });

  it('ignores duplicate confirm clicks while locked bulk delete is in flight', async () => {
    let resolveDelete;
    const pendingDelete = new Promise((resolve) => {
      resolveDelete = resolve;
    });
    const onArchiveDeleted = jest.fn().mockResolvedValue({ success: true });
    mockApiDelete.mockReturnValueOnce(pendingDelete);
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: {
        status: 'terminal_free',
        lockedCount: 1,
        activeCount: 300,
        activeLimit: 300,
      },
      onArchiveDeleted,
    }));

    click(findButtonByText(el, 'Delete Archive'));
    const confirmButton = findButtonByText(el, 'Permanently Delete Archive');

    act(() => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiDelete).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete({
        error: null,
        data: {
          data: { deletedCount: 1 },
          error: null,
          message: 'Locked archive deleted successfully',
        },
      });
      await pendingDelete;
    });
    await flushEffects();

    expect(onArchiveDeleted).toHaveBeenCalledWith({ deletedCount: 1 });
  });

  it('propagates callback errors without showing delete error', async () => {
    const callbackError = new Error('Refresh failed');
    const callbackPromise = Promise.reject(callbackError);
    callbackPromise.catch(() => {});
    const onArchiveDeleted = jest.fn().mockReturnValue(callbackPromise);
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: {
        status: 'terminal_free',
        lockedCount: 1,
        activeCount: 300,
        activeLimit: 300,
      },
      onArchiveDeleted,
    }));

    click(findButtonByText(el, 'Delete Archive'));
    const confirmButton = findButtonByText(el, 'Permanently Delete Archive');

    click(confirmButton);
    await flushEffects();
    await flushEffects();

    expect(mockApiDelete).toHaveBeenCalledTimes(1);
    expect(onArchiveDeleted).toHaveBeenCalledWith({ deletedCount: 1 });
    await expect(onArchiveDeleted.mock.results[0].value).rejects.toThrow('Refresh failed');
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(el.textContent).not.toContain('Refresh failed');
    expect(el.textContent).not.toContain('Locked archive deletion is available only');
  });

  it('renders public delete errors inside the confirmation modal', async () => {
    mockApiDelete.mockResolvedValueOnce({
      error: null,
      data: {
        data: null,
        error: 'LOCKED_BULK_DELETE_NOT_ALLOWED',
        message: 'Locked archive deletion is available only for confirmed Free accounts with archived applications.',
      },
    });
    const el = render(React.createElement(LockedArchivePanel, {
      storageSummary: {
        status: 'terminal_free',
        lockedCount: 2,
        activeCount: 299,
        activeLimit: 300,
      },
    }));

    click(findButtonByText(el, 'Delete Archive'));
    click(findButtonByText(el, 'Permanently Delete Archive'));
    await flushEffects();

    expect(el.textContent).toContain(
      'Locked archive deletion is available only for confirmed Free accounts with archived applications.'
    );
  });

  it('contains focus, returns it to Delete Archive, and preserves an underlying scroll lock', () => {
    document.body.style.overflow = 'clip';
    const panel = React.createElement(LockedArchivePanel, {
      key: 'archive',
      storageSummary: {
        status: 'terminal_free',
        lockedCount: 1,
        activeCount: 300,
        activeLimit: 300,
      },
    });
    const el = render(React.createElement(React.Fragment, null, [
      React.createElement(BackgroundOverlay, { key: 'background', onClose: jest.fn() }),
      panel,
    ]));
    const deleteTrigger = findButtonByText(el, 'Delete Archive');
    deleteTrigger.focus();
    click(deleteTrigger);
    const dialog = el.querySelector('[role=dialog]');
    const closeButton = el.querySelector('[aria-label=\'Close locked archive delete confirmation\']');
    const confirmButton = findButtonByText(el, 'Permanently Delete Archive');

    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe('hidden');

    confirmButton.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(closeButton);

    click(findButtonByText(el, 'Cancel'));
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(deleteTrigger);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(null);
    expect(document.body.style.overflow).toBe('clip');
  });
});
