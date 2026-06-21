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
}

describe('LockedArchivePanel', () => {
  let LockedArchivePanel;

  beforeAll(() => {
    LockedArchivePanel = require('../LockedArchivePanel').default;
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
              status: 'interviewing',
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
    expect(el.textContent).not.toContain('interviewing');
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
});
