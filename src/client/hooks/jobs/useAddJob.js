import { useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useAddJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const addInFlightRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const addJob = useCallback(async (jobData) => {
    if (addInFlightRef.current) {
      return { success: false, data: null, storageSummary: null, error: null, skipped: true };
    }

    addInFlightRef.current = true;
    setSaving(true);
    setError(null);

    try {
      const { data: response, error: apiError } = await api.post('/api', jobData);

      if (apiError || response?.error) {
        // Use the backend's message and code when available (e.g. STORAGE_LIMIT_EXCEEDED),
        // otherwise fall back to the generic apiError string
        const errorData = response?.error
          ? { message: response?.message, code: response?.error }
          : apiError;
        const normalizedError = normalizeError(errorData, ERROR_MESSAGES.ADD_FAILED);
        setError(normalizedError);
        return { success: false, data: null, storageSummary: null, error: normalizedError };
      }

      const newJob = response?.data?.[0];
      const storageSummary = response?.storageSummary ?? null;

      if (onSuccess && newJob) {
        onSuccess(newJob, storageSummary);
      }

      return { success: true, data: newJob, storageSummary, error: null };
    } catch (requestError) {
      const normalizedError = normalizeError(requestError, ERROR_MESSAGES.ADD_FAILED);
      setError(normalizedError);
      return { success: false, data: null, storageSummary: null, error: normalizedError };
    } finally {
      addInFlightRef.current = false;
      setSaving(false);
    }
  }, [onSuccess]);

  return {
    addJob,
    saving,
    error,
    clearError,
  };
}