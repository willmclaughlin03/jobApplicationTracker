import ActivityCalendar from './ActivityCalendar';

/**
 * Mobile slide-out drawer for the activity calendar.
 *
 * Purpose: Wraps ActivityCalendar in a drawer overlay for mobile viewports
 * Connects to: Dashboard (index.js) — mirrors the pattern used by JobStatsSidebar
 *
 * @param {boolean} isOpen - Whether the drawer is visible
 * @param {Function} onClose - Callback to close the drawer
 * @param {Array} jobs - The full allJobs array from useJobs
 */
export default function ActivityDrawer({ isOpen, onClose, jobs }) {
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
        className={`fixed inset-y-0 left-0 z-40 w-80 bg-white shadow-xl flex flex-col overflow-y-auto
          transition-transform duration-200
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
        aria-label="Activity calendar drawer"
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

        {/* Calendar content */}
        <div className="p-3 overflow-x-auto">
          <ActivityCalendar jobs={jobs} />
        </div>
      </div>
    </>
  );
}
