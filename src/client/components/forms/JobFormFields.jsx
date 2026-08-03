import { STATUS_CONFIG, STATUS_OPTIONS } from '../../../shared/constants/statuses.js';
import { SALARY_MAX_VALUE } from '../../../shared/validations/jobSchema.js';

export default function JobFormFields({ formData, onChange, idPrefix = '', errors = {} }) {
  const prefix = idPrefix ? `${idPrefix}-` : '';
  const companyErrorId = `${prefix}company-error`;
  const positionErrorId = `${prefix}position-error`;
  const salaryMinErrorId = `${prefix}salary_min-error`;
  const salaryMaxErrorId = `${prefix}salary_max-error`;
  const notesErrorId = `${prefix}notes-error`;
  const statusClass = STATUS_CONFIG[formData.status]?.dashboardClass
    || 'border-dashboard-control-border bg-dashboard-surface text-dashboard-text';

  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor={`${prefix}company`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
            Company *
          </label>
          <input
            id={`${prefix}company`}
            name="company"
            type="text"
            value={formData.company}
            onChange={onChange}
            required
            placeholder="Company name"
            aria-invalid={errors.company ? 'true' : undefined}
            aria-describedby={errors.company ? companyErrorId : undefined}
            className={`dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 transition-colors hover:border-dashboard-accent/50 focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${errors.company ? 'border-red-400/70' : ''}`}
          />
          {errors.company && (
            <p id={companyErrorId} role="alert" className="mt-1 text-xs text-red-300">{errors.company}</p>
          )}
        </div>

        <div>
          <label htmlFor={`${prefix}position`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
            Position *
          </label>
          <input
            id={`${prefix}position`}
            name="position"
            type="text"
            value={formData.position}
            onChange={onChange}
            required
            placeholder="Job title"
            aria-invalid={errors.position ? 'true' : undefined}
            aria-describedby={errors.position ? positionErrorId : undefined}
            className={`dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 transition-colors hover:border-dashboard-accent/50 focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${errors.position ? 'border-red-400/70' : ''}`}
          />
          {errors.position && (
            <p id={positionErrorId} role="alert" className="mt-1 text-xs text-red-300">{errors.position}</p>
          )}
        </div>
      </div>

      <div className="mb-4">
        <label htmlFor={`${prefix}status`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
          Status
        </label>
        <select
          id={`${prefix}status`}
          name="status"
          value={formData.status}
          onChange={onChange}
          className={`dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2.5 text-sm font-medium transition-colors focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${statusClass}`}
        >
          {STATUS_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${prefix}salary_min`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
            Min Salary
          </label>
          <input
            id={`${prefix}salary_min`}
            name="salary_min"
            type="number"
            value={formData.salary_min}
            onChange={onChange}
            placeholder="e.g. 60000"
            min="0"
            max={SALARY_MAX_VALUE}
            step="1000"
            aria-invalid={errors.salary_min ? 'true' : undefined}
            aria-describedby={errors.salary_min ? salaryMinErrorId : undefined}
            className={`dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 transition-colors hover:border-dashboard-accent/50 focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${errors.salary_min ? 'border-red-400/70' : ''}`}
          />
          {errors.salary_min && (
            <p id={salaryMinErrorId} role="alert" className="mt-1 text-xs text-red-300">{errors.salary_min}</p>
          )}
        </div>

        <div>
          <label htmlFor={`${prefix}salary_max`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
            Max Salary
          </label>
          <input
            id={`${prefix}salary_max`}
            name="salary_max"
            type="number"
            value={formData.salary_max}
            onChange={onChange}
            placeholder="e.g. 90000"
            min="0"
            max={SALARY_MAX_VALUE}
            step="1000"
            aria-invalid={errors.salary_max ? 'true' : undefined}
            aria-describedby={errors.salary_max ? salaryMaxErrorId : undefined}
            className={`dashboard-control dashboard-focus-ring min-h-9 w-full px-3 py-2.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 transition-colors hover:border-dashboard-accent/50 focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${errors.salary_max ? 'border-red-400/70' : ''}`}
          />
          {errors.salary_max && (
            <p id={salaryMaxErrorId} role="alert" className="mt-1 text-xs text-red-300">{errors.salary_max}</p>
          )}
        </div>
      </div>

      <div className="mb-5">
        <label htmlFor={`${prefix}notes`} className="mb-1.5 block text-sm font-medium text-dashboard-text">
          Notes
        </label>
        <textarea
          id={`${prefix}notes`}
          name="notes"
          value={formData.notes}
          onChange={onChange}
          placeholder="Add any notes about this application..."
          aria-invalid={errors.notes ? 'true' : undefined}
          aria-describedby={errors.notes ? notesErrorId : undefined}
          className={`dashboard-control dashboard-focus-ring min-h-[72px] w-full resize-none px-3 py-2.5 text-sm text-dashboard-text placeholder:text-dashboard-muted/70 transition-colors [field-sizing:content] hover:border-dashboard-accent/50 focus:border-dashboard-accent/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${errors.notes ? 'border-red-400/70' : ''}`}
        />
        {errors.notes && (
          <p id={notesErrorId} role="alert" className="mt-1 text-xs text-red-300">{errors.notes}</p>
        )}
      </div>
    </>
  );
}
