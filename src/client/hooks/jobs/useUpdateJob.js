import { useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useUpdateJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const updateInFlightRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const updateJob = useCallback(async (id, updates) => {
    if (updateInFlightRef.current) {
      return { success: false, data: null, error: null, skipped: true };
    }

    updateInFlightRef.current = true;
    setSaving(true);
    setError(null);

    let result;

    try {
      // RESTful endpoint: ID in URL path, updates in body
      const { data: response, error: apiError } = await api.put(`/api/${id}`, updates);

      if (apiError || response?.error) {
        const errorData = response?.error
          ? { message: response?.message, code: response?.error }
          : apiError;
        const normalizedError = normalizeError(errorData, ERROR_MESSAGES.UPDATE_FAILED);
        setError(normalizedError);
        result = { success: false, data: null, error: normalizedError };
      } else {
        result = { success: true, data: response?.data?.[0], error: null };
      }
    } catch (requestError) {
      const normalizedError = normalizeError(requestError, ERROR_MESSAGES.UPDATE_FAILED);
      setError(normalizedError);
      result = { success: false, data: null, error: normalizedError };
    } finally {
      updateInFlightRef.current = false;
      setSaving(false);
    }

    if (result.success && onSuccess) {
      onSuccess(id, updates);
    }

    return result;
  }, [onSuccess]);

  return {
    updateJob,
    saving,
    error,
    clearError,
  };
}
