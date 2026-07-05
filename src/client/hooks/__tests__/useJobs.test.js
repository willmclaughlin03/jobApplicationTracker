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
const { ERROR_MESSAGES } = require('../../../shared/errors.js');

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
let useUpdateJob;
let container;
let root;
let latestHook;
let latestUpdateHook;

/**
 * Builds the shared client response envelope used by mocked api methods.
 *
 * Purpose: mirror apiRequest's { data, error, meta } shape while letting tests
 * control the inner standardized API response body.
 *
 * @param {unknown} data - Standardized API response data payload.
 * @param {object} responseFields - Additional fields on the standardized API response body.
 * @returns {object} Mock shared-client success response.
 */
function buildApiSuccess(data, responseFields = {}) {
  return {
    data: {
      data,
      error: null,
      message: 'Success',
      ...responseFields,
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
 * Stores the latest useUpdateJob result for focused mutation-hook assertions.
 *
 * Purpose: exercise update request behavior without going through useJobs'
 * local-list success callback so callback failures can be isolated.
 *
 * @param {{onSuccess?: Function}} props Harness props.
 * @returns {import('react').ReactElement} Test harness marker element.
 */
function UpdateHookHarness({ onSuccess }) {
  latestUpdateHook = useUpdateJob(onSuccess);

  return React.createElement(
    'div',
    { 'data-testid': 'update-hook' },
    latestUpdateHook.saving ? 'saving' : 'idle'
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
 * Renders the focused useUpdateJob harness and waits for React state setup.
 *
 * Purpose: keep update-hook regression tests independent from full jobs list
 * loading while reusing the same jsdom root cleanup path.
 *
 * @param {Function} onSuccess - Success callback passed to useUpdateJob.
 * @returns {Promise<HTMLElement>} Rendered container.
 */
async function renderUseUpdateJob(onSuccess) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(UpdateHookHarness, { onSuccess }));
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
  latestUpdateHook = null;
}

describe('useJobs storage summary refresh', () => {
  beforeAll(() => {
    useJobs = require('../useJobs.js').useJobs;
    useUpdateJob = require('../jobs/useUpdateJob.js').useUpdateJob;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(cleanup);

  it('clears loading and exposes normalized fetch errors when initial jobs load rejects', async () => {
    mockApiGet.mockRejectedValue({ code: 'FETCH_FAILED' });

    await renderUseJobs();

    expect(mockApiGet).toHaveBeenCalledWith('/api');
    expect(latestHook.loading).toBe(false);
    expect(latestHook.error).toEqual(expect.objectContaining({
      message: ERROR_MESSAGES.FETCH_FAILED,
      code: 'FETCH_FAILED',
    }));
  });

  it('keeps loading true when a stale full refetch resolves before a newer one', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const staleJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const latestJob = { id: 'job-3', company: 'Core', position: 'Manager', status: 'interviewing' };
    const jobsRequests = [];
    let jobsRequestCount = 0;

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        jobsRequestCount += 1;

        if (jobsRequestCount === 1) {
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

        const deferred = createDeferred();
        jobsRequests.push(deferred);
        return deferred.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });

    await renderUseJobs();

    expect(latestHook.loading).toBe(false);

    let staleRefetchPromise;
    await act(async () => {
      staleRefetchPromise = latestHook.refetch();
      await Promise.resolve();
    });

    let latestRefetchPromise;
    await act(async () => {
      latestRefetchPromise = latestHook.refetch();
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(true);
    expect(jobsRequests).toHaveLength(2);

    await act(async () => {
      jobsRequests[0].resolve(buildJobsResponse({
        jobs: [staleJob],
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 250,
          lockedCount: 0,
          projectedOverflowCount: 0,
          cancelAtPeriodEnd: true,
        },
      }));
      await staleRefetchPromise;
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(true);
    expect(latestHook.allJobs).toEqual([initialJob]);

    await act(async () => {
      jobsRequests[1].resolve(buildJobsResponse({
        jobs: [latestJob],
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 280,
          lockedCount: 0,
          projectedOverflowCount: 0,
          cancelAtPeriodEnd: true,
        },
      }));
      await latestRefetchPromise;
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([latestJob]);
    expect(latestHook.storageSummary.activeCount).toBe(280);
  });

  it('uses add response storage summary without an extra status refresh', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const addStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 302,
      lockedCount: 0,
      projectedOverflowCount: 2,
      cancelAtPeriodEnd: true,
    };

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

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPost.mockResolvedValue(buildApiSuccess([createdJob], {
      storageSummary: addStorageSummary,
    }));

    await renderUseJobs();

    let result;
    await act(async () => {
      result = await latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      data: createdJob,
      storageSummary: addStorageSummary,
    }));
    expect(latestHook.allJobs[0]).toEqual(createdJob);
    expect(latestHook.storageSummary.activeCount).toBe(302);
    expect(mockApiGet.mock.calls.filter(([endpoint]) => endpoint === '/api/storage/status')).toHaveLength(0);
  });

  it('uses delete response storage summary without an extra status refresh', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const deleteStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 300,
      lockedCount: 0,
      projectedOverflowCount: 0,
      cancelAtPeriodEnd: true,
    };

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

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiDelete.mockResolvedValue(buildApiSuccess({ id: initialJob.id }, {
      storageSummary: deleteStorageSummary,
    }));

    await renderUseJobs();

    let result;
    await act(async () => {
      result = await latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      storageSummary: deleteStorageSummary,
    }));
    expect(latestHook.allJobs).toEqual([]);
    expect(latestHook.storageSummary.activeCount).toBe(300);
    expect(mockApiGet.mock.calls.filter(([endpoint]) => endpoint === '/api/storage/status')).toHaveLength(0);
  });

  it('does not let a stale full fetch overwrite a successful add mutation', async () => {
    const staleJob = { id: 'job-stale', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-created', company: 'Beta', position: 'Designer', status: 'applied' };
    const initialFetch = createDeferred();
    const addStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 302,
      lockedCount: 0,
      projectedOverflowCount: 2,
      cancelAtPeriodEnd: true,
    };

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        return initialFetch.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPost.mockResolvedValue(buildApiSuccess([createdJob], {
      storageSummary: addStorageSummary,
    }));

    await renderUseJobs();

    expect(latestHook.loading).toBe(true);

    await act(async () => {
      await latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([createdJob]);
    expect(latestHook.storageSummary).toEqual(addStorageSummary);

    await act(async () => {
      initialFetch.resolve(buildJobsResponse({
        jobs: [staleJob],
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 301,
          lockedCount: 0,
          projectedOverflowCount: 1,
          cancelAtPeriodEnd: true,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestHook.allJobs).toEqual([createdJob]);
    expect(latestHook.storageSummary).toEqual(addStorageSummary);
  });

  it('does not let a stale full refetch overwrite a successful delete mutation', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const staleRefetch = createDeferred();
    const deleteStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 300,
      lockedCount: 0,
      projectedOverflowCount: 0,
      cancelAtPeriodEnd: true,
    };
    let jobsRequestCount = 0;

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        jobsRequestCount += 1;

        if (jobsRequestCount === 1) {
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

        return staleRefetch.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiDelete.mockResolvedValue(buildApiSuccess({ id: initialJob.id }, {
      storageSummary: deleteStorageSummary,
    }));

    await renderUseJobs();

    let refetchPromise;
    await act(async () => {
      refetchPromise = latestHook.refetch();
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(true);

    await act(async () => {
      await latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([]);
    expect(latestHook.storageSummary).toEqual(deleteStorageSummary);

    await act(async () => {
      staleRefetch.resolve(buildJobsResponse({
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
      await refetchPromise;
      await Promise.resolve();
    });

    expect(latestHook.allJobs).toEqual([]);
    expect(latestHook.storageSummary).toEqual(deleteStorageSummary);
  });

  it('does not let a stale full refetch overwrite a successful update mutation', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied', notes: 'Original' };
    const staleRefetch = createDeferred();
    let jobsRequestCount = 0;

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        jobsRequestCount += 1;

        if (jobsRequestCount === 1) {
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

        return staleRefetch.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPut.mockResolvedValue(buildApiSuccess([{ ...initialJob, notes: 'Updated' }]));

    await renderUseJobs();

    let refetchPromise;
    await act(async () => {
      refetchPromise = latestHook.refetch();
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(true);

    await act(async () => {
      await latestHook.updateJob(initialJob.id, { notes: 'Updated' });
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([{ ...initialJob, notes: 'Updated' }]);

    await act(async () => {
      staleRefetch.resolve(buildJobsResponse({
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
      await refetchPromise;
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([{ ...initialJob, notes: 'Updated' }]);
  });

  it('ignores duplicate add calls while one add is in flight', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const addRequest = createDeferred();
    const addStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 302,
      lockedCount: 0,
      projectedOverflowCount: 2,
      cancelAtPeriodEnd: true,
    };

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

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPost.mockReturnValue(addRequest.promise);

    await renderUseJobs();

    let firstAddPromise;
    let secondAddResult;
    await act(async () => {
      firstAddPromise = latestHook.addJob({ company: 'Beta', position: 'Designer' });
      secondAddResult = await latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(secondAddResult).toEqual(expect.objectContaining({ skipped: true, success: false }));

    await act(async () => {
      addRequest.resolve(buildApiSuccess([createdJob], {
        storageSummary: addStorageSummary,
      }));
      await firstAddPromise;
      await Promise.resolve();
    });

    expect(latestHook.allJobs).toEqual([createdJob, initialJob]);
    expect(latestHook.storageSummary).toEqual(addStorageSummary);
  });

  it('ignores duplicate delete calls while one delete is in flight', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const deleteRequest = createDeferred();
    const deleteStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 300,
      lockedCount: 0,
      projectedOverflowCount: 0,
      cancelAtPeriodEnd: true,
    };

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

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiDelete.mockReturnValue(deleteRequest.promise);

    await renderUseJobs();

    let firstDeletePromise;
    let secondDeleteResult;
    await act(async () => {
      firstDeletePromise = latestHook.deleteJob(initialJob.id);
      secondDeleteResult = await latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
    });

    expect(mockApiDelete).toHaveBeenCalledTimes(1);
    expect(secondDeleteResult).toEqual(expect.objectContaining({ skipped: true, success: false }));

    await act(async () => {
      deleteRequest.resolve(buildApiSuccess({ id: initialJob.id }, {
        storageSummary: deleteStorageSummary,
      }));
      await firstDeletePromise;
      await Promise.resolve();
    });

    expect(latestHook.allJobs).toEqual([]);
    expect(latestHook.storageSummary).toEqual(deleteStorageSummary);
  });

  it('ignores duplicate update calls while one update is in flight', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied', notes: 'Original' };
    const updateRequest = createDeferred();

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

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPut.mockReturnValue(updateRequest.promise);

    await renderUseJobs();

    let firstUpdatePromise;
    let secondUpdateResult;
    await act(async () => {
      firstUpdatePromise = latestHook.updateJob(initialJob.id, { notes: 'Updated' });
      secondUpdateResult = await latestHook.updateJob(initialJob.id, { notes: 'Updated again' });
      await Promise.resolve();
    });

    expect(mockApiPut).toHaveBeenCalledTimes(1);
    expect(secondUpdateResult).toEqual(expect.objectContaining({ skipped: true, success: false }));

    await act(async () => {
      updateRequest.resolve(buildApiSuccess([{ ...initialJob, notes: 'Updated' }]));
      await firstUpdatePromise;
      await Promise.resolve();
    });

    expect(latestHook.allJobs).toEqual([{ ...initialJob, notes: 'Updated' }]);
  });

  it('falls back to storage status refresh when delete response has no summary', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };

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
        return Promise.resolve(buildApiSuccess({
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 300,
          lockedCount: 0,
          projectedOverflowCount: 0,
          cancelAtPeriodEnd: true,
        }));
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiDelete.mockResolvedValue(buildApiSuccess({ id: initialJob.id }));

    await renderUseJobs();

    await act(async () => {
      await latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiGet.mock.calls.filter(([endpoint]) => endpoint === '/api/storage/status')).toHaveLength(1);
    expect(latestHook.allJobs).toEqual([]);
    expect(latestHook.storageSummary.activeCount).toBe(300);
    expect(latestHook.storageSummary.projectedOverflowCount).toBe(0);
  });

  it('ignores stale delete response summaries after a newer add mutation starts', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const deleteRequest = createDeferred();
    const storageRefreshes = [];
    const addStorageSummary = {
      status: 'premium_canceling',
      activeLimit: 300,
      activeCount: 303,
      lockedCount: 0,
      projectedOverflowCount: 3,
      cancelAtPeriodEnd: true,
    };

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
    mockApiDelete.mockReturnValue(deleteRequest.promise);
    mockApiPost.mockResolvedValue(buildApiSuccess([createdJob], {
      storageSummary: addStorageSummary,
    }));

    await renderUseJobs();

    let deletePromise;
    await act(async () => {
      deletePromise = latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
    });

    await act(async () => {
      await latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(303);

    await act(async () => {
      deleteRequest.resolve(buildApiSuccess({ id: initialJob.id }, {
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 300,
          lockedCount: 0,
          projectedOverflowCount: 0,
          cancelAtPeriodEnd: true,
        },
      }));
      await deletePromise;
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(303);
    expect(latestHook.storageSummary.projectedOverflowCount).toBe(3);
    expect(storageRefreshes).toHaveLength(1);

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

    expect(latestHook.storageSummary.activeCount).toBe(302);
    expect(latestHook.storageSummary.projectedOverflowCount).toBe(2);
  });


  it('does not treat success callback exceptions as failed PUT requests', async () => {
    const callbackError = new Error('local update merge failed');
    const onSuccess = jest.fn(() => {
      throw callbackError;
    });
    const updates = { notes: 'Updated' };

    mockApiPut.mockResolvedValue(buildApiSuccess([{ id: 'job-1', ...updates }]));

    await renderUseUpdateJob(onSuccess);

    let thrownError;
    await act(async () => {
      try {
        await latestUpdateHook.updateJob('job-1', updates);
      } catch (error) {
        thrownError = error;
      }

      await Promise.resolve();
    });

    expect(mockApiPut).toHaveBeenCalledWith('/api/job-1', updates);
    expect(onSuccess).toHaveBeenCalledWith('job-1', updates);
    expect(thrownError).toBe(callbackError);
    expect(latestUpdateHook.error).toBeNull();
    expect(latestUpdateHook.saving).toBe(false);
  });
  it('ignores stale add response summaries after a newer delete mutation starts', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const addRequest = createDeferred();
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
    mockApiPost.mockReturnValue(addRequest.promise);
    mockApiDelete.mockResolvedValue(buildApiSuccess({ id: initialJob.id }));

    await renderUseJobs();

    let addPromise;
    await act(async () => {
      addPromise = latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    await act(async () => {
      await latestHook.deleteJob(initialJob.id);
      await Promise.resolve();
    });

    expect(storageRefreshes).toHaveLength(1);

    await act(async () => {
      addRequest.resolve(buildApiSuccess([createdJob], {
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 302,
          lockedCount: 0,
          projectedOverflowCount: 2,
          cancelAtPeriodEnd: true,
        },
      }));
      await addPromise;
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(301);
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
        activeCount: 299,
        lockedCount: 0,
        projectedOverflowCount: 0,
        cancelAtPeriodEnd: true,
      }));
      await Promise.resolve();
    });

    expect(latestHook.storageSummary.activeCount).toBe(300);
  });

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

  it('invalidates an in-flight full refetch after a successful add mutation', async () => {
    const initialJob = { id: 'job-1', company: 'Acme', position: 'Engineer', status: 'applied' };
    const createdJob = { id: 'job-2', company: 'Beta', position: 'Designer', status: 'applied' };
    const staleRefetchedJob = { id: 'job-3', company: 'Core', position: 'Manager', status: 'interviewing' };
    const jobsRequests = [];
    const storageRefreshes = [];
    let jobsRequestCount = 0;

    mockApiGet.mockImplementation((endpoint) => {
      if (endpoint === '/api') {
        jobsRequestCount += 1;

        if (jobsRequestCount === 1) {
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

        const deferred = createDeferred();
        jobsRequests.push(deferred);
        return deferred.promise;
      }

      if (endpoint === '/api/storage/status') {
        const deferred = createDeferred();
        storageRefreshes.push(deferred);
        return deferred.promise;
      }

      return Promise.resolve(buildApiSuccess(null));
    });
    mockApiPost.mockResolvedValue(buildApiSuccess([createdJob]));

    await renderUseJobs();

    expect(latestHook.loading).toBe(false);

    let refetchPromise;
    await act(async () => {
      refetchPromise = latestHook.refetch();
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(true);
    expect(jobsRequests).toHaveLength(1);

    await act(async () => {
      await latestHook.addJob({ company: 'Beta', position: 'Designer' });
      await Promise.resolve();
    });

    expect(storageRefreshes).toHaveLength(1);

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

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([createdJob, initialJob]);
    expect(latestHook.storageSummary.activeCount).toBe(302);

    await act(async () => {
      jobsRequests[0].resolve(buildJobsResponse({
        jobs: [staleRefetchedJob],
        storageSummary: {
          status: 'premium_canceling',
          activeLimit: 300,
          activeCount: 280,
          lockedCount: 0,
          projectedOverflowCount: 0,
          cancelAtPeriodEnd: true,
        },
      }));
      await refetchPromise;
      await Promise.resolve();
    });

    expect(latestHook.loading).toBe(false);
    expect(latestHook.allJobs).toEqual([createdJob, initialJob]);
    expect(latestHook.storageSummary.activeCount).toBe(302);
  });
});
