import { useState } from 'react';
import { STATUS_OPTIONS, STATUS_COLORS } from './forms/constants';

const STATUS_DOT_COLORS = {
  applied: 'bg-blue-500',
  interviewing: 'bg-orange-500',
  offered: 'bg-green-500',
  rejected: 'bg-red-500',
  accepted: 'bg-green-700',
};

export default function JobStatsSidebar({
  statusCounts,
  total,
  loading,
  activeFilter,
  onFilterChange,
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);

  const handleStatusClick = (status) => {
    if (activeFilter === status) {
      onFilterChange(null);
    } else {
      onFilterChange(status);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full px-4 py-3 flex items-center justify-between md:cursor-default"
      >
        <h2 className="text-sm font-semibold text-gray-800">Job Statistics</h2>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform md:hidden ${
            isCollapsed ? '' : 'rotate-180'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div className={`${isCollapsed ? 'hidden' : 'block'} md:block`}>
        <div className="px-4 pb-3 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Total Applications</span>
            <span className="text-lg font-bold text-gray-900">
              {loading ? '-' : total}
            </span>
          </div>
        </div>

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
    </div>
  );
}
