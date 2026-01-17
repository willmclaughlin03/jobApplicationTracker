const STATUS_COLORS = {
  applied: 'bg-blue-100 text-blue-800',
  interviewing: 'bg-orange-100 text-orange-800',
  offered: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  accepted: 'bg-green-200 text-green-900',
};

export default function JobCard({ job, onEdit, onDelete, isDeleting }) {
  return (
    <tr className="border-b border-gray-200 last:border-b-0">
      <td className="px-4 py-3 text-sm text-gray-800">{job.company}</td>
      <td className="px-4 py-3 text-sm text-gray-800">{job.position}</td>
      <td className="px-4 py-3 text-sm">
        <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[job.status] || 'bg-gray-100 text-gray-800'}`}>
          {job.status}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{job.notes || '-'}</td>
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
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
  );
}