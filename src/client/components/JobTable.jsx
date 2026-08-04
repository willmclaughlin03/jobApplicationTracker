import JobTableRow from './JobTableRow';
import JobCardMobile from './JobCardMobile';

/**
 * Render responsive application results from one unchanged job collection.
 *
 * Purpose: the locked 1024px breakpoint exposes either the dense six-column
 * table or direct-action cards without changing ordering, data, or callbacks.
 *
 * @param {object} props - Result presentation contract.
 * @param {Array<object>} props.jobs - Current fixed-size page of jobs.
 * @param {Function} props.onEdit - Existing edit callback.
 * @param {Function} props.onDelete - Existing confirmed-delete entry callback.
 * @param {string|null} props.deleting - Id of the job currently deleting.
 * @returns {React.ReactElement} Desktop table and compact card alternatives.
 */
export default function JobTable({ jobs, onEdit, onDelete, deleting }) {
  return (
    <>
      <div className="dashboard-major-panel hidden overflow-hidden rounded-dashboard-panel bg-dashboard-surface lg:block">
        <table className="w-full table-fixed border-collapse" aria-label="Job applications">
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[14%]" />
            <col className="w-[16%]" />
            <col className="w-[15%]" />
            <col className="w-[20%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead className="bg-dashboard-surface-raised">
            <tr className="border-b border-dashboard-line">
              {['Application', 'Added', 'Status', 'Salary', 'Notes', 'Actions'].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className={`px-3 py-3 text-dashboard-caption font-semibold uppercase tracking-wide text-dashboard-muted ${label === 'Actions' ? 'text-right' : 'text-left'}`}
                >
                  {label === 'Actions' ? (
                    <span className="inline-block -translate-x-5">{label}</span>
                  ) : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <JobTableRow
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

      <div className="space-y-3 lg:hidden">
        {jobs.map(job => (
          <JobCardMobile
            key={job.id}
            job={job}
            onEdit={onEdit}
            onDelete={onDelete}
            isDeleting={deleting === job.id}
          />
        ))}
      </div>
    </>
  );
}
