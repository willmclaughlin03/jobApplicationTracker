/**
 * Tests for Dashboard billing-entry and upgrade-modal integration.
 *
 * Purpose: verify storage-summary presentation maps to the correct modal or
 * Billing route while preserving auth recovery and existing toolbar controls.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const {
  BILLING_PLANS,
  STORAGE_STATUSES,
} = require('../../shared/constants/billing.js');
const { PLAN_CATALOG } = require('../../client/lib/planCatalog.js');
const tailwindConfig = require('../../../tailwind.config.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};
const mockUseAuth = jest.fn();
const mockUseJobs = jest.fn();
const mockUseJobFormModal = jest.fn();
const mockSignOut = jest.fn();
const mockToggleAddForm = jest.fn();

let mockLatestUpgradeModalProps = null;
let mockLatestSidebarProps = null;
let mockLatestActivityProps = null;
let mockLatestProfileProps = null;
let mockLatestJobTableProps = null;
let mockLatestEditModalProps = null;
let mockLatestDeleteModalProps = null;
let mockLatestJobFormProps = null;
const mockWideMediaQuery = {
  matches: false,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};
const mockWideMediaListeners = new Set();

/** Return the shared mutable media-query fixture for Dashboard renders. */
function getMockWideMediaQuery() {
  return mockWideMediaQuery;
}

/**
 * Register one media-query listener in the test-owned listener set.
 *
 * @param {string} _event - Ignored event name from the browser API.
 * @param {Function} listener - Dashboard change listener.
 * @returns {void}
 */
function addMockWideMediaListener(_event, listener) {
  mockWideMediaListeners.add(listener);
}

/**
 * Remove one media-query listener during Dashboard cleanup.
 *
 * @param {string} _event - Ignored event name from the browser API.
 * @param {Function} listener - Dashboard change listener.
 * @returns {void}
 */
function removeMockWideMediaListener(_event, listener) {
  mockWideMediaListeners.delete(listener);
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: jest.fn(getMockWideMediaQuery),
});

mockWideMediaQuery.addEventListener.mockImplementation(addMockWideMediaListener);
mockWideMediaQuery.removeEventListener.mockImplementation(removeMockWideMediaListener);

jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

/**
 * Replace Next's build-time font loader with deterministic dashboard CSS hooks.
 */
jest.mock('next/font/google', () => ({
  Inter: jest.fn().mockReturnValue({
    className: 'mock-dashboard-font',
    variable: 'mock-dashboard-font-variable',
  }),
}));

jest.mock('../../client/contexts/AuthContext', () => ({
  useAuth: (...args) => mockUseAuth(...args),
}));

jest.mock('../../client/hooks/useJobs', () => ({
  useJobs: (...args) => mockUseJobs(...args),
}));

jest.mock('../../client/hooks/useJobFormModal', () => ({
  useJobFormModal: (...args) => mockUseJobFormModal(...args),
}));

jest.mock('../../client/components/UpgradePlanModal', () => {
  const React = require('react');

  /** Expose controlled modal callbacks without repeating Chunk 3 behavior. */
  return function MockUpgradePlanModal(props) {
    mockLatestUpgradeModalProps = props;

    if (!props.isOpen) {
      return null;
    }

    return React.createElement('div', { 'data-testid': 'upgrade-modal' }, [
      React.createElement('button', {
        key: 'close',
        type: 'button',
        onClick: props.onClose,
      }, 'Modal close'),
      React.createElement('button', {
        key: 'billing',
        type: 'button',
        onClick: props.onGoToBilling,
      }, 'Modal billing'),
      React.createElement('button', {
        key: 'unauthorized',
        type: 'button',
        onClick: props.onUnauthorized,
      }, 'Modal unauthorized'),
    ]);
  };
});

jest.mock('../../client/components/JobStatsSidebar', () => {
  const React = require('react');

  /** Capture Filters drawer state for integration assertions. */
  return function MockJobStatsSidebar(props) {
    mockLatestSidebarProps = props;
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'filters-overlay' })
      : null;
  };
});

jest.mock('../../client/components/ActivityDrawer', () => {
  const React = require('react');

  /** Capture Activity drawer state for integration assertions. */
  return function MockActivityDrawer(props) {
    mockLatestActivityProps = props;
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'activity-overlay' })
      : null;
  };
});

