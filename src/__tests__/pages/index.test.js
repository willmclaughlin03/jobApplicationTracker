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
  /** Keep ProfileDropdown behavior isolated to its focused component suite. */
  return function MockProfileDropdown() {
    return null;
  };
});

jest.mock('../../client/components/JobTable', () => {
  /** Omit job rows from billing-entry integration tests. */
  return function MockJobTable() {
    return null;
  };
});

jest.mock('../../client/components/JobForm', () => {
  /** Omit the add form while retaining its parent toggle callback. */
  return function MockJobForm() {
    return null;
  };
});

jest.mock('../../client/components/EditModal', () => {
  /** Omit edit-modal rendering from focused Dashboard tests. */
  return function MockEditModal() {
    return null;
  };
});

jest.mock('../../client/components/DeleteModal', () => {
  /** Omit delete-modal rendering from focused Dashboard tests. */
  return function MockDeleteModal() {
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
  /** Omit the auth-loading shell from authenticated Dashboard tests. */
  return function MockDashboardSkeleton() {
    return null;
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
    mockLatestUpgradeModalProps = null;
    mockLatestSidebarProps = null;
    mockLatestActivityProps = null;
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

  afterEach(cleanup);

  it('keeps the dashboard shell and font variable while authentication loads', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: true,
      signOut: mockSignOut,
    });

    const element = renderDashboard();

    expectDashboardShell(element);
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

  it('keeps Filters, Activity, tooltip, and Add Job controls wired', () => {
    const element = renderDashboard();

    expect(element.querySelector('[data-testid="info-tooltip"]')).toBeTruthy();

    click(findButtonByText(element, 'Filters'));
    expect(mockLatestSidebarProps.isOpen).toBe(true);
    expect(element.querySelector('[data-testid="filters-overlay"]')).toBeTruthy();

    act(() => mockLatestSidebarProps.onClose());
    click(findButtonByText(element, 'Activity'));
    expect(mockLatestActivityProps.isOpen).toBe(true);
    expect(element.querySelector('[data-testid="activity-overlay"]')).toBeTruthy();

    click(findButtonByText(element, 'Add New Job'));
    expect(mockToggleAddForm).toHaveBeenCalledTimes(1);
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
