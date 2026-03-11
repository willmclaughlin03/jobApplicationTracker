import { STATUS_OPTIONS, STATUS_HEX_COLORS } from './forms/constants';

const RADIUS = 35;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MIN_PERCENTAGE = 2;

/**
 * SVG donut pie chart showing job application status distribution.
 *
 * Purpose: Visual summary of how applications are distributed across statuses.
 * Connects to: JobStatsSidebar — rendered between total count and filter buttons.
 *
 * @param {Object} statusCounts - Count of jobs per status key
 * @param {number} total - Total job count
 * @param {boolean} loading - Whether data is still being fetched
 */
export default function StatusPieChart({ statusCounts, total, loading }) {
  if (!loading && total === 0) return null;

  if (loading) {
    return (
      <div className="flex justify-center">
        <svg
          viewBox="0 0 100 100"
          className="w-full max-w-[180px] animate-pulse"
          role="img"
          aria-label="Loading status chart"
        >
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="12"
          />
        </svg>
      </div>
    );
  }

  const segments = buildSegments(statusCounts, total);
  const ariaLabel = buildAriaLabel(segments);

  let offset = 0;

  return (
    <div className="flex justify-center">
      <svg
        viewBox="0 0 100 100"
        className="w-full max-w-[180px]"
        role="img"
        aria-label={ariaLabel}
      >
        {segments.map(({ value, label, count, percentage }) => {
          const dashLength = (percentage / 100) * CIRCUMFERENCE;
          const dashGap = CIRCUMFERENCE - dashLength;
          const dashOffset = -(offset / 100) * CIRCUMFERENCE;
          offset += percentage;

          return (
            <circle
              key={value}
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke={STATUS_HEX_COLORS[value]}
              strokeWidth="12"
              strokeDasharray={`${round(dashLength)} ${round(dashGap)}`}
              strokeDashoffset={round(dashOffset)}
              transform="rotate(-90 50 50)"
              aria-hidden="true"
            >
              <title>{`${label}: ${count} (${Math.round((count / total) * 100)}%)`}</title>
            </circle>
          );
        })}
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          className="text-[0.9rem] font-bold fill-gray-800"
        >
          {total}
        </text>
      </svg>
    </div>
  );
}

/**
 * Build normalized segments with minimum arc enforcement.
 *
 * Any non-zero status gets at least MIN_PERCENTAGE of the chart.
 * After clamping, all percentages are normalized to sum to exactly 100.
 *
 * @param {Object} statusCounts - Count per status
 * @param {number} total - Total count
 * @returns {Array<{value: string, label: string, count: number, percentage: number}>}
 */
export function buildSegments(statusCounts, total) {
  const nonZero = STATUS_OPTIONS
    .filter(({ value }) => (statusCounts[value] || 0) > 0)
    .map(({ value, label }) => {
      const count = statusCounts[value];
      const rawPercentage = (count / total) * 100;
      return {
        value,
        label,
        count,
        percentage: Math.max(rawPercentage, MIN_PERCENTAGE),
      };
    });

  if (nonZero.length === 0) return [];

  const clampedSum = nonZero.reduce((sum, s) => sum + s.percentage, 0);

  return nonZero.map((segment) => ({
    ...segment,
    percentage: (segment.percentage / clampedSum) * 100,
  }));
}

/**
 * Build a descriptive aria-label for screen readers.
 *
 * @param {Array} segments - Normalized segments from buildSegments
 * @returns {string}
 */
function buildAriaLabel(segments) {
  const parts = segments.map((s) => `${s.count} ${s.label.toLowerCase()}`);
  return `Status distribution: ${parts.join(', ')}`;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
