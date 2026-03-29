import { useState, useRef, useEffect, useMemo } from 'react';
import { STATUS_OPTIONS, STATUS_COLORS, STATUS_DOT_COLORS } from './forms/constants';
import StatusPieChart from './StatusPieChart';
import { formatSalary, formatSalarySingle } from '../lib/formatSalary.js';
import DOMPurify from 'isomorphic-dompurify';
import { SALARY_MAX_VALUE } from '../../shared/validations/jobSchema.js';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility';

/**
 * Sidebar drawer showing job statistics, status filter buttons, and a company search input.
 *
 * Purpose: Allows users to filter the job list by status and/or search by company name.
 * Renders as a fixed overlay drawer that slides in from the left.
 * Connects to:
 * - Dashboard (index.js) — receives isOpen/onClose and filter state + setters
 * - useJobs — filters are applied client-side via filterJobs, zero extra API calls
 *
 * @param {boolean} isOpen - Whether the drawer is visible
 * @param {Function} onClose - Callback to close the drawer
 * @param {Object} statusCounts - Count of jobs per status key
 * @param {number} total - Total unfiltered job count
 * @param {boolean} loading - Whether jobs are being fetched
 * @param {string|null} activeFilter - Currently active status filter
 * @param {Function} onFilterChange - Callback to update status filter
 * @param {string} searchQuery - Current company name search query (controlled by parent)
 * @param {Function} onSearchChange - Callback to update search query in parent
 */
