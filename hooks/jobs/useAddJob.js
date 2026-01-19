import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase.js';
import { normalizeError, ERROR_MESSAGES } from '../../lib/errors.js';

export function useAddJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const addJob = useCallback(async (userId, jobData) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
      setError(err);
      return { success: false, data: null, error: err };
    }

    setSaving(true);
    setError(null);

    const { data, error: supabaseError } = await supabase
      .from('jobs')
      .insert([{ ...jobData, user_id: userId }])
      .select();

    setSaving(false);

    if (supabaseError) {
      const normalizedError = normalizeError(supabaseError, ERROR_MESSAGES.ADD_FAILED);
      setError(normalizedError);
      return { success: false, data: null, error: normalizedError };
    }

    if (onSuccess && data?.[0]) {
      onSuccess(data[0]);
    }

    return { success: true, data: data[0], error: null };
  }, [onSuccess]);

  return {
    addJob,
    saving,
    error,
    clearError,
  };
}
