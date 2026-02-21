import { useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useAddJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const addJob = useCallback(async (jobData) => {
    setSaving(true);
    setError(null);

    const { data: response, error: apiError } = await api.post('/api', jobData);

    setSaving(false);

    if (apiError || response?.error) {
      // Use the backend's message and code when available (e.g. STORAGE_LIMIT_EXCEEDED),
      // otherwise fall back to the generic apiError string
      const errorData = response?.error
        ? { message: response?.message, code: response?.error }
        : apiError;
      const normalizedError = normalizeError(errorData, ERROR_MESSAGES.ADD_FAILED);
      setError(normalizedError);
      return { success: false, data: null, error: normalizedError };
    }

    const newJob = response?.data?.[0];

    if (onSuccess && newJob) {
      onSuccess(newJob);
    }

    return { success: true, data: newJob, error: null };
  }, [onSuccess]);

  return {
    addJob,
    saving,
    error,
    clearError,
  };
}
