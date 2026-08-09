/**
 * CHUNK-0 draft-quarantine regressions for the add/edit form controller.
 *
 * Purpose: Freeze bounded volatile draft behavior so auth uncertainty never
 * discards silently, crosses subjects, or automatically replays a mutation.
 * Connects to: useJobFormModal, JobForm, and the CHUNK-3 auth work epoch.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

const {
  QUARANTINED_DRAFT_POLICY,
} = require('../../../testSupport/authV2ContractFixtures.js');
const jobFormModalModule = require('../useJobFormModal.js');
const { useJobFormModal } = jobFormModalModule;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE_SUBJECT = '00000000-0000-4000-8000-000000000001';
const OTHER_SUBJECT = '00000000-0000-4000-8000-000000000002';
const EDITED_JOB = '00000000-0000-4000-8000-000000000010';
const VALID_DRAFT = Object.freeze({
  company: 'Example Company',
  position: 'Engineer',
  status: 'applied',
  salary: null,
  notes: 'Follow up next week.',
});

let container;
let latestHook;
let root;

/**
 * Captures the current form-controller result for direct behavior assertions.
 *
 * @param {object} props - Auth binding and fresh-data readiness inputs.
 * @returns {React.ReactElement} Non-sensitive controller state marker.
 */
function HookHarness(props) {
  latestHook = useJobFormModal(props);

  return React.createElement('div', {
    'data-quarantined': Boolean(latestHook.quarantinedDraft),
    'data-restorable': Boolean(latestHook.canRestoreDraft),
  });
}

/**
 * Mounts the form controller with one verified auth/work-epoch binding.
 *
 * @param {object} overrides - Inputs replacing the authenticated defaults.
 * @returns {void}
 */
function renderHook(overrides = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(HookHarness, {
      authStatus: 'authenticated',
      freshDataLoaded: true,
      onMutation: jest.fn(),
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
      ...overrides,
    }));
  });
}

/**
 * Re-renders the controller to simulate an auth or work-epoch transition.
 *
 * @param {object} props - Complete next controller inputs.
 * @returns {void}
 */
function rerenderHook(props) {
  act(() => {
    root.render(React.createElement(HookHarness, props));
  });
}

/**
 * Requires a future controller method through a Jest assertion, avoiding a
 * runtime TypeError while CHUNK-3 behavior is intentionally absent.
 *
 * @param {string} methodName - Public controller method under test.
 * @returns {Function} Bound hook method after the assertion succeeds.
 */
function requireHookMethod(methodName) {
  const method = latestHook?.[methodName];

  expect(method).toEqual(expect.any(Function));
  return method;
}

/**
 * Stores one active edit draft through the future controller boundary.
 *
 * @param {object} [draft] - Canonical form fields to store.
 * @param {string|null} [jobId] - Edited job binding or null for add mode.
 * @returns {void}
 */
function setActiveDraft(draft = VALID_DRAFT, jobId = EDITED_JOB) {
  const setter = requireHookMethod('setActiveDraft');

  act(() => {
    setter({ draft, jobId });
  });
}

