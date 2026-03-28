import { useState } from 'react';
import { STATUS_COLORS } from './forms/constants';
import Spinner from './Spinner.jsx';
import { formatSalary } from '../lib/formatSalary.js';

/**
 * Mobile card layout for a single job application
 *
 * Purpose: Renders job data as a stacked card for viewports below md (768px)
 * Counterpart: JobTableRow.jsx handles the desktop table row layout
 *
 * @param {Object} job - Job application data (id, company, position, status, notes)
 * @param {Function} onEdit - Called with job object when Edit is clicked
 * @param {Function} onDelete - Called with job.id when Delete is clicked
 * @param {boolean} isDeleting - Whether this job is currently being deleted
 */
export default function JobCardMobile({ job, onEdit, onDelete, isDeleting }) {
  const [expanded, setExpanded] = useState(false);
  const hasNotes = Boolean(job.notes);
  const isLongNotes = hasNotes && job.notes.length > 90;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
      {/* Header: Company + Status */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800 break-words min-w-0">
          {job.company}
        </h3>
        <span className={`shrink-0 inline-block px-2.5 py-1 rounded-full border text-xs font-medium capitalize ${STATUS_COLORS[job.status] || 'bg-gray-100 text-gray-800 border-gray-300'}`}>
          {job.status}
        </span>
      </div>

      {/* Position */}
      <p className="text-sm text-gray-600 break-words">{job.position}</p>

      {/* Salary + Status Date */}
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {(job.salary_min != null || job.salary_max != null) && (
          <span>{formatSalary(job.salary_min, job.salary_max)}</span>
        )}
        {job.status_date && (
          <span>Since {new Date(job.status_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        )}
      </div>

      {/* Notes (only shown when present) */}
      {hasNotes && (
        <div className="text-sm text-gray-500 overflow-hidden">
          <span className="font-medium text-gray-600">Notes: </span>
          <span className={`break-words overflow-hidden ${isLongNotes && !expanded ? 'line-clamp-2' : ''}`}>
            {job.notes}
          </span>
          {isLongNotes && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className="block mt-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-2 border-t border-gray-100">
        <button
          onClick={() => onEdit(job)}
          className="flex-1 bg-blue-600 text-white px-3 py-2 rounded text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={isDeleting}
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(job.id)}
          className="flex-1 bg-red-600 text-white px-3 py-2 rounded text-xs font-medium hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={isDeleting}
        >
          {isDeleting ? <><Spinner size="sm" className="inline mr-1" />Deleting...</> : 'Delete'}
        </button>
      </div>
    </div>
  );
}
