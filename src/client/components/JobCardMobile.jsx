import { useId, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import Spinner from './Spinner.jsx';
import { formatApplicationDate } from '../lib/formatApplicationDate.js';
import { formatSalary } from '../lib/formatSalary.js';
import { STATUS_CONFIG } from '../../shared/constants/statuses.js';

/**
 * Render one application card with direct mobile Edit/Delete controls.
 *
 * Purpose: below 1024px all supported fields remain readable without a wide
 * table, while destructive actions stay visible, large, and guarded.
 *
 * @param {object} props - Card presentation contract.
 * @param {object} props.job - Supported application data.
 * @param {Function} props.onEdit - Existing edit callback receiving job.
 * @param {Function} props.onDelete - Existing delete callback receiving job.id.
 * @param {boolean} props.isDeleting - Whether this job is currently deleting.
 * @returns {React.ReactElement} Responsive application card.
 */
export default function JobCardMobile({ job, onEdit, onDelete, isDeleting }) {
  const [expanded, setExpanded] = useState(false);
  const notesId = useId();
  const notes = typeof job.notes === 'string' ? job.notes : '';
  const hasNotes = notes.trim().length > 0;
  const isLongNotes = hasNotes && notes.length > 90;
  const status = STATUS_CONFIG[job.status];
  const statusDate = job.status_date ? formatApplicationDate(job.status_date) : null;

  return (
    <article className="dashboard-major-panel space-y-3 rounded-dashboard-panel bg-dashboard-surface p-4 text-dashboard-body text-dashboard-text">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words font-semibold text-dashboard-text">{job.position}</h2>
          <p className="mt-0.5 break-words text-dashboard-muted">{job.company}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-dashboard-caption font-medium ${status?.dashboardClass || 'border-dashboard-line bg-dashboard-surface-raised text-dashboard-muted'}`}>
          {status?.label || 'Status unavailable'}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-2 border-y border-dashboard-line py-3 text-dashboard-caption sm:grid-cols-2">
        <div>
          <dt className="text-dashboard-muted">Added</dt>
          <dd className="mt-0.5 tabular-nums text-dashboard-text">
            {formatApplicationDate(job.created_at)}
          </dd>
        </div>
        <div>
          <dt className="text-dashboard-muted">Salary</dt>
          <dd className="mt-0.5 tabular-nums text-dashboard-text">
            {formatSalary(job.salary_min, job.salary_max)}
          </dd>
        </div>
        {statusDate && statusDate !== '\u2014' && (
          <div className="sm:col-span-2">
            <dt className="text-dashboard-muted">Status since</dt>
            <dd className="mt-0.5 tabular-nums text-dashboard-text">{statusDate}</dd>
          </div>
        )}
      </dl>

      {hasNotes && (
        <div className="text-dashboard-muted">
          <span className="font-medium text-dashboard-text">Notes</span>
          <p
            id={notesId}
            className={`mt-1 break-words ${isLongNotes && !expanded ? 'line-clamp-2' : ''}`}
          >
            {notes}
          </p>
          {isLongNotes && (
            <button
              type="button"
              onClick={() => setExpanded(previous => !previous)}
              aria-expanded={expanded}
              aria-controls={notesId}
              className="dashboard-focus-ring mt-1 inline-flex min-h-9 items-center rounded-dashboard-control px-2 text-dashboard-caption font-medium text-dashboard-accent-hover transition-colors hover:bg-dashboard-surface-hover"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 border-t border-dashboard-line pt-3">
        <button
          type="button"
          onClick={() => onEdit(job)}
          disabled={isDeleting}
          className="dashboard-control dashboard-focus-ring inline-flex min-h-9 items-center justify-center gap-2 px-3 py-2 font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil aria-hidden="true" size={16} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => onDelete(job.id)}
          disabled={isDeleting}
          className="dashboard-focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-dashboard-control border border-red-400/40 bg-red-500/10 px-3 py-2 font-medium text-red-200 transition-colors hover:border-red-300/60 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDeleting ? (
            <>
              <Spinner size="sm" className="inline" />
              Deleting...
            </>
          ) : (
            <>
              <Trash2 aria-hidden="true" size={16} />
              Delete
            </>
          )}
        </button>
      </div>
    </article>
  );
}
