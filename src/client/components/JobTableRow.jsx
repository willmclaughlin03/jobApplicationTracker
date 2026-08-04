import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatApplicationDate } from '../lib/formatApplicationDate.js';
import { formatSalary } from '../lib/formatSalary.js';
import { getApplicationPresentation } from '../lib/getApplicationPresentation.js';
import JobActionsMenu from './dashboard/JobActionsMenu';

/**
 * Render one dense desktop application row using only supported job fields.
 *
 * Purpose: combines position/company, safely exposes Added and long notes, and
 * delegates the existing Edit/Delete workflows to the accessible row menu.
 *
 * @param {object} props - Row presentation contract.
 * @param {object} props.job - Supported application data.
 * @param {Function} props.onEdit - Existing edit callback receiving job.
 * @param {Function} props.onDelete - Existing delete callback receiving job.id.
 * @param {boolean} props.isDeleting - Whether this row is being deleted.
 * @returns {React.ReactElement} Six-cell application row.
 */
export default function JobTableRow({ job, onEdit, onDelete, isDeleting }) {
  const [expanded, setExpanded] = useState(false);
  const notesId = useId();
  const { notes, hasNotes, isLongNotes, status, statusDate } = getApplicationPresentation(job);
  const addedDate = formatApplicationDate(job.created_at);

  return (
    <tr className="border-b border-dashboard-line bg-dashboard-surface text-dashboard-body transition-colors last:border-b-0 hover:bg-dashboard-surface-hover">
      <td className="min-w-0 px-3 py-3 align-top">
        <span className="block truncate font-semibold text-dashboard-text" title={job.position}>
          {job.position}
        </span>
        <span className="mt-0.5 block truncate text-dashboard-caption text-dashboard-muted" title={job.company}>
          {job.company}
        </span>
      </td>
      <td className="px-3 py-3 align-top tabular-nums text-dashboard-muted">
        {addedDate}
      </td>
      <td className="px-3 py-3 align-top">
        <span className={`inline-flex rounded-full border px-2.5 py-1 text-dashboard-caption font-medium ${status?.dashboardClass || 'border-dashboard-line bg-dashboard-surface-raised text-dashboard-muted'}`}>
          {status?.label || 'Status unavailable'}
        </span>
        {statusDate && statusDate !== '\u2014' && (
          <span className="mt-1 block text-dashboard-caption text-dashboard-muted">
            {statusDate}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top tabular-nums text-dashboard-muted">
        {formatSalary(job.salary_min, job.salary_max)}
      </td>
      <td className="min-w-0 px-3 py-3 align-top text-dashboard-muted">
        <div className="flex min-w-0 items-start gap-1">
          <span
            id={notesId}
            title={!expanded && isLongNotes ? notes : undefined}
            className={`min-w-0 flex-1 ${isLongNotes && !expanded ? 'truncate' : 'whitespace-normal break-words'}`}
          >
            {hasNotes ? notes : '\u2014'}
          </span>
          {isLongNotes && (
            <button
              type="button"
              onClick={() => setExpanded(previous => !previous)}
              aria-expanded={expanded}
              aria-controls={notesId}
              aria-label={expanded ? 'Collapse notes' : 'Expand notes'}
              className="dashboard-focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded text-dashboard-muted transition-colors hover:bg-dashboard-surface-raised hover:text-dashboard-text"
            >
              <ChevronDown
                aria-hidden="true"
                size={16}
                className={`dashboard-motion transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-3 text-right align-top">
        <div className="inline-flex -translate-x-5">
          <JobActionsMenu
            job={job}
            onEdit={onEdit}
            onDelete={onDelete}
            disabled={isDeleting}
          />
        </div>
      </td>
    </tr>
  );
}