jest.mock('../../client/components/InfoTooltip', () => {
  const React = require('react');

  /** Mark the existing tooltip position without rendering its overlay logic. */
  return function MockInfoTooltip() {
    return React.createElement('div', { 'data-testid': 'info-tooltip' });
  };
});

jest.mock('../../client/components/ProfileDropdown', () => {
  const React = require('react');

  /** Keep ProfileDropdown behavior isolated to its focused component suite. */
  return function MockProfileDropdown(props) {
    mockLatestProfileProps = props;
    return React.createElement('div', { 'data-testid': 'account-control' }, props.user?.email);
  };
});

jest.mock('../../client/components/JobTable', () => {
  /** Capture job-table callbacks without rendering job rows. */
  return function MockJobTable(props) {
    mockLatestJobTableProps = props;
    return null;
  };
});

jest.mock('../../client/components/JobForm', () => {
  const React = require('react');

  /** Expose page-owned Add callbacks without duplicating component validation. */
  return function MockJobForm(props) {
    mockLatestJobFormProps = props;
    return React.createElement('div', { 'data-testid': 'job-form' }, [
      React.createElement('button', {
        key: 'cancel',
        type: 'button',
        onClick: props.onCancel,
      }, 'Cancel form'),
      React.createElement('button', {
        key: 'submit',
        type: 'button',
        onClick: () => props.onSubmit({ company: 'Acme', position: 'Engineer' }),
      }, 'Submit Add'),
    ]);
  };
});

jest.mock('../../client/components/EditModal', () => {
  const React = require('react');

  /** Capture edit-modal callbacks and expose one dialog-owned focus target. */
  return function MockEditModal(props) {
    mockLatestEditModalProps = props;
    return React.createElement('div', { role: 'dialog' }, React.createElement('input', {
      'aria-label': 'Edit company',
      defaultValue: props.job.company,
    }));
  };
});

jest.mock('../../client/components/DeleteModal', () => {
  /** Capture delete-modal callbacks without rendering the dialog. */
  return function MockDeleteModal(props) {
    mockLatestDeleteModalProps = props;
    return null;
  };
});

jest.mock('../../client/components/NextPageButton', () => {
  /** Omit pagination rendering from focused Dashboard tests. */
  return function MockNextPageButton() {
    return null;
  };
});

jest.mock('../../client/components/StorageDowngradeBanner', () => {
  /** Omit storage banner details while retaining the summary input path. */
  return function MockStorageDowngradeBanner() {
    return null;
  };
});

jest.mock('../../client/components/LockedArchivePanel', () => {
  /** Omit archive-panel details while retaining Dashboard summary state. */
  return function MockLockedArchivePanel() {
    return null;
  };
});

jest.mock('../../client/components/Spinner', () => {
  /** Omit loading decoration from settled-state tests. */
  return function MockSpinner() {
    return null;
  };
});

jest.mock('../../client/components/skeletons/DashboardSkeleton', () => {
  const React = require('react');

  /** Mark the auth-loading skeleton without rendering its implementation details. */
  return function MockDashboardSkeleton() {
    return React.createElement(
      'div',
      { className: 'dashboard-root mock-dashboard-font-variable' },
      React.createElement('div', { 'data-testid': 'dashboard-skeleton-marker' })
    );
  };
});

let Dashboard;
let container;
let root;

/**
 * Build the complete useJobs result consumed by the Dashboard.
 *
 * @param {object|null} storageSummary - Storage presentation hint under test.
 * @returns {object} Stable settled useJobs result.
 */
function buildJobsState(storageSummary) {
  return {
    jobs: [],
    allJobs: [],
    storageSummary,
    loading: false,
    saving: false,
    deleting: null,
    error: null,
    clearError: jest.fn(),
    addJob: jest.fn().mockResolvedValue({ success: true }),
    updateJob: jest.fn().mockResolvedValue({ success: true }),
    deleteJob: jest.fn().mockResolvedValue({ success: true }),
    refreshStorageSummary: jest.fn(),
    currentPage: 1,
    totalCount: 0,
    totalJobs: 0,
    statusCounts: {},
    pageSize: 10,
    goToPage: jest.fn(),
  };
}

/**
 * Build the settled job-form controller consumed by the Dashboard.
 *
 * @returns {object} Stable closed form/modal state and callbacks.
 */
