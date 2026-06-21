/**
 * Tests for LockedArchivePanel.
 *
 * Purpose: verify the archive preview uses the locked teaser API route and
 * renders only teaser-safe fields while exposing the CSV export path.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockApiGet = jest.fn();

jest.mock('../../lib/api.js', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
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

    click(el.querySelector('button'));
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
});
