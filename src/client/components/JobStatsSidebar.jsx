import { useState, useRef, useEffect } from 'react';
import { STATUS_OPTIONS, STATUS_COLORS, STATUS_DOT_COLORS } from './forms/constants';
import StatusPieChart from './StatusPieChart';

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
}) {
  const [localSearch, setLocalSearch] = useState(searchQuery || '');
  const debounceTimerRef = useRef(null);

  // Sync local input if parent resets searchQuery (e.g. a future "clear all" action)
  useEffect(() => {
    setLocalSearch(searchQuery || '');
  }, [searchQuery]);

  // Cleanup debounce timer on unmount to prevent state updates on unmounted component
  useEffect(() => () => clearTimeout(debounceTimerRef.current), []);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    setLocalSearch(value);
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => onSearchChange(value), 300);
  };

  const handleClearSearch = () => {
    setLocalSearch('');
    clearTimeout(debounceTimerRef.current);
    onSearchChange('');
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
        className={`fixed inset-y-0 left-0 z-40 w-72 bg-white shadow-xl flex flex-col overflow-y-auto
          transition-transform duration-200
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
        aria-label="Filters sidebar"
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

        {activeFilter && (
          <div className="px-4 pb-3">
            <button
              onClick={() => onFilterChange(null)}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
            >
              Clear Filter
            </button>
          </div>
        )}
      </div>
    </>
  );
}
