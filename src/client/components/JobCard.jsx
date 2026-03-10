import { useState } from 'react';
import { STATUS_COLORS } from './forms/constants';
import Spinner from './Spinner.jsx';

export default function JobCard({ job, onEdit, onDelete, isDeleting }) {
  const [expanded, setExpanded] = useState(false);
  const hasNotes = Boolean(job.notes);
  const isLongNotes = hasNotes && job.notes.length > 90;
  const isLongCompany = job.company.length > 20;
  const isLongPosition = job.position.length > 22;
  const isAnyLong = isLongCompany || isLongPosition || isLongNotes;

  return (
    <tr className="border-b border-gray-200 last:border-b-0">
      <td className="px-4 py-3 text-sm text-gray-800 max-w-[9rem]" title={isLongCompany && !expanded ? job.company : undefined}>
        <span className={isLongCompany && !expanded ? 'block truncate' : 'whitespace-normal break-words'}>{job.company}</span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-800 max-w-[9rem]" title={isLongPosition && !expanded ? job.position : undefined}>
        <span className={isLongPosition && !expanded ? 'block truncate' : 'whitespace-normal break-words'}>{job.position}</span>
      </td>
      <td className="px-4 py-3 text-sm">
        <span className={`inline-block px-2.5 py-1 rounded-full border text-xs font-medium capitalize ${STATUS_COLORS[job.status] || 'bg-gray-100 text-gray-800 border-gray-300'}`}>
          {job.status}
        </span>
      </td>
      <td
        className="px-4 py-3 text-sm text-gray-600 max-w-xs"
        title={!expanded && isLongNotes ? job.notes : undefined}
      >
        <div className="flex items-start gap-1.5">
          <span className={`min-w-0 ${isLongNotes && !expanded ? 'truncate' : 'whitespace-normal break-words'}`}>
            {job.notes || '-'}
          </span>
          {isAnyLong && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className={`shrink-0 text-gray-400 hover:text-gray-600 transition-transform duration-200 ${expanded ? 'rotate-180' : 'rotate-0'}`}
              aria-label={expanded ? 'Collapse note' : 'Expand note'}
            >
              ▼
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-sm">
        <div className="flex gap-2">
          <button
            onClick={() => onEdit(job)}
            className="bg-blue-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={isDeleting}
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(job.id)}
            className="bg-red-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={isDeleting}
          >
            {isDeleting ? <><Spinner size="sm" className="inline mr-1" />Deleting...</> : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
  );
}