import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useJobsQuery() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchJobs = useCallback(async (userId, { from, to }, statusFilter = null) => {
    if (!userId) {
      setJobs([]);
      setLoading(false);
      return { success: true, data: [], count: 0, error: null };
    }

    setLoading(true);
    setError(null);

    let query = supabase
      .from('jobs')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    const { data, error: supabaseError, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (supabaseError) {
      const normalizedError = normalizeError(supabaseError, ERROR_MESSAGES.FETCH_FAILED);
      setError(normalizedError);
      setLoading(false);
      return { success: false, data: null, count: 0, error: normalizedError };
    }

    setJobs(data || []);
    setLoading(false);
    return { success: true, data, count: count || 0, error: null };
  }, []);

  const prependJob = useCallback((job) => {
    setJobs(prev => [job, ...prev]);
  }, []);

  const updateJobInList = useCallback((id, updates) => {
    setJobs(prev => prev.map(job =>
      job.id === id ? { ...job, ...updates } : job
    ));
  }, []);

  const removeJobFromList = useCallback((id) => {
    setJobs(prev => prev.filter(job => job.id !== id));
  }, []);

  return {
    jobs,
    setJobs,
    loading,
    error,
    clearError,
    fetchJobs,
    prependJob,
    updateJobInList,
    removeJobFromList,
  };
}
