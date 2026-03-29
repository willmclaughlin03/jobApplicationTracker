import ActivityCalendar from './ActivityCalendar';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility';

/**
 * Slide-out drawer for the activity calendar.
 *
 * Purpose: Wraps ActivityCalendar in a drawer overlay accessible on all screen sizes
 * Connects to: Dashboard (index.js) — mirrors the pattern used by JobStatsSidebar
 *
 * @param {boolean} isOpen - Whether the drawer is visible
 * @param {Function} onClose - Callback to close the drawer
 * @param {Array} jobs - Job array to display activity for (filtered or full)
 * @param {Set<string>} selectedDates - Set of "YYYY-MM-DD" strings currently selected
 * @param {Function} onDateToggle - Called with a "YYYY-MM-DD" string to toggle date selection
 * @param {Function} onClearDates - Clears all selected dates
 */
export default function ActivityDrawer({ isOpen, onClose, jobs, selectedDates = new Set(), onDateToggle = () => {}, onClearDates = () => {} }) {
  const { containerRef } = useOverlayAccessibility(isOpen, onClose);

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
        aria-label="Activity calendar drawer"
        className={`fixed inset-y-0 left-0 z-40 w-80 bg-white shadow-xl flex flex-col overflow-y-auto
          transition-transform duration-200
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-800">Application Activity</h2>
          <button
            onClick={onClose}
            aria-label="Close activity drawer"
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Selected dates list */}
        {selectedDates.size > 0 && (
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Selected Dates ({selectedDates.size}/7)
              </h3>
              <button
                onClick={onClearDates}
                className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
              >
                Clear all
              </button>
            </div>
            <ul className="space-y-1">
              {Array.from(selectedDates).sort().map(dateStr => {
                const [y, m, d] = dateStr.split('-').map(Number);
                const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                return (
                  <li key={dateStr} className="flex items-center justify-between text-sm text-gray-700">
                    <span>{label}</span>
                    <button
                      onClick={() => onDateToggle(dateStr)}
                      aria-label={`Remove ${label}`}
                      className="text-gray-400 hover:text-gray-600 transition-colors ml-2"
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Calendar content */}
        <div className="p-3 overflow-x-auto">
          <ActivityCalendar jobs={jobs} selectedDates={selectedDates} onDateToggle={onDateToggle} />
        </div>
      </div>
    </>
  );
}
