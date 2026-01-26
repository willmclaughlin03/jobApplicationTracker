import { STATUS_OPTIONS } from './constants.js';

export default function JobFormFields({ formData, onChange, idPrefix = '' }) {
  const prefix = idPrefix ? `${idPrefix}-` : '';

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label htmlFor={`${prefix}company`} className="block text-sm font-medium text-gray-700 mb-1.5">
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
            className="w-full px-3 py-2.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <div>
          <label htmlFor={`${prefix}position`} className="block text-sm font-medium text-gray-700 mb-1.5">
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
            className="w-full px-3 py-2.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
      </div>

      <div className="mb-4">
        <label htmlFor={`${prefix}status`} className="block text-sm font-medium text-gray-700 mb-1.5">
          Status
        </label>
        <select
          id={`${prefix}status`}
          name="status"
          value={formData.status}
          onChange={onChange}
          className="w-full px-3 py-2.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500 transition-colors"
        >
          {STATUS_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-5">
        <label htmlFor={`${prefix}notes`} className="block text-sm font-medium text-gray-700 mb-1.5">
          Notes
        </label>
        <textarea
          id={`${prefix}notes`}
          name="notes"
          value={formData.notes}
          onChange={onChange}
          placeholder="Add any notes about this application..."
          rows={3}
          className="w-full px-3 py-2.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500 transition-colors resize-none"
        />
      </div>
    </>
  );
}
