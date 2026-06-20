/**
 * Tests for useJobs storage summary refresh behavior.
 *
 * Purpose: verify count-changing local mutations refresh server-owned storage
 * metadata and do not let older refresh responses overwrite newer summaries.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiPut = jest.fn();
const mockApiDelete = jest.fn();

jest.mock('../../lib/api.js', () => ({
  api: {
    get: (...args) => mockApiGet(...args),
    post: (...args) => mockApiPost(...args),
    put: (...args) => mockApiPut(...args),
    delete: (...args) => mockApiDelete(...args),
  },
}));

let useJobs;
let container;
let root;
let latestHook;

/**
 * Builds the shared client response envelope used by mocked api methods.
 *
 * Purpose: mirror apiRequest's { data, error, meta } shape while letting tests
 * control the inner standardized API response body.
 *
 * @param {unknown} data - Standardized API response data payload.
 * @returns {object} Mock shared-client success response.
 */
function buildApiSuccess(data) {
  return {
    data: {
      data,
      error: null,
      message: 'Success',
    },
    error: null,
    meta: { status: 200, retryAfterSeconds: null },
  };
}

/**
 * Builds the /api jobs collection response body expected by useJobsQuery.
 *
 * Purpose: keep job-list fixtures readable while preserving the nested API
 * envelope returned by the real jobs route.
 *
 * @param {{ jobs: object[], storageSummary: object }} params - Fixture data.
 * @returns {object} Mock shared-client jobs response.
 */
function buildJobsResponse({ jobs, storageSummary }) {
  return buildApiSuccess({
    data: jobs,
    count: jobs.length,
    storageSummary,
  });
}

/**
 * Creates a deferred promise for ordering async storage-summary refreshes.
 *
 * Purpose: tests can resolve newer refreshes before older ones and assert the
 * hook keeps latest-response semantics.
 *
 * @returns {{ promise: Promise<any>, resolve: (value: any) => void, reject: (reason?: any) => void }} Deferred handle.
 */
function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

/**
 * Stores the latest useJobs result and renders summary state for assertions.
 *
 * Purpose: expose hook state without adding a test-only dependency on a hook
 * testing library.
 *
 * @returns {import('react').ReactElement} Test harness marker element.
 */
function HookHarness() {
  latestHook = useJobs('user-123');

  return React.createElement(
    'div',
    { 'data-testid': 'storage-summary' },
    latestHook.storageSummary?.activeCount ?? 'none'
  );
}

/**
 * Flushes pending promise continuations from async React effects.
 *
 * Purpose: useJobs loads initial data in an effect, so tests need to wait for
 * the mocked API promise and follow-up state update to settle.
 *
 * @returns {Promise<void>}
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Renders the hook harness into a jsdom root and waits for initial loading.
 *
 * Purpose: centralize root creation and initial effect flushing for each test.
 *
 * @returns {Promise<HTMLElement>} Rendered container.
 */
async function renderUseJobs() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookHarness));
  });

  await flushEffects();
  return container;
}

/**
 * Removes the active jsdom root and container after each test.
 *
 * Purpose: isolate hook state, timers, and DOM between test cases.
 *
 * @returns {void}
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
  latestHook = null;
}

describe('useJobs storage summary refresh', () => {
  beforeAll(() => {
    useJobs = require('../useJobs.js').useJobs;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(cleanup);

  it('keeps the newest storage summary when add/delete refreshes resolve out of order', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const storageRefreshes = [];

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        return Promise.resolve(buildJobsResponse({
          jobs: [initialJob],
          storageSummary: {
            status: 'premium_canceling',
            activeLimit: 300,
            activeCount: 301,
            lockedCount: 0,
            projectedOverflowCount: 1,
            cancelAtPeriodEnd: true,
          },
        }));
      }

      if (endpoint === '/api/storage/status') {
        const deferred = createDeferred();
        storageRefreshes.push(deferred);
        return deferred.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPost.mockResolvedValue(buildApiSuccess([createdJob]));
    mockApiDelete.mockResolvedValue(buildApiSuccess({ id: initialJob.id }));

    await renderUseJobs();

    expect(latestHook.storageSummary.activeCount).toBe(301);

    await act(async () => {
      await Promise.all([
        latestHook.addJob({ company: 'Beta', position: 'Designer' }),
        latestHook.deleteJob(initialJob.id),
      ]);
    });

    expect(mockApiGet).toHaveBeenCalledWith('/api/storage/status');
    expect(storageRefreshes).toHaveLength(2);

    await act(async () => {
      storageRefreshes[1].resolve(buildApiSuccess({
        status: 'premium_canceling',
        activeLimit: 300,
        activeCount: 300,
        lockedCount: 0,
        projectedOverflowCount: 0,
        cancelAtPeriodEnd: true,
      }));
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(300);
    expect(latestHook.storageSummary.projectedOverflowCount).toBe(0);

    await act(async () => {
      storageRefreshes[0].resolve(buildApiSuccess({
        status: 'premium_canceling',
        activeLimit: 300,
        activeCount: 302,
        lockedCount: 0,
        projectedOverflowCount: 2,
        cancelAtPeriodEnd: true,
      }));
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(300);
    expect(latestHook.storageSummary.projectedOverflowCount).toBe(0);
  });
});
