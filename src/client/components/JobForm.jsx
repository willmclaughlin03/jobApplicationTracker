import { useState } from 'react';
import { JobFormFields, INITIAL_FORM_DATA } from './forms/index.js';

export default function JobForm({ onSubmit, onCancel, saving }) {
  const [formData, setFormData] = useState(INITIAL_FORM_DATA);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-sm mb-5">
      <h2 className="text-lg font-semibold text-gray-800 mb-5">Add New Job Application</h2>

      <JobFormFields formData={formData} onChange={handleChange} />

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
          {saving ? 'Adding...' : 'Add Job'}
        </button>
      </div>
    </form>
  );
}
