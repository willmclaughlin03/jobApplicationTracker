import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, Search, X } from 'lucide-react';
import DOMPurify from 'isomorphic-dompurify';
import { STATUS_OPTIONS, STATUS_DOT_COLORS } from './forms/constants';
import StatusPieChart from './StatusPieChart';
import { formatSalary, formatSalarySingle } from '../lib/formatSalary.js';
import { SALARY_MAX_VALUE } from '../../shared/validations/jobSchema.js';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility';

/**
 * Render one responsive Filters panel as either a wide dock or compact drawer.
 *
 * Purpose: Keeps one mounted set of filter inputs and IDs so disclosure changes
 * never duplicate controls or discard local debounced values. Dashboard owns
 * the actual criteria, responsive mode, and open state; this component owns
 * only input presentation, debounce timers, and drawer accessibility.
 *
 * @param {object} props - Filter presentation and controlled criteria.
 * @param {'docked'|'drawer'} props.mode - Active responsive presentation.
 * @param {boolean} props.isOpen - Whether the active presentation is exposed.
 * @param {Function} props.onClose - Closes the active presentation.
 * @param {Object} props.statusCounts - Count of jobs per status key.
 * @param {number} props.total - Total unfiltered job count.
 * @param {boolean} props.loading - Whether jobs are being fetched.
 * @param {string|null} props.activeFilter - Active status filter.
 * @param {Function} props.onFilterChange - Updates the status filter.
 * @param {string} props.searchQuery - Controlled company search query.
 * @param {Function} props.onSearchChange - Updates company search.
 * @param {Array} props.jobs - Unfiltered jobs used by summary statistics.
 * @param {number|null} props.salaryFilterMin - Controlled minimum salary.
 * @param {number|null} props.salaryFilterMax - Controlled maximum salary.
 * @param {Function} props.onSalaryFilterMinChange - Updates minimum salary.
 * @param {Function} props.onSalaryFilterMaxChange - Updates maximum salary.
 * @param {number} props.archivedCount - Locked archive count.
 * @returns {React.ReactElement} One docked or drawer Filters panel.
 */
