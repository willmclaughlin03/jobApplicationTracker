import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase.js';
import { normalizeError, ERROR_MESSAGES } from '../../lib/errors.js';

export function useUpdateJob(onSuccess) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const updateJob = useCallback(async (userId, id, updates) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
      setError(err);
      return { success: false, data: null, error: err };
    }

    setSaving(true);
    setError(null);

    const { data, error: supabaseError } = await supabase
      .from('jobs')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select();

    setSaving(false);

    if (supabaseError) {
      const normalizedError = normalizeError(supabaseError, ERROR_MESSAGES.UPDATE_FAILED);
      setError(normalizedError);
      return { success: false, data: null, error: normalizedError };
    }

    if (onSuccess) {
      onSuccess(id, updates);
    }

    return { success: true, data: data[0], error: null };
  }, [onSuccess]);

  return {
    updateJob,
    saving,
    error,
    clearError,
  };
}
