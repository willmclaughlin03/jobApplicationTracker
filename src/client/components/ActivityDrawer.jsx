import { X } from 'lucide-react';
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
          className="fixed inset-0 z-30 bg-[#010907]/80"
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
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-40 flex w-full max-w-[20rem] flex-col overflow-y-auto border-r border-dashboard-panel-border bg-dashboard-surface-raised text-dashboard-text shadow-2xl
          dashboard-motion transition-transform
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-dashboard-line px-4 py-3">
          <h2 className="text-sm font-semibold text-dashboard-text">Application Activity</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close activity drawer"
            className="dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center rounded-dashboard-control text-dashboard-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        {/* Selected dates list */}
        {selectedDates.size > 0 && (
          <div className="border-b border-dashboard-line px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-dashboard-muted">
                Selected Dates ({selectedDates.size}/7)
              </h3>
              <button
                type="button"
                onClick={onClearDates}
                className="dashboard-focus-ring inline-flex min-h-9 items-center rounded-dashboard-control px-2 text-xs font-medium text-dashboard-accent-hover transition-colors hover:bg-dashboard-surface-hover"
              >
                Clear All
              </button>
            </div>
            <ul className="divide-y divide-dashboard-line/70">
              {Array.from(selectedDates).sort().map(dateStr => {
                const [y, m, d] = dateStr.split('-').map(Number);
                const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                return (
                  <li key={dateStr} className="flex min-h-9 items-center justify-between py-1 text-sm text-dashboard-text">
                    <span>{label}</span>
                    <button
                      type="button"
                      onClick={() => onDateToggle(dateStr)}
                      aria-label={`Remove ${label}`}
                      className="dashboard-focus-ring ml-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-dashboard-control text-dashboard-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text"
                    >
                      <X aria-hidden="true" size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Calendar content */}
        <div className="overflow-x-auto p-3">
          <ActivityCalendar jobs={jobs} selectedDates={selectedDates} onDateToggle={onDateToggle} />
        </div>
      </div>
    </>
  );
}