export default function JobStatsSidebar({
  mode = 'drawer',
  isOpen,
  onClose,
  statusCounts,
  total,
  loading,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  jobs = [],
  salaryFilterMin,
  salaryFilterMax,
  onSalaryFilterMinChange,
  onSalaryFilterMaxChange,
  archivedCount = 0,
}) {
  const isDrawerOpen = mode === 'drawer' && isOpen;
  const { containerRef } = useOverlayAccessibility(isDrawerOpen, onClose);
  const [localSearch, setLocalSearch] = useState(searchQuery || '');
  const [localSalaryMin, setLocalSalaryMin] = useState('');
  const [localSalaryMax, setLocalSalaryMax] = useState('');
  const debounceTimerRef = useRef(null);
  const salaryMinTimerRef = useRef(null);
  const salaryMaxTimerRef = useRef(null);

  const salaryStats = useMemo(() => {
    const withSalary = jobs.filter(job => job.salary_min != null || job.salary_max != null);
    if (withSalary.length === 0) return null;
    const mins = withSalary.map(job => job.salary_min).filter(value => value != null);
    const maxes = withSalary.map(job => job.salary_max).filter(value => value != null);
    const midpoints = withSalary
      .filter(job => job.salary_min != null && job.salary_max != null)
      .map(job => (job.salary_min + job.salary_max) / 2);

    return {
      overallMin: mins.length ? Math.min(...mins) : null,
      overallMax: maxes.length ? Math.max(...maxes) : null,
      avgMidpoint: midpoints.length
        ? Math.round(midpoints.reduce((sum, value) => sum + value, 0) / midpoints.length)
        : null,
      count: withSalary.length,
      total: jobs.length,
    };
  }, [jobs]);

  const latestStatusDate = useMemo(() => {
    const withDate = jobs.filter(job => job.status_date != null);
    if (withDate.length === 0) return null;
    return withDate.reduce((latest, job) => (
      new Date(job.status_date) > new Date(latest.status_date) ? job : latest
    ));
  }, [jobs]);

  /** Mirror controlled company-search resets into the mounted input. */
  useEffect(() => {
    setLocalSearch(searchQuery || '');
  }, [searchQuery]);

  /** Mirror controlled minimum-salary resets into the mounted input. */
  useEffect(() => {
    setLocalSalaryMin(salaryFilterMin != null ? String(salaryFilterMin) : '');
  }, [salaryFilterMin]);

  /** Mirror controlled maximum-salary resets into the mounted input. */
  useEffect(() => {
    setLocalSalaryMax(salaryFilterMax != null ? String(salaryFilterMax) : '');
  }, [salaryFilterMax]);

  /** Cancel pending debounce work if Dashboard removes the Filters panel. */
  useEffect(() => () => {
    clearTimeout(debounceTimerRef.current);
    clearTimeout(salaryMinTimerRef.current);
    clearTimeout(salaryMaxTimerRef.current);
  }, []);

  /**
   * Lock page scrolling only while the compact drawer owns focus.
   * Restores the prior inline overflow value on close, resize, or unmount.
   */
  useEffect(() => {
    if (!isDrawerOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDrawerOpen]);

  /**
   * Debounce and sanitize one company-search edit before updating Dashboard.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} event - Search input event.
   * @returns {void}
   */
  const handleSearchChange = (event) => {
    const value = event.target.value;
    setLocalSearch(value);
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      onSearchChange(DOMPurify.sanitize(value, { ALLOWED_TAGS: [] }));
    }, 300);
  };

  /**
   * Clear the local and controlled company search immediately.
   *
   * @returns {void}
   */
  const handleClearSearch = () => {
    setLocalSearch('');
    clearTimeout(debounceTimerRef.current);
    onSearchChange('');
  };

  /**
   * Debounce and clamp the minimum salary boundary.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} event - Minimum salary input event.
   * @returns {void}
   */
  const handleSalaryMinChange = (event) => {
    const value = event.target.value;
    setLocalSalaryMin(value);
    clearTimeout(salaryMinTimerRef.current);
    salaryMinTimerRef.current = setTimeout(() => {
      if (value === '') {
        onSalaryFilterMinChange(null);
        return;
      }
      onSalaryFilterMinChange(
        Math.max(0, Math.min(Math.round(Number(value)), SALARY_MAX_VALUE))
      );
    }, 300);
  };

  /**
   * Debounce and clamp the maximum salary boundary.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} event - Maximum salary input event.
   * @returns {void}
   */
  const handleSalaryMaxChange = (event) => {
    const value = event.target.value;
    setLocalSalaryMax(value);
    clearTimeout(salaryMaxTimerRef.current);
    salaryMaxTimerRef.current = setTimeout(() => {
      if (value === '') {
        onSalaryFilterMaxChange(null);
        return;
      }
      onSalaryFilterMaxChange(
        Math.max(0, Math.min(Math.round(Number(value)), SALARY_MAX_VALUE))
      );
    }, 300);
  };

  /**
   * Toggle one status while preserving every other criterion.
   *
   * @param {string} status - Canonical status value.
   * @returns {void}
   */
  const handleStatusClick = (status) => {
    onFilterChange(activeFilter === status ? null : status);
  };

  /**
   * Reset every Filters-owned criterion through the existing explicit action.
   *
   * @returns {void}
   */
  const handleClearAllFilters = () => {
    onFilterChange(null);
    onSalaryFilterMinChange(null);
    onSalaryFilterMaxChange(null);
    onSearchChange('');
    setLocalSalaryMin('');
    setLocalSalaryMax('');
    setLocalSearch('');
    clearTimeout(salaryMinTimerRef.current);
    clearTimeout(salaryMaxTimerRef.current);
    clearTimeout(debounceTimerRef.current);
  };

  const panelClasses = mode === 'docked'
    ? [
      'relative flex h-full min-h-screen w-[var(--dash-filters-wide)] flex-col overflow-y-auto',
      isOpen ? 'translate-x-0 opacity-100' : '-translate-x-2 opacity-0 pointer-events-none',
    ].join(' ')
    : [
      'fixed inset-y-0 left-0 z-40 flex w-[min(var(--dash-filters-wide),calc(100vw-2rem))] flex-col overflow-y-auto',
      isOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none',
    ].join(' ');
  const hasFilters = Boolean(
    activeFilter
    || localSearch
    || salaryFilterMin != null
    || salaryFilterMax != null
  );

  return (
    <>
      {isDrawerOpen && (
        <div
          data-testid="filters-backdrop"
          aria-hidden="true"
          className="fixed inset-0 z-30 cursor-default bg-black/60"
          onClick={onClose}
        />
      )}

      <aside
        ref={containerRef}
        id="dashboard-filters-panel"
        role={isDrawerOpen ? 'dialog' : 'region'}
        aria-modal={isDrawerOpen ? 'true' : undefined}
        aria-labelledby="dashboard-filters-title"
        aria-hidden={isOpen ? undefined : 'true'}
        inert={isOpen ? undefined : ''}
        className={[
          'dashboard-major-panel dashboard-motion bg-dashboard-surface/95 text-dashboard-text transition-[transform,opacity]',
          panelClasses,
        ].join(' ')}
      >
        <div className="flex items-center justify-between border-b border-dashboard-line px-4 py-3">
          <div>
            <h2 id="dashboard-filters-title" className="text-sm font-semibold text-dashboard-text">
              Filters
            </h2>
            <p className="text-dashboard-caption text-dashboard-muted">Application statistics</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={mode === 'docked' ? 'Collapse Filters' : 'Close Filters'}
            className="dashboard-control dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center text-dashboard-muted transition-colors hover:text-dashboard-text"
          >
            {mode === 'docked' ? (
              <PanelLeftClose aria-hidden="true" size={18} />
            ) : (
              <X aria-hidden="true" size={18} />
            )}
          </button>
        </div>

        <div className="border-b border-dashboard-line px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-dashboard-muted">Active Applications</span>
            <span className="text-lg font-bold text-dashboard-text">
              {loading ? '-' : total}
            </span>
          </div>
          {archivedCount > 0 && (
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-dashboard-muted">Archived</span>
              <span className="font-medium text-dashboard-text">{archivedCount}</span>
            </div>
          )}
        </div>

        <div className="border-b border-dashboard-line px-4 py-3 [&_text]:fill-dashboard-text">
          <StatusPieChart statusCounts={statusCounts} total={total} loading={loading} />
        </div>

        <div className="space-y-1 p-2">
          {STATUS_OPTIONS.map(({ value, label }) => {
            const isActive = activeFilter === value;
            const count = statusCounts[value] || 0;

            return (
              <button
                key={value}
                type="button"
                onClick={() => handleStatusClick(value)}
                disabled={loading}
                aria-pressed={isActive}
                className={[
                  'dashboard-focus-ring flex min-h-9 w-full items-center justify-between rounded-dashboard-control border px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'border-dashboard-accent/60 bg-dashboard-active font-medium text-dashboard-text'
                    : 'border-transparent text-dashboard-muted hover:border-dashboard-control-border hover:bg-dashboard-surface-hover hover:text-dashboard-text',
                  loading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                ].join(' ')}
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT_COLORS[value]}`} />
                  <span>{label}</span>
                </span>
                <span className="font-medium">{loading ? '-' : count}</span>
              </button>
            );
          })}
        </div>

        {!loading && salaryStats && (
          <div className="space-y-1.5 border-t border-dashboard-line px-4 py-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-dashboard-muted">
              Salary Range
            </h3>
            <p className="text-sm font-medium text-dashboard-text">
              {formatSalary(salaryStats.overallMin, salaryStats.overallMax)}
            </p>
            {salaryStats.avgMidpoint != null && (
              <p className="text-xs text-dashboard-muted">
                Avg midpoint: {formatSalarySingle(salaryStats.avgMidpoint)}
              </p>
            )}
            <p className="text-xs text-dashboard-muted/80">
              {salaryStats.count} of {salaryStats.total} jobs with salary data
            </p>
          </div>
        )}

        {!loading && latestStatusDate && (
          <div className="space-y-1.5 border-t border-dashboard-line px-4 py-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-dashboard-muted">
              Latest Status Change
            </h3>
            <p className="text-sm text-dashboard-text">
              <span className="font-medium">{latestStatusDate.company}</span>
              {' → '}
              <span className="capitalize">{latestStatusDate.status}</span>
            </p>
            <p className="text-xs text-dashboard-muted">
              {new Date(latestStatusDate.status_date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>
        )}

        <div className="border-t border-dashboard-line px-4 py-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dashboard-muted">
            Filter by Salary
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="salary-filter-min" className="mb-1 block text-xs text-dashboard-muted">
                Min
              </label>
              <input
                id="salary-filter-min"
                type="number"
                value={localSalaryMin}
                onChange={handleSalaryMinChange}
                placeholder="e.g. 60000"
                min="0"
                max={SALARY_MAX_VALUE}
                step="1000"
                disabled={loading}
                className="dashboard-control dashboard-focus-ring min-h-9 w-full px-2 py-1.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div>
              <label htmlFor="salary-filter-max" className="mb-1 block text-xs text-dashboard-muted">
                Max
              </label>
              <input
                id="salary-filter-max"
                type="number"
                value={localSalaryMax}
                onChange={handleSalaryMaxChange}
                placeholder="e.g. 120000"
                min="0"
                max={SALARY_MAX_VALUE}
                step="1000"
                disabled={loading}
                className="dashboard-control dashboard-focus-ring min-h-9 w-full px-2 py-1.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        <div className="border-t border-dashboard-line px-4 py-3">
          <label
            htmlFor="job-search"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-dashboard-muted"
          >
            Search by company
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dashboard-muted"
            />
            <input
              id="job-search"
              type="text"
              value={localSearch}
              onChange={handleSearchChange}
              placeholder="Search companies..."
              disabled={loading}
              maxLength={100}
              className="dashboard-control dashboard-focus-ring min-h-9 w-full py-2 pl-9 pr-9 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {localSearch && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear search"
                className="dashboard-focus-ring absolute right-1 top-1/2 inline-flex min-h-7 min-w-7 -translate-y-1/2 items-center justify-center rounded text-dashboard-muted hover:text-dashboard-text"
              >
                <X aria-hidden="true" size={15} />
              </button>
            )}
          </div>
        </div>

        {hasFilters && (
          <div className="mt-auto border-t border-dashboard-line px-4 py-3">
            <button
              type="button"
              onClick={handleClearAllFilters}
              className="dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2 text-sm font-medium text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text"
            >
              Clear All Filters
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
