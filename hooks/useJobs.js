import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';
import { normalizeError, ERROR_MESSAGES } from '../lib/errors.js';

export function useJobs(userId) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchJobs = useCallback(async () => {
    if (!userId) {
      setJobs([]);
      setLoading(false);
      return { success: true, data: [], error: null };
    }

    setLoading(true);
    setError(null);

    const { data, error: supabaseError } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (supabaseError) {
      const normalizedError = normalizeError(supabaseError, ERROR_MESSAGES.FETCH_FAILED);
      setError(normalizedError);
      setLoading(false);
      return { success: false, data: null, error: normalizedError };
    }

    setJobs(data || []);
    setLoading(false);
    return { success: true, data, error: null };
  }, [userId]);

  const addJob = useCallback(async (jobData) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
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

    setJobs(prev => [...data, ...prev]);
    return { success: true, data: data[0], error: null };
  }, [userId]);

  const updateJob = useCallback(async (id, updates) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
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

    setJobs(prev => prev.map(job =>
      job.id === id ? { ...job, ...updates } : job
    ));
    return { success: true, data: data[0], error: null };
  }, [userId]);

  const deleteJob = useCallback(async (id) => {
    if (!userId) {
      const err = normalizeError(null, ERROR_MESSAGES.UNAUTHORIZED);
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

    setJobs(prev => prev.filter(job => job.id !== id));
    return { success: true, error: null };
  }, [userId]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  return {
    jobs,
    loading,
    saving,
    deleting,
    error,
    clearError,
    addJob,
    updateJob,
    deleteJob,
    refetch: fetchJobs,
  };
}