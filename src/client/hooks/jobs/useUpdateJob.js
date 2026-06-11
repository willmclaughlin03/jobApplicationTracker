import { useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useUpdateJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const updateJob = useCallback(async (id, updates) => {
    setSaving(true);
    setError(null);

    // RESTful endpoint: ID in URL path, updates in body
    const { data: response, error: apiError } = await api.put(`/api/${id}`, updates);

    setSaving(false);

    if (apiError || response?.error) {
      const errorData = response?.error
        ? { message: response?.message, code: response?.error }
        : apiError;
      const normalizedError = normalizeError(errorData, ERROR_MESSAGES.UPDATE_FAILED);
      setError(normalizedError);
      return { success: false, data: null, error: normalizedError };
    }

    if (onSuccess) {
      onSuccess(id, updates);
    }

    return { success: true, data: response?.data?.[0], error: null };
  }, [onSuccess]);

  return {
    updateJob,
    saving,
    error,
    clearError,
  };
}
