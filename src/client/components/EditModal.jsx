import { useState, useEffect } from 'react';
import { JobFormFields, INITIAL_FORM_DATA } from './forms/index.js';
import Spinner from './Spinner.jsx';
import { COMPANY_MAX_LENGTH, POSITION_MAX_LENGTH, NOTES_MAX_LENGTH } from '../../shared/validations/jobSchema.js';

export default function EditModal({ job, onSave, onClose, saving }) {
  const [formData, setFormData] = useState(INITIAL_FORM_DATA);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (job) {
      setFormData({
        company: job.company || '',
        position: job.position || '',
        status: job.status || 'applied',
        notes: job.notes || '',
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
    if (Object.keys(newErrors).length) {
      setFieldErrors(newErrors);
      return;
    }
    onSave(job.id, formData);
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-5" onClick={handleOverlayClick}>
      <div className="bg-white p-6 rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-lg font-semibold text-gray-800">Edit Job Application</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <JobFormFields formData={formData} onChange={handleChange} idPrefix="edit" errors={fieldErrors} />

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="bg-gray-100 text-gray-700 border border-gray-300 px-5 py-2 rounded text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
              disabled={saving}
            >
              {saving ? <><Spinner size="sm" className="inline mr-1.5" />Saving...</> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
