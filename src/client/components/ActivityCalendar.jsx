import { useState, useMemo } from 'react';
import { getActivityCounts, getIntensityLevel, INTENSITY_COLORS } from '../lib/getActivityCounts';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
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
 */
export default function ActivityCalendar({ jobs }) {
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
    <div>
      {/* Header with navigation */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={goToPrevMonth}
          disabled={isEarliestMonth}
          className={`p-1 transition-colors ${
            isEarliestMonth ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'
          }`}
          aria-label="Previous month"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <h3 className="text-sm font-semibold text-gray-700">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </h3>

        <button
          onClick={goToNextMonth}
          disabled={isCurrentMonth}
          className={`p-1 transition-colors ${
            isCurrentMonth ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'
          }`}
          aria-label="Next month"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_LABELS.map(label => (
          <div key={label} className="text-xs text-gray-400 text-center">
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
          const color = INTENSITY_COLORS[level];
          const isToday =
            cell.day === today.getDate() &&
            viewMonth === today.getMonth() &&
            viewYear === today.getFullYear();

          return (
            <div
              key={i}
              className={`aspect-square rounded-sm ${color} flex items-center justify-center cursor-default
                ${isToday ? 'ring-1 ring-gray-400' : ''}`}
              title={`${MONTH_NAMES[viewMonth]} ${cell.day}: ${count} application${count !== 1 ? 's' : ''}`}
            >
              <span className={`text-xs leading-none ${level >= 3 ? 'text-white/80' : 'text-gray-500'}`}>
                {cell.day}
              </span>
            </div>
          );
        })}
      </div>

      {/* Month summary + legend */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-gray-500">
          {monthTotal} application{monthTotal !== 1 ? 's' : ''} this month
        </span>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span>Less</span>
          {INTENSITY_COLORS.map((color, i) => (
            <div key={i} className={`${color} rounded-sm`} style={{ width: '10px', height: '10px' }} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