/** Removes the mounted hook and restores timer behavior. */
function cleanup() {
  if (root) act(() => root.unmount());
  container?.remove();
  container = null;
  latestHook = undefined;
  root = null;
  jest.useRealTimers();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(cleanup);

describe('useJobFormModal draft quarantine contract', () => {
  it('quarantines an active draft on unavailable without mutation replay', () => {
    const onMutation = jest.fn();
    renderHook({ onMutation });
    setActiveDraft();

    rerenderHook({
      authStatus: 'unavailable',
      freshDataLoaded: false,
      onMutation,
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    });

    expect(latestHook.activeDraft).toBeNull();
    expect(latestHook.quarantinedDraft).toEqual(expect.objectContaining({
      draft: VALID_DRAFT,
      jobId: EDITED_JOB,
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    }));
    expect(onMutation).not.toHaveBeenCalled();
  });

  it('measures canonical serialized JSON at the UTF-8 boundary including multibyte overflow', () => {
    const measureDraftBytes = jobFormModalModule.getCanonicalDraftByteLength;
    expect(measureDraftBytes).toEqual(expect.any(Function));
    const emptyDraft = {
      company: '',
      position: '',
      status: 'applied',
      salary: null,
      notes: '',
    };
    const emptyBytes = new TextEncoder().encode(JSON.stringify(emptyDraft)).length;
    const exactDraft = {
      ...emptyDraft,
      company: 'x'.repeat(QUARANTINED_DRAFT_POLICY.maxUtf8Bytes - emptyBytes),
    };
    const multibyteOverflow = {
      ...exactDraft,
      company: `${exactDraft.company}💡`,
    };

    expect(measureDraftBytes(exactDraft)).toBe(4096);
    expect(measureDraftBytes(multibyteOverflow)).toBe(4100);
  });

  it('expires against the absolute quarantine timestamp without sliding renewal', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    renderHook();
    setActiveDraft();
    const quarantine = requireHookMethod('quarantineDraft');

    act(() => quarantine());
    const quarantinedAt = latestHook.quarantinedDraft?.quarantinedAt;
    jest.advanceTimersByTime(QUARANTINED_DRAFT_POLICY.maxAgeMs - 1);
    rerenderHook({
      authStatus: 'authenticated',
      freshDataLoaded: true,
      onMutation: jest.fn(),
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    });
    expect(latestHook.quarantinedDraft?.quarantinedAt).toBe(quarantinedAt);

    jest.advanceTimersByTime(1);
    rerenderHook({
      authStatus: 'authenticated',
      freshDataLoaded: true,
      onMutation: jest.fn(),
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    });
    expect(latestHook.quarantinedDraft).toBeNull();
  });

  it.each([
    ['confirmed anonymity', { authStatus: 'anonymous' }],
    ['logout start', { authStatus: 'logout_unconfirmed' }],
    ['local logout', { authStatus: 'signed_out_local' }],
    ['terminal account', { authStatus: 'terminal_unauthenticated' }],
    ['subject replacement', { subjectId: OTHER_SUBJECT }],
    ['authorization epoch change', { workEpoch: 2 }],
  ])('purges the quarantine on %s', (_name, transition) => {
    renderHook();
    setActiveDraft();
    const quarantine = requireHookMethod('quarantineDraft');
    act(() => quarantine());

    rerenderHook({
      authStatus: 'authenticated',
      freshDataLoaded: true,
      onMutation: jest.fn(),
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
      ...transition,
    });

    expect(latestHook.quarantinedDraft).toBeNull();
  });

  it('purges volatile quarantine state when the provider controller tears down', () => {
    renderHook();
    setActiveDraft();
    const quarantine = requireHookMethod('quarantineDraft');
    act(() => quarantine());
    expect(latestHook.quarantinedDraft).toBeTruthy();

    cleanup();
    renderHook();

    expect(latestHook.quarantinedDraft).toBeNull();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('requires same job binding, fresh data, and explicit restore without replay', () => {
    const onMutation = jest.fn();
    renderHook({ freshDataLoaded: false, onMutation });
    setActiveDraft();
    const quarantine = requireHookMethod('quarantineDraft');
    act(() => quarantine());

    rerenderHook({
      authStatus: 'authenticated',
      freshDataLoaded: false,
      onMutation,
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    });
    expect(latestHook.canRestoreDraft).toBe(false);
    expect(latestHook.activeDraft).toBeNull();
    expect(onMutation).not.toHaveBeenCalled();

    rerenderHook({
      authStatus: 'authenticated',
      freshDataLoaded: true,
      onMutation,
      subjectId: ACTIVE_SUBJECT,
      workEpoch: 1,
    });
    expect(latestHook.canRestoreDraft).toBe(true);
    expect(latestHook.activeDraft).toBeNull();

    const restore = requireHookMethod('restoreQuarantinedDraft');
    act(() => restore({ jobId: EDITED_JOB }));

    expect(latestHook.activeDraft).toEqual({ draft: VALID_DRAFT, jobId: EDITED_JOB });
    expect(latestHook.quarantinedDraft).toBeNull();
    expect(onMutation).not.toHaveBeenCalled();
  });

  it('rejects explicit restoration for the wrong job without consuming the draft', () => {
    renderHook();
    setActiveDraft();
    const quarantine = requireHookMethod('quarantineDraft');
    act(() => quarantine());
    const restore = requireHookMethod('restoreQuarantinedDraft');
    let result;

    act(() => {
      result = restore({ jobId: '00000000-0000-4000-8000-000000000099' });
    });

    expect(result).toEqual({ status: 'rejected', reason: 'binding' });
    expect(latestHook.activeDraft).toBeNull();
    expect(latestHook.quarantinedDraft).toBeTruthy();
  });
});
