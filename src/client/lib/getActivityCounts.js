/**
 * Aggregates job applications by date for the activity calendar.
 *
 * Purpose: Converts the full jobs array into a Map of daily counts
 * Connects to: ActivityCalendar component for rendering the heatmap
 *
 * @param {Array} jobs - Full array of job objects (each must have created_at)
 * @returns {Map<string, number>} Map keyed by "YYYY-MM-DD" → count of jobs created that day
 */
export function getActivityCounts(jobs) {
  const counts = new Map();

  for (const job of jobs) {
    if (!job.created_at) continue;

    // Truncate to local date string (YYYY-MM-DD)
    const date = new Date(job.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

/**
 * Returns the green intensity level (0–4) for a given count.
 * Scale is linear, capped at 30 applications per day.
 *
 * @param {number} count - Number of applications on a given day
 * @returns {number} Intensity level 0–4
 */
export function getIntensityLevel(count) {
  if (count === 0) return 0;
  if (count <= 7) return 1;
  if (count <= 15) return 2;
  if (count <= 22) return 3;
  return 4;
}

/** Tailwind background classes for each intensity level */
export const INTENSITY_COLORS = [
  'bg-gray-200',
  'bg-green-200',
  'bg-green-400',
  'bg-green-500',
  'bg-green-700',
];
