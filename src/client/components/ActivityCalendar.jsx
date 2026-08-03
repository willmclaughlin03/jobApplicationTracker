import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getActivityCounts, getIntensityLevel } from '../lib/getActivityCounts';

const MAX_SELECTED_DATES = 7;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ACTIVITY_INTENSITY_CLASSES = [
  'border-dashboard-line/80 bg-dashboard-canvas',
  'border-emerald-900 bg-emerald-950',
  'border-emerald-700 bg-emerald-800',
  'border-emerald-500 bg-emerald-600',
  'border-dashboard-accent/80 bg-emerald-400',
];

/**
 * Builds the row-based grid for a single month.
 * Returns an array of week-rows, each containing 7 entries (null for days outside the month).
 */
function buildMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = firstDay.getDay(); // 0=Sun

  const weeks = [];
  let week = new Array(startDow).fill(null);

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    week.push({ key, day });

    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  // Pad the last week with nulls
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  return weeks;
}

/**
 * Month-by-month activity calendar with navigation.
 *
 * Purpose: Visualizes daily job application activity for one month at a time
 * Connects to: getActivityCounts utility for data aggregation
 *
 * @param {Array} jobs - Filtered jobs array passed from the parent
 * @param {Set<string>} selectedDates - Set of "YYYY-MM-DD" strings currently selected
 * @param {Function} onDateToggle - Called with a "YYYY-MM-DD" string when a day cell is clicked
 */
export default function ActivityCalendar({ jobs, selectedDates = new Set(), onDateToggle = () => {} }) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const counts = useMemo(() => getActivityCounts(jobs), [jobs]);
  const weeks = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  // Earliest job date — used to floor backward navigation
  const earliestDate = useMemo(() => {
    let earliest = null;
    for (const job of jobs) {
      if (!job.created_at) continue;
      const d = new Date(job.created_at);
      if (!earliest || d < earliest) earliest = d;
    }
    return earliest;
  }, [jobs]);

  // Total applications for the displayed month
  const monthTotal = useMemo(() => {
    let total = 0;
    for (const week of weeks) {
      for (const cell of week) {
        if (cell) total += counts.get(cell.key) || 0;
      }
    }
    return total;
  }, [weeks, counts]);

  // Fall back to today when there are no jobs — prevents infinite backward navigation
  const floorDate = earliestDate ?? today;
  const isEarliestMonth =
    viewYear === floorDate.getFullYear() &&
    viewMonth === floorDate.getMonth();

  const goToPrevMonth = () => {
    if (isEarliestMonth) return;
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(y => y - 1);
    } else {
      setViewMonth(m => m - 1);
    }
  };

  const goToNextMonth = () => {
    // Don't navigate past the current month
    if (viewYear === today.getFullYear() && viewMonth === today.getMonth()) return;

    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(y => y + 1);
    } else {
      setViewMonth(m => m + 1);
    }
  };

  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  return (
    <div className="text-dashboard-text">
      {/* Header with navigation */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={goToPrevMonth}
          disabled={isEarliestMonth}
          className={`dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center rounded-dashboard-control transition-colors ${
            isEarliestMonth
              ? 'cursor-not-allowed text-dashboard-muted/35'
              : 'text-dashboard-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text'
          }`}
          aria-label="Previous month"
        >
          <ChevronLeft aria-hidden="true" size={17} />
        </button>

        <h3 className="text-sm font-semibold text-dashboard-text">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </h3>

        <button
          type="button"
          onClick={goToNextMonth}
          disabled={isCurrentMonth}
          className={`dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center rounded-dashboard-control transition-colors ${
            isCurrentMonth
              ? 'cursor-not-allowed text-dashboard-muted/35'
              : 'text-dashboard-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text'
          }`}
          aria-label="Next month"
        >
          <ChevronRight aria-hidden="true" size={17} />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="mb-1 grid grid-cols-7 gap-1">
        {DAY_LABELS.map(label => (
          <div key={label} className="text-center text-xs font-medium text-dashboard-muted">
            {label.charAt(0)}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((cell, i) => {
          if (!cell) {
            return <div key={i} className="aspect-square" />;
          }

          const count = counts.get(cell.key) || 0;
          const level = getIntensityLevel(count);
          const intensityClass = ACTIVITY_INTENSITY_CLASSES[level];
          const isToday =
            cell.day === today.getDate() &&
            viewMonth === today.getMonth() &&
            viewYear === today.getFullYear();
          const isSelected = selectedDates.has(cell.key);
          const atMax = selectedDates.size >= MAX_SELECTED_DATES;
          const canSelect = isSelected || !atMax;

          let title = `${MONTH_NAMES[viewMonth]} ${cell.day}: ${count} application${count !== 1 ? 's' : ''}`;
          if (isSelected) title += ' (selected — click to remove)';
          else if (atMax) title = `Max ${MAX_SELECTED_DATES} dates selected`;

          return (
            <button
              key={i}
              type="button"
              onClick={() => onDateToggle(cell.key)}
              disabled={!canSelect}
              aria-label={title}
              aria-pressed={isSelected}
              className={`dashboard-focus-ring flex aspect-square min-h-9 min-w-9 w-full cursor-pointer items-center justify-center rounded-dashboard-control border ${intensityClass}
                transition-colors disabled:cursor-not-allowed disabled:opacity-40
                ${isSelected
                  ? 'ring-2 ring-dashboard-accent ring-offset-1 ring-offset-dashboard-surface-raised'
                  : isToday ? 'ring-1 ring-dashboard-muted/70' : ''}`}
              title={title}
            >
              <span className={`text-xs font-medium leading-none ${
                level === 4 ? 'text-emerald-950' : level >= 2 ? 'text-white' : 'text-dashboard-muted'
              }`}>
                {cell.day}
              </span>
            </button>
          );
        })}
      </div>

      {/* Month summary + legend */}
      <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-dashboard-muted">
          {monthTotal} application{monthTotal !== 1 ? 's' : ''} this month
        </span>
        <div
          role="img"
          aria-label="Activity intensity from less to more"
          className="flex items-center gap-1 text-xs text-dashboard-muted"
        >
          <span>Less</span>
          {ACTIVITY_INTENSITY_CLASSES.map((intensityClass) => (
            <span
              key={intensityClass}
              aria-hidden="true"
              className={`h-3 w-3 rounded-sm border ${intensityClass}`}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