export default function JobStatsSidebar({
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
}) {
  const { containerRef } = useOverlayAccessibility(isOpen, onClose);
  const [localSearch, setLocalSearch] = useState(searchQuery || '');
  const [localSalaryMin, setLocalSalaryMin] = useState('');
  const [localSalaryMax, setLocalSalaryMax] = useState('');
  const debounceTimerRef = useRef(null);
  const salaryMinTimerRef = useRef(null);
  const salaryMaxTimerRef = useRef(null);

  const salaryStats = useMemo(() => {
    const withSalary = jobs.filter(j => j.salary_min != null || j.salary_max != null);
    if (withSalary.length === 0) return null;
    const mins = withSalary.map(j => j.salary_min).filter(v => v != null);
    const maxes = withSalary.map(j => j.salary_max).filter(v => v != null);
    const overallMin = mins.length ? Math.min(...mins) : null;
    const overallMax = maxes.length ? Math.max(...maxes) : null;
    const midpoints = withSalary
      .filter(j => j.salary_min != null && j.salary_max != null)
      .map(j => (j.salary_min + j.salary_max) / 2);
    const avgMidpoint = midpoints.length
      ? Math.round(midpoints.reduce((a, b) => a + b, 0) / midpoints.length)
      : null;
    return { overallMin, overallMax, avgMidpoint, count: withSalary.length, total: jobs.length };
  }, [jobs]);

  const latestStatusDate = useMemo(() => {
    const withDate = jobs.filter(j => j.status_date != null);
    if (withDate.length === 0) return null;
    return withDate.reduce((latest, j) =>
      new Date(j.status_date) > new Date(latest.status_date) ? j : latest
    );
  }, [jobs]);

  // Sync local inputs if parent resets values (e.g. "clear all" action)
  useEffect(() => {
    setLocalSearch(searchQuery || '');
  }, [searchQuery]);
  useEffect(() => {
    setLocalSalaryMin(salaryFilterMin != null ? String(salaryFilterMin) : '');
  }, [salaryFilterMin]);
  useEffect(() => {
    setLocalSalaryMax(salaryFilterMax != null ? String(salaryFilterMax) : '');
  }, [salaryFilterMax]);

  // Cleanup debounce timers on unmount to prevent state updates on unmounted component
  useEffect(() => () => {
    clearTimeout(debounceTimerRef.current);
    clearTimeout(salaryMinTimerRef.current);
    clearTimeout(salaryMaxTimerRef.current);
  }, []);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    setLocalSearch(value);
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => onSearchChange(DOMPurify.sanitize(value, { ALLOWED_TAGS: [] })), 300);
  };

  const handleClearSearch = () => {
    setLocalSearch('');
    clearTimeout(debounceTimerRef.current);
    onSearchChange('');
  };

  const handleSalaryMinChange = (e) => {
    const value = e.target.value;
    setLocalSalaryMin(value);
    clearTimeout(salaryMinTimerRef.current);
    salaryMinTimerRef.current = setTimeout(() => {
      if (value === '') return onSalaryFilterMinChange(null);
      const clamped = Math.max(0, Math.min(Math.round(Number(value)), SALARY_MAX_VALUE));
      onSalaryFilterMinChange(clamped);
    }, 300);
  };

  const handleSalaryMaxChange = (e) => {
    const value = e.target.value;
    setLocalSalaryMax(value);
    clearTimeout(salaryMaxTimerRef.current);
    salaryMaxTimerRef.current = setTimeout(() => {
      if (value === '') return onSalaryFilterMaxChange(null);
      const clamped = Math.max(0, Math.min(Math.round(Number(value)), SALARY_MAX_VALUE));
      onSalaryFilterMaxChange(clamped);
    }, 300);
  };

  const handleStatusClick = (status) => {
    if (activeFilter === status) {
      onFilterChange(null);
    } else {
      onFilterChange(status);
    }
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filters sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-72 bg-white shadow-xl flex flex-col overflow-y-auto
          transition-transform duration-200
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-800">Job Statistics</h2>
          <button
            onClick={onClose}
            aria-label="Close sidebar"
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Total count */}
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Total Applications</span>
            <span className="text-lg font-bold text-gray-900">
              {loading ? '-' : total}
            </span>
          </div>
        </div>

        {/* Pie chart */}
        <div className="px-4 py-3 border-b border-gray-100">
          <StatusPieChart
            statusCounts={statusCounts}
            total={total}
            loading={loading}
          />
        </div>

        {/* Status filters */}
        <div className="p-2">
          {STATUS_OPTIONS.map(({ value, label }) => {
            const isActive = activeFilter === value;
            const count = statusCounts[value] || 0;

            return (
              <button
                key={value}
                onClick={() => handleStatusClick(value)}
                disabled={loading}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? `${STATUS_COLORS[value]} font-medium`
                    : 'hover:bg-gray-50 text-gray-700'
                } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT_COLORS[value]}`} />
                  <span>{label}</span>
                </div>
                <span className={`font-medium ${isActive ? '' : 'text-gray-500'}`}>
                  {loading ? '-' : count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Salary summary */}
        {!loading && salaryStats && (
          <div className="px-4 py-3 border-t border-gray-100 space-y-1.5">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">Salary Range</h3>
            <p className="text-sm text-gray-800 font-medium">
              {formatSalary(salaryStats.overallMin, salaryStats.overallMax)}
            </p>
            {salaryStats.avgMidpoint != null && (
              <p className="text-xs text-gray-500">
                Avg midpoint: {formatSalarySingle(salaryStats.avgMidpoint)}
              </p>
            )}
            <p className="text-xs text-gray-400">
              {salaryStats.count} of {salaryStats.total} jobs with salary data
            </p>
          </div>
        )}

        {/* Latest status change */}
        {!loading && latestStatusDate && (
          <div className="px-4 py-3 border-t border-gray-100 space-y-1.5">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">Latest Status Change</h3>
            <p className="text-sm text-gray-800">
              <span className="font-medium">{latestStatusDate.company}</span>
              {' \u2192 '}
              <span className="capitalize">{latestStatusDate.status}</span>
            </p>
            <p className="text-xs text-gray-500">
              {new Date(latestStatusDate.status_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        )}

        {/* Salary filter */}
        <div className="px-4 py-3 border-t border-gray-100">
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Filter by Salary</h3>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="salary-filter-min" className="block text-xs text-gray-500 mb-1">Min</label>
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
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md
                           placeholder-gray-400 focus:outline-none focus:ring-2
                           focus:ring-blue-500 focus:border-transparent
                           disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label htmlFor="salary-filter-max" className="block text-xs text-gray-500 mb-1">Max</label>
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
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md
                           placeholder-gray-400 focus:outline-none focus:ring-2
                           focus:ring-blue-500 focus:border-transparent
                           disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>
        </div>

        {/* Company search */}
        <div className="px-4 pb-3 border-t border-gray-100 pt-3">
          <label
            htmlFor="job-search"
            className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide"
          >
            Search by company
          </label>
          <div className="relative">
            <input
              id="job-search"
              type="text"
              value={localSearch}
              onChange={handleSearchChange}
              placeholder="e.g. Apple..."
              disabled={loading}
              maxLength={100}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md
                         placeholder-gray-400 focus:outline-none focus:ring-2
                         focus:ring-blue-500 focus:border-transparent
                         disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {localSearch && (
              <button
                onClick={handleClearSearch}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400
                           hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {(activeFilter || salaryFilterMin != null || salaryFilterMax != null || searchQuery) && (
          <div className="px-4 pb-3">
            <button
              onClick={() => {
                onFilterChange(null);
                onSalaryFilterMinChange(null);
                onSalaryFilterMaxChange(null);
                setLocalSalaryMin('');
                setLocalSalaryMax('');
                clearTimeout(salaryMinTimerRef.current);
                clearTimeout(salaryMaxTimerRef.current);
                onSearchChange('');
                setLocalSearch('');
                clearTimeout(debounceTimerRef.current);
              }}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
            >
              Clear All Filters
            </button>
          </div>
        )}
      </div>
    </>
  );
}
