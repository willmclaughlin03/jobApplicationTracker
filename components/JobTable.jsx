import JobCard from './JobCard';

export default function JobTable({ jobs, onEdit, onDelete, deleting }) {
  return (
    <div className="bg-white rounded-lg overflow-hidden shadow-sm">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Company</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Position</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Notes</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onEdit={onEdit}
              onDelete={onDelete}
              isDeleting={deleting === job.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}