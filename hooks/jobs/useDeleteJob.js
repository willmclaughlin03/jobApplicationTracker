import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase.js';
import { normalizeError, ERROR_MESSAGES } from '../../lib/errors.js';

export function useDeleteJob(onSuccess) {
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const deleteJob = useCallback(async (userId, id) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
      setError(err);
      return { success: false, error: err };
    }

    setDeleting(id);
    setError(null);

    const { error: supabaseError } = await supabase
      .from('jobs')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    setDeleting(null);

    if (supabaseError) {
      const normalizedError = normalizeError(supabaseError, ERROR_MESSAGES.DELETE_FAILED);
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
