import { STATUS_CONFIG } from '../../../shared/constants/statuses.js';

/**
 * AdminActivitySummary - Displays a user's job application counts by status.
 *
 * Purpose: Shows admins a quick overview of the user's job activity on the
 * detail page. Uses the same STATUS_CONFIG color constants as the main app
 * so badge styles stay consistent.
 *
 * Connects to: /pages/admin/users/[id].js (parent), statuses.js constants
 *
 * @param {Object} props
 * @param {Object} props.activity - { totalJobs, byStatus: { [status]: count } }
 */
export default function AdminActivitySummary({ activity }) {
  if (!activity) return null;

  if (!activity.available) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-1">Job Activity</h3>
        <p className="text-sm text-amber-600">Activity data could not be loaded.</p>
      </div>
    );
  }

  const statusEntries = Object.entries(STATUS_CONFIG);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Job Activity
        <span className="ml-2 text-gray-400 font-normal">({activity.totalJobs} total)</span>
      </h3>

      {activity.totalJobs === 0 ? (
        <p className="text-sm text-gray-400">No job applications.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {statusEntries.map(([status, config]) => {
            const count = activity.byStatus[status] ?? 0;
            if (count === 0) return null;
            return (
              <span
                key={status}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium ${config.bgClass} ${config.textClass}`}
              >
                {config.label}
                <span className="font-semibold">{count}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