function buildJobFormState() {
  return {
    showForm: false,
    editingJob: null,
    toggleAddForm: mockToggleAddForm,
    closeAddForm: jest.fn(),
    openEditForm: jest.fn(),
    closeEditForm: jest.fn(),
  };
}

/**
 * Provide page-local form state for focus-return integration tests.
 *
 * Purpose: exercise Dashboard close/success orchestration while JobForm and
 * mutation duplicate protection remain covered in their focused suites.
 *
 * @returns {object} Stateful useJobFormModal-compatible contract.
 */
function useControlledJobFormState() {
  const [showForm, setShowForm] = React.useState(false);
  const [editingJob, setEditingJob] = React.useState(null);

  return {
    showForm,
    editingJob,
    toggleAddForm: () => setShowForm((current) => !current),
    closeAddForm: () => setShowForm(false),
    openEditForm: (job) => {
      setEditingJob(job);
      setShowForm(false);
    },
    closeEditForm: () => setEditingJob(null),
  };
}

/**
 * Move the mocked viewport across the locked wide breakpoint.
 *
 * @param {boolean} isWide - Whether the media query should match.
 * @returns {void}
 */
function setWideLayout(isWide) {
  act(() => {
    mockWideMediaQuery.matches = isWide;
    for (const listener of mockWideMediaListeners) {
      listener({ matches: isWide });
    }
  });
}

/**
 * Render the authenticated Dashboard with the current hook fixtures.
 *
 * @returns {HTMLElement} Rendered Dashboard container.
 */
function renderDashboard() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(Dashboard));
  });

  return container;
}

/**
 * Verify DashboardShell keeps its scoped visual root and font variable hook.
 *
 * @param {HTMLElement} element - Rendered Dashboard container.
 * @returns {void}
 */
function expectDashboardShell(element) {
  const shell = element.querySelector('.dashboard-root');

  expect(shell).toBeTruthy();
  expect(shell.classList.contains('mock-dashboard-font-variable')).toBe(true);
}

/**
 * Find a rendered button by exact visible text.
 *
 * @param {HTMLElement} element - Root element to search.
 * @param {string} text - Exact button label.
 * @returns {HTMLButtonElement|undefined} Matching button.
 */
function findButtonByText(element, text) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text
  );
}

/**
 * Dispatch a bubbling click through React's delegated event handler.
 *
 * @param {HTMLElement} target - Element to click.
 * @returns {void}
 */
function click(target) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Replace a controlled input value and dispatch React's input event.
 *
 * @param {HTMLInputElement} input - Toolbar search input.
 * @param {string} value - Next visible search draft.
 * @returns {void}
 */
