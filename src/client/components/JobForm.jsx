import { useState } from 'react';
import { JobFormFields, INITIAL_FORM_DATA } from './forms/index.js';
import Spinner from './Spinner.jsx';
import { COMPANY_MAX_LENGTH, POSITION_MAX_LENGTH, NOTES_MAX_LENGTH, SALARY_MAX_VALUE } from '../../shared/validations/jobSchema.js';

export default function JobForm({ onSubmit, onCancel, saving }) {
  const [formData, setFormData] = useState(INITIAL_FORM_DATA);
  const [fieldErrors, setFieldErrors] = useState({});

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
    onSubmit(submitData);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-sm mb-5">
      <h2 className="text-lg font-semibold text-gray-800 mb-5">Add New Job Application</h2>

      <JobFormFields formData={formData} onChange={handleChange} errors={fieldErrors} />

      <div className="flex gap-3 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-100 text-gray-700 border border-gray-300 px-5 py-2 rounded text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
          disabled={saving}
        >
          {saving ? <><Spinner size="sm" className="inline mr-1.5" />Adding...</> : 'Add Job'}
        </button>
      </div>
    </form>
  );
}
