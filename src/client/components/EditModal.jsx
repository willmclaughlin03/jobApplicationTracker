import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { JobFormFields, INITIAL_FORM_DATA } from './forms/index.js';
import Spinner from './Spinner.jsx';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility.js';
import { COMPANY_MAX_LENGTH, POSITION_MAX_LENGTH, NOTES_MAX_LENGTH, SALARY_MAX_VALUE } from '../../shared/validations/jobSchema.js';

const EDIT_DIALOG_TITLE_ID = 'edit-application-dialog-title';

export default function EditModal({ job, onSave, onClose, saving }) {
  const [formData, setFormData] = useState(INITIAL_FORM_DATA);
  const [fieldErrors, setFieldErrors] = useState({});

  /**
   * Request dismissal from useOverlayAccessibility, backdrop clicks, or the
   * close button. While saving, the guard prevents dismissal; otherwise it
   * calls onClose to close the dialog.
   */
  const requestClose = useCallback(() => {
    if (!saving) {
      onClose();
    }
  }, [onClose, saving]);

  const { containerRef } = useOverlayAccessibility(Boolean(job), requestClose);

  useEffect(() => {
    if (job) {
      setFormData({
        company: job.company || '',
        position: job.position || '',
        status: job.status || 'applied',
        notes: job.notes || '',
        salary_min: job.salary_min ?? '',
        salary_max: job.salary_max ?? '',
      });
      setFieldErrors({});
    }
  }, [job]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (fieldErrors[name]) {
      setFieldErrors(prev => ({ ...prev, [name]: null }));
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const newErrors = {};
    if (formData.company && formData.company.length > COMPANY_MAX_LENGTH)
      newErrors.company = `Company must be ${COMPANY_MAX_LENGTH} characters or fewer (${formData.company.length}/${COMPANY_MAX_LENGTH})`;
    if (formData.position && formData.position.length > POSITION_MAX_LENGTH)
      newErrors.position = `Position must be ${POSITION_MAX_LENGTH} characters or fewer (${formData.position.length}/${POSITION_MAX_LENGTH})`;
    if (formData.notes && formData.notes.length > NOTES_MAX_LENGTH)
      newErrors.notes = `Notes must be ${NOTES_MAX_LENGTH} characters or fewer (${formData.notes.length}/${NOTES_MAX_LENGTH})`;
    const minVal = formData.salary_min !== '' ? Number(formData.salary_min) : null;
    const maxVal = formData.salary_max !== '' ? Number(formData.salary_max) : null;
    if (minVal != null && (minVal < 0 || minVal > SALARY_MAX_VALUE || !Number.isInteger(minVal)))
      newErrors.salary_min = 'Must be a whole number between 0 and 10,000,000';
    if (maxVal != null && (maxVal < 0 || maxVal > SALARY_MAX_VALUE || !Number.isInteger(maxVal)))
      newErrors.salary_max = 'Must be a whole number between 0 and 10,000,000';
    if (minVal != null && maxVal != null && maxVal < minVal)
      newErrors.salary_max = 'Max salary must be greater than or equal to min salary';
    if (Object.keys(newErrors).length) {
      setFieldErrors(newErrors);
      return;
    }
    const submitData = {
      ...formData,
      salary_min: minVal,
      salary_max: maxVal,
    };
    onSave(job.id, submitData);
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      requestClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[#010907]/85 p-4 sm:p-5"
      onClick={handleOverlayClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={EDIT_DIALOG_TITLE_ID}
        aria-busy={saving || undefined}
        tabIndex={-1}
        className="dashboard-raised-panel max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 text-dashboard-text sm:p-6"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 id={EDIT_DIALOG_TITLE_ID} className="text-lg font-semibold text-dashboard-text">
            Edit Job Application
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label="Close edit application dialog"
            className="dashboard-focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-dashboard-control text-dashboard-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        {job?.status_date && (
          <p className="mb-4 border-b border-dashboard-line pb-3 text-xs text-dashboard-muted">
            Status since: {new Date(job.status_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <JobFormFields formData={formData} onChange={handleChange} idPrefix="edit" errors={fieldErrors} />

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={requestClose}
              disabled={saving}
              className="dashboard-control dashboard-focus-ring min-h-9 px-5 py-2 text-sm font-medium text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="dashboard-focus-ring min-h-9 rounded-dashboard-control border border-dashboard-accent bg-dashboard-accent px-5 py-2 text-sm font-semibold text-dashboard-accent-ink shadow-dashboard-panel transition-colors hover:bg-dashboard-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saving}
            >
              {saving ? <><Spinner size="sm" className="mr-1.5 inline" />Saving...</> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