function changeInput(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  ).set;

  act(() => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Dispatch a click and flush asynchronous handler continuations.
 *
 * @param {HTMLElement} target - Element to click.
 * @returns {Promise<void>}
 */
async function clickAsync(target) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/** Remove the active React root and all test-owned DOM nodes. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }

  document.body.innerHTML = '';
  container = null;
  root = null;
}

describe('Dashboard billing entry integration', () => {
  beforeAll(() => {
    Dashboard = require('../../pages/index.js').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWideMediaQuery.matches = false;
    mockWideMediaListeners.clear();
    mockWideMediaQuery.addEventListener.mockImplementation(addMockWideMediaListener);
    mockWideMediaQuery.removeEventListener.mockImplementation(removeMockWideMediaListener);
    mockLatestUpgradeModalProps = null;
    mockLatestSidebarProps = null;
    mockLatestActivityProps = null;
    mockLatestProfileProps = null;
    mockLatestJobTableProps = null;
    mockLatestEditModalProps = null;
    mockLatestDeleteModalProps = null;
    mockLatestJobFormProps = null;
    mockSignOut.mockResolvedValue({ error: null });
    mockUseAuth.mockReturnValue({
      user: { id: 'user-123', email: 'member@example.com' },
      loading: false,
      signOut: mockSignOut,
    });
    mockUseJobs.mockReturnValue(buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    }));
    mockUseJobFormModal.mockReturnValue(buildJobFormState());
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('keeps the dashboard shell and font variable while authentication loads', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: true,
      signOut: mockSignOut,
    });

    const element = renderDashboard();

    expectDashboardShell(element);
    expect(
      element.querySelector('.dashboard-root [data-testid=dashboard-skeleton-marker]')
    ).toBeTruthy();
    expect(element.querySelectorAll('.dashboard-root')).toHaveLength(1);
  });

  it('renders Dismiss as a non-submitting button and clears the current error', () => {
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    jobsState.error = { message: 'Unable to load applications.' };
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();
    const dismissButton = findButtonByText(element, 'Dismiss');
    const alert = element.querySelector('[role=alert]');

    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('Unable to load applications.');
    expect(alert.className).toContain('border-red-400');
    expect(alert.contains(dismissButton)).toBe(true);
    expect(dismissButton.getAttribute('type')).toBe('button');

    click(dismissButton);

    expect(jobsState.clearError).toHaveBeenCalledTimes(1);
  });

  it('announces the visible applications loading state', () => {
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    jobsState.loading = true;
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();
    const loadingStatus = Array.from(element.querySelectorAll('[role=status]')).find(
      (status) => status.textContent.includes('Loading applications...')
    );

    expect(loadingStatus).toBeTruthy();
    expect(loadingStatus.getAttribute('aria-live')).toBe('polite');
    expect(element.querySelector('#job-search').disabled).toBe(true);
    expect(element.textContent).not.toContain('No job applications yet.');
  });

  it('treats each salary bound as an active filter in the empty state', () => {
    const element = renderDashboard();

    expect(element.textContent).toContain('No job applications yet.');
    expect(element.textContent).not.toContain('No matching applications');

    act(() => mockLatestSidebarProps.onSalaryFilterMinChange(60000));

    expect(element.textContent).toContain('No jobs in the selected salary range.');
    expect(element.textContent).not.toContain('No job applications yet.');

    act(() => {
      mockLatestSidebarProps.onSalaryFilterMinChange(null);
      mockLatestSidebarProps.onSalaryFilterMaxChange(120000);
    });

    expect(element.textContent).toContain('No jobs in the selected salary range.');
    expect(element.textContent).not.toContain('No job applications yet.');

    act(() => mockLatestSidebarProps.onSalaryFilterMinChange(60000));
    expect(element.textContent).toContain('No jobs in the selected salary range.');
    expect(mockLatestSidebarProps.salaryFilterMin).toBe(60000);
    expect(mockLatestSidebarProps.salaryFilterMax).toBe(120000);
  });

  it('describes every combined filter and uses the canonical status label', () => {
    jest.useFakeTimers();
    const element = renderDashboard();
    const searchInput = element.querySelector('#job-search');

    act(() => {
      mockLatestSidebarProps.onFilterChange('interviewing');
      mockLatestSidebarProps.onSalaryFilterMinChange(60000);
      mockLatestSidebarProps.onSalaryFilterMaxChange(120000);
      mockLatestActivityProps.onDateToggle('2026-08-01');
    });
    changeInput(searchInput, 'Acme');
    act(() => jest.advanceTimersByTime(300));

    expect(element.textContent).toContain('No matching applications');
    expect(element.textContent).toContain('No jobs matching');
    expect(element.textContent).toContain('Acme');
    expect(element.textContent).toContain('No jobs with status');
    expect(element.textContent).toContain('Interviewing');
    expect(element.textContent).not.toContain('status “interviewing”');
    expect(element.textContent).toContain('No jobs found for the selected dates.');
    expect(element.textContent).toContain('No jobs in the selected salary range.');
    expect(element.textContent).not.toContain('No job applications yet.');
  });

  it('ignores duplicate delete confirmations and releases the latch after settlement', async () => {
    let resolveFirstDelete;
    const firstDelete = new Promise((resolve) => {
      resolveFirstDelete = resolve;
    });
    const job = { id: 'job-123' };
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    jobsState.jobs = [job];
    jobsState.allJobs = [job];
    jobsState.deleteJob = jest.fn()
      .mockReturnValueOnce(firstDelete)
      .mockResolvedValueOnce({ success: true });
    mockUseJobs.mockReturnValue(jobsState);
    renderDashboard();

    act(() => mockLatestJobTableProps.onDelete(job.id));
    expect(mockLatestDeleteModalProps.job).toBe(job);

    let firstConfirmation;
    act(() => {
      firstConfirmation = mockLatestDeleteModalProps.onConfirm();
      mockLatestDeleteModalProps.onConfirm();
    });

    expect(jobsState.deleteJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstDelete({ success: false });
      await firstConfirmation;
    });

    expect(mockLatestDeleteModalProps.job).toBe(job);

    await act(async () => {
      await mockLatestDeleteModalProps.onConfirm();
    });

    expect(jobsState.deleteJob).toHaveBeenCalledTimes(2);
    expect(mockLatestDeleteModalProps.job).toBeNull();
  });

  it('opens the configured Premium modal only for terminal Free without navigating', () => {
    const element = renderDashboard();
    const upgradeButton = findButtonByText(element, 'Upgrade');

    expectDashboardShell(element);
    expect(upgradeButton).toBeTruthy();
    expect(upgradeButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(upgradeButton.getAttribute('aria-expanded')).toBe('false');
    expect(element.textContent).not.toContain('Resume');
    expect(mockLatestUpgradeModalProps).toMatchObject({ isOpen: false });
    expect(mockLatestUpgradeModalProps.plan).toBe(
      PLAN_CATALOG[BILLING_PLANS.PREMIUM_MONTHLY]
    );

    click(upgradeButton);

    expect(element.querySelector('[data-testid="upgrade-modal"]')).toBeTruthy();
    expect(mockLatestUpgradeModalProps.isOpen).toBe(true);
    expect(upgradeButton.getAttribute('aria-expanded')).toBe('true');
    expect(mockRouter.push).not.toHaveBeenCalled();

    click(findButtonByText(element, 'Modal close'));
    expect(element.querySelector('[data-testid="upgrade-modal"]')).toBeNull();
  });

  it('shows a non-interactive skeleton until the initial Free summary resolves without flashing Billing', () => {
    let jobsState = buildJobsState(null);
    jobsState.loading = true;
    mockUseJobs.mockImplementation(() => jobsState);
    const element = renderDashboard();

    const skeleton = element.querySelector('[data-testid="billing-entry-skeleton"]');
    expect(skeleton).toBeTruthy();
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.getAttribute('aria-label')).toBe('Loading plan options');
    expect(findButtonByText(element, 'Billing')).toBeUndefined();
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();

    jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    act(() => root.render(React.createElement(Dashboard)));

    expect(element.querySelector('[data-testid="billing-entry-skeleton"]')).toBeNull();
    expect(findButtonByText(element, 'Upgrade')).toBeTruthy();
    expect(findButtonByText(element, 'Billing')).toBeUndefined();
  });

  it('does not optimistically show Upgrade while the initial Premium summary resolves', () => {
    let jobsState = buildJobsState(null);
    jobsState.loading = true;
    mockUseJobs.mockImplementation(() => jobsState);
    const element = renderDashboard();

    expect(element.querySelector('[data-testid="billing-entry-skeleton"]')).toBeTruthy();
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    expect(findButtonByText(element, 'Billing')).toBeUndefined();

    jobsState = buildJobsState({
      status: STORAGE_STATUSES.PREMIUM_ACTIVE,
      lockedCount: 0,
    });
    act(() => root.render(React.createElement(Dashboard)));

    expect(element.querySelector('[data-testid="billing-entry-skeleton"]')).toBeNull();
    expect(findButtonByText(element, 'Manage plan')).toBeTruthy();
    expect(findButtonByText(element, 'Upgrade')).toBeUndefined();
    expect(findButtonByText(element, 'Billing')).toBeUndefined();
  });

  it('keeps a resolved entry point visible during later job refetches', () => {
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    jobsState.loading = true;
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();

    expect(element.querySelector('[data-testid="billing-entry-skeleton"]')).toBeNull();
    expect(findButtonByText(element, 'Upgrade')).toBeTruthy();
    expect(findButtonByText(element, 'Billing')).toBeUndefined();
  });

  it.each([
    [STORAGE_STATUSES.PREMIUM_ACTIVE, 'Manage plan'],
    [STORAGE_STATUSES.PREMIUM_CANCELING, 'Manage plan'],
    [STORAGE_STATUSES.PAYMENT_RECOVERY, 'Manage plan'],
  ])('routes subscription state %s through %s without opening the modal', (status, label) => {
    mockUseJobs.mockReturnValue(buildJobsState({ status, lockedCount: 0 }));
    const element = renderDashboard();

    click(findButtonByText(element, label));

    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith('/billing');
    expect(mockLatestUpgradeModalProps.isOpen).toBe(false);
    expect(element.querySelector('[data-testid="upgrade-modal"]')).toBeNull();
  });

  it.each([
    ['reconciliation pending', { status: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING }],
    ['sync pending', { status: STORAGE_STATUSES.SYNC_PENDING }],
    ['non-terminal', { status: STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL }],
    ['billing unavailable', { status: STORAGE_STATUSES.BILLING_UNAVAILABLE }],
    ['missing summary', null],
    ['missing status', { lockedCount: 0 }],
    ['unknown status', { status: 'future_billing_state' }],
  ])('fails closed to Billing for %s', (_label, storageSummary) => {
    mockUseJobs.mockReturnValue(buildJobsState(storageSummary));
    const element = renderDashboard();

    click(findButtonByText(element, 'Billing'));

    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith('/billing');
    expect(mockLatestUpgradeModalProps.isOpen).toBe(false);
  });

  it('closes the Free modal before routing its Billing fallback', () => {
    const element = renderDashboard();

    click(findButtonByText(element, 'Upgrade'));
    click(findButtonByText(element, 'Modal billing'));

    expect(mockRouter.push).toHaveBeenCalledWith('/billing');
    expect(mockLatestUpgradeModalProps.isOpen).toBe(false);
    expect(element.querySelector('[data-testid="upgrade-modal"]')).toBeNull();
  });

  it('signs out and replaces login history for modal auth recovery', async () => {
    const element = renderDashboard();

    click(findButtonByText(element, 'Upgrade'));
    await clickAsync(findButtonByText(element, 'Modal unauthorized'));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
    expect(mockRouter.push).not.toHaveBeenCalledWith('/login');
    expect(mockLatestUpgradeModalProps.isOpen).toBe(false);
  });

  it('keeps toolbar, Filters, Activity, account, tooltip, and Add Application wired', () => {
    const element = renderDashboard();
    const filtersButton = findButtonByText(element, 'Filters');
    const activityButton = findButtonByText(element, 'Activity');

    expect(element.querySelector('[data-testid="info-tooltip"]')).toBeTruthy();
    expect(element.querySelector('[data-testid="account-control"]').textContent)
      .toBe('member@example.com');
    expect(mockLatestProfileProps.user.email).toBe('member@example.com');
    expect(element.querySelector('#applications-heading').textContent).toBe('Applications');
    expect(element.textContent).toContain('Track and manage your job applications.');
    expect(element.querySelector('#job-search').getAttribute('placeholder'))
      .toBe('Search companies...');
    expect(filtersButton.getAttribute('aria-expanded')).toBe('false');
    expect(filtersButton.getAttribute('aria-controls')).toBe('dashboard-filters-panel');
    expect(activityButton.getAttribute('aria-expanded')).toBe('false');
    expect(activityButton.getAttribute('aria-controls')).toBe('dashboard-activity-drawer');

    click(filtersButton);
    expect(mockLatestSidebarProps.isOpen).toBe(true);
    expect(mockLatestSidebarProps.mode).toBe('drawer');
    expect(filtersButton.getAttribute('aria-expanded')).toBe('true');
    expect(element.querySelector('[data-testid="filters-overlay"]')).toBeTruthy();

    act(() => mockLatestSidebarProps.onClose());
    expect(filtersButton.getAttribute('aria-expanded')).toBe('false');
    click(activityButton);
    expect(mockLatestActivityProps.isOpen).toBe(true);
    expect(activityButton.getAttribute('aria-expanded')).toBe('true');
    expect(element.querySelector('[data-testid="activity-overlay"]')).toBeTruthy();

    click(findButtonByText(element, 'Add Application'));
    expect(mockToggleAddForm).toHaveBeenCalledTimes(1);
  });

  it('returns focus to Add Application after form cancellation', () => {
    mockUseJobFormModal.mockImplementation(useControlledJobFormState);
    const element = renderDashboard();
    const addTrigger = findButtonByText(element, 'Add Application');
    addTrigger.focus();

    click(addTrigger);
    expect(element.querySelector('[data-testid=job-form]')).toBeTruthy();
    const cancelButton = findButtonByText(element, 'Cancel form');
    cancelButton.focus();
    click(cancelButton);

    expect(element.querySelector('[data-testid=job-form]')).toBeNull();
    expect(addTrigger.textContent).toContain('Add Application');
    expect(document.activeElement).toBe(addTrigger);
  });

  it('waits for saving to finish before returning focus after form cancellation', () => {
    mockUseJobFormModal.mockImplementation(useControlledJobFormState);
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();
    const addTrigger = findButtonByText(element, 'Add Application');

    click(addTrigger);
    const cancelButton = findButtonByText(element, 'Cancel form');
    cancelButton.focus();
    jobsState.saving = true;
    act(() => root.render(React.createElement(Dashboard)));
    expect(addTrigger.disabled).toBe(true);

    click(cancelButton);

    expect(element.querySelector('[data-testid=job-form]')).toBeNull();
    expect(document.activeElement).not.toBe(addTrigger);

    jobsState.saving = false;
    act(() => root.render(React.createElement(Dashboard)));

    expect(addTrigger.disabled).toBe(false);
    expect(document.activeElement).toBe(addTrigger);
  });

  it('returns focus to Add Application after a successful guarded add', async () => {
    mockUseJobFormModal.mockImplementation(useControlledJobFormState);
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();
    const addTrigger = findButtonByText(element, 'Add Application');
    addTrigger.focus();

    click(addTrigger);
    const submitButton = findButtonByText(element, 'Submit Add');
    submitButton.focus();
    await clickAsync(submitButton);

    expect(jobsState.addJob).toHaveBeenCalledTimes(1);
    expect(jobsState.addJob).toHaveBeenCalledWith({ company: 'Acme', position: 'Engineer' });
    expect(element.querySelector('[data-testid=job-form]')).toBeNull();
    expect(document.activeElement).toBe(addTrigger);
    expect(mockLatestJobFormProps.saving).toBe(false);
  });

  it('keeps focus in Edit when an active save settles after Add cancellation', () => {
    mockUseJobFormModal.mockImplementation(useControlledJobFormState);
    const job = { id: 'job-123', company: 'Acme', position: 'Engineer' };
    const jobsState = buildJobsState({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
    });
    jobsState.jobs = [job];
    jobsState.allJobs = [job];
    mockUseJobs.mockReturnValue(jobsState);
    const element = renderDashboard();
    const addTrigger = findButtonByText(element, 'Add Application');

    click(addTrigger);
    const cancelButton = findButtonByText(element, 'Cancel form');
    cancelButton.focus();
    jobsState.saving = true;
    act(() => root.render(React.createElement(Dashboard)));
    click(cancelButton);

    act(() => mockLatestJobTableProps.onEdit(job));

    expect(element.querySelector('[data-testid=job-form]')).toBeNull();
    expect(mockLatestEditModalProps.job).toBe(job);
    const editInput = element.querySelector('[aria-label="Edit company"]');
    editInput.focus();

    jobsState.saving = false;
    act(() => root.render(React.createElement(Dashboard)));

    expect(mockLatestEditModalProps.job).toBe(job);
    expect(document.activeElement).toBe(editInput);
  });

  it('debounces and sanitizes company search while Clear All cancels a pending draft', () => {
    jest.useFakeTimers();
    const element = renderDashboard();
    const searchInput = element.querySelector('#job-search');

    changeInput(searchInput, '<strong>Acme</strong>');
    const clearSearchButton = element.querySelector('[aria-label="Clear company search"]');

    expect(searchInput.classList.contains('pr-12')).toBe(true);
    expect(clearSearchButton.classList.contains('min-h-9')).toBe(true);
    expect(clearSearchButton.classList.contains('min-w-9')).toBe(true);
    act(() => jest.advanceTimersByTime(299));
    expect(mockUseJobs.mock.calls.at(-1)[2]).toBe('');

    act(() => jest.advanceTimersByTime(1));
    expect(mockUseJobs.mock.calls.at(-1)[2]).toBe('Acme');
    expect(mockLatestSidebarProps.hasSearchFilter).toBe(true);
    expect(searchInput.value).toBe('<strong>Acme</strong>');

    changeInput(searchInput, 'Stale company');
    act(() => mockLatestSidebarProps.onClearAllFilters());
    expect(searchInput.value).toBe('');

    act(() => jest.advanceTimersByTime(300));
    expect(mockUseJobs.mock.calls.at(-1)[2]).toBe('');
    expect(mockLatestSidebarProps.hasSearchFilter).toBe(false);
  });

  it('keeps the closed Activity container hidden and inert', () => {
    const element = renderDashboard();
    const wrapper = element.querySelector('#dashboard-activity-drawer');

    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.hasAttribute('inert')).toBe(true);

    click(findButtonByText(element, 'Activity'));

    expect(wrapper.hasAttribute('aria-hidden')).toBe(false);
    expect(wrapper.hasAttribute('inert')).toBe(false);
  });

  it('uses the Tailwind wide breakpoint for responsive disclosure behavior', () => {
    renderDashboard();

    expect(window.matchMedia).toHaveBeenCalledWith(
      `(min-width: ${tailwindConfig.theme.extend.screens.wide})`
    );
  });

  it('starts wide Filters expanded, releases the track, and preserves every criterion', () => {
    jest.useFakeTimers();
    setWideLayout(true);
    const element = renderDashboard();
    const filtersButton = findButtonByText(element, 'Filters');
    const shellContent = element.querySelector('[data-filters-expanded]');
    const searchInput = element.querySelector('#job-search');

    expect(mockLatestSidebarProps).toMatchObject({ mode: 'docked', isOpen: true });
    expect(filtersButton.getAttribute('aria-expanded')).toBe('true');
    expect(shellContent.getAttribute('data-filters-expanded')).toBe('true');

    act(() => {
      mockLatestSidebarProps.onFilterChange('interviewing');
      mockLatestSidebarProps.onSalaryFilterMinChange(60000);
      mockLatestSidebarProps.onSalaryFilterMaxChange(120000);
      mockLatestActivityProps.onDateToggle('2026-07-30');
    });
    changeInput(searchInput, 'Acme');
    act(() => jest.advanceTimersByTime(300));

    expect(mockLatestSidebarProps).toMatchObject({
      activeFilter: 'interviewing',
      hasSearchFilter: true,
      salaryFilterMin: 60000,
      salaryFilterMax: 120000,
    });
    expect(mockLatestActivityProps.selectedDates.has('2026-07-30')).toBe(true);

    const activityButton = findButtonByText(element, 'Activity');
    activityButton.focus();
    expect(document.activeElement).toBe(activityButton);
    act(() => mockLatestSidebarProps.onClose());

    expect(document.activeElement).toBe(filtersButton);
    expect(mockLatestSidebarProps.isOpen).toBe(false);
    expect(filtersButton.getAttribute('aria-expanded')).toBe('false');
    expect(shellContent.getAttribute('data-filters-expanded')).toBe('false');

    click(filtersButton);

    expect(mockLatestSidebarProps).toMatchObject({
      mode: 'docked',
      isOpen: true,
      activeFilter: 'interviewing',
      hasSearchFilter: true,
      salaryFilterMin: 60000,
      salaryFilterMax: 120000,
    });
    expect(searchInput.value).toBe('Acme');
    expect(mockLatestActivityProps.selectedDates.has('2026-07-30')).toBe(true);
  });

  it('cleans up an open compact drawer when resizing across the wide breakpoint', () => {
    const element = renderDashboard();
    const filtersButton = findButtonByText(element, 'Filters');

    click(filtersButton);
    expect(mockLatestSidebarProps).toMatchObject({ mode: 'drawer', isOpen: true });

    setWideLayout(true);
    expect(mockLatestSidebarProps).toMatchObject({ mode: 'docked', isOpen: true });

    setWideLayout(false);
    expect(mockLatestSidebarProps).toMatchObject({ mode: 'drawer', isOpen: false });
    expect(filtersButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders only the approved TrackTheApp navigation copy', () => {
    const element = renderDashboard();

    expect(element.textContent).toContain('TrackTheApp');
    expect(element.textContent).toContain('Applications');
    expect(element.textContent).not.toContain('Track The App');
    expect(element.textContent).not.toContain('TrackerPro');
    expect(element.textContent).not.toContain('Overview');
    expect(element.textContent).not.toContain('Insights');
    expect(element.textContent).not.toContain('Settings');
  });

  it('does not open Upgrade over an active focus-owning Dashboard overlay', () => {
    const element = renderDashboard();

    click(findButtonByText(element, 'Activity'));
    click(findButtonByText(element, 'Upgrade'));

    expect(mockLatestActivityProps.isOpen).toBe(true);
    expect(mockLatestUpgradeModalProps.isOpen).toBe(false);

    act(() => mockLatestActivityProps.onClose());
    click(findButtonByText(element, 'Upgrade'));

    expect(mockLatestUpgradeModalProps.isOpen).toBe(true);
  });
});
