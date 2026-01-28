import { useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useDeleteJob(onSuccess) {
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const deleteJob = useCallback(async (id) => {
    setDeleting(id);
    setError(null);

    const { data: response, error: apiError } = await api.delete('/api', { id });

    setDeleting(null);

    if (apiError || response?.error) {
      const normalizedError = normalizeError(apiError || response?.error, ERROR_MESSAGES.DELETE_FAILED);
      setError(normalizedError);
      return { success: false, error: normalizedError };
    }

    if (onSuccess) {
      onSuccess(id);
    }

    return { success: true, error: null };
  }, [onSuccess]);

  return {
    deleteJob,
    deleting,
    error,
    clearError,
  };
}
