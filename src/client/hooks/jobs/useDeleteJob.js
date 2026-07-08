import { useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useDeleteJob(onSuccess) {
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);
  const deleteInFlightRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const deleteJob = useCallback(async (id) => {
    if (deleteInFlightRef.current) {
      return { success: false, storageSummary: null, error: null, skipped: true };
    }

    deleteInFlightRef.current = true;
    setDeleting(id);
    setError(null);

    try {
      // RESTful endpoint: ID in URL path, no body needed
      const { data: response, error: apiError } = await api.delete(`/api/${id}`);

      if (apiError || response?.error) {
        const normalizedError = normalizeError(apiError || response?.error, ERROR_MESSAGES.DELETE_FAILED);
        setError(normalizedError);
        return { success: false, storageSummary: null, error: normalizedError };
      }

      const storageSummary = response?.storageSummary ?? null;

      if (onSuccess) {
        onSuccess(id, storageSummary);
      }

      return { success: true, storageSummary, error: null };
    } catch (requestError) {
      const normalizedError = normalizeError(requestError, ERROR_MESSAGES.DELETE_FAILED);
      setError(normalizedError);
      return { success: false, storageSummary: null, error: normalizedError };
    } finally {
      deleteInFlightRef.current = false;
      setDeleting(null);
    }
  }, [onSuccess]);

  return {
    deleteJob,
    deleting,
    error,
    clearError,
  };
}