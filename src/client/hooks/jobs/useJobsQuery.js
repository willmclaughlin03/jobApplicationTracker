import { useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useJobsQuery() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchJobs = useCallback(async ({ from, to }, statusFilter = null) => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (from !== undefined) params.append('from', from);
    if (to !== undefined) params.append('to', to);
    if (statusFilter) params.append('status', statusFilter);

    const queryString = params.toString();
    const endpoint = queryString ? `/api?${queryString}` : '/api';

    const { data: response, error: apiError } = await api.get(endpoint);

    if (apiError || response?.error) {
      const normalizedError = normalizeError(apiError || response?.error, ERROR_MESSAGES.FETCH_FAILED);
      setError(normalizedError);
      setLoading(false);
      return { success: false, data: null, count: 0, error: normalizedError };
    }

    const jobsData = response?.data?.data || [];
    const count = response?.data?.count || 0;

    setJobs(jobsData);
    setLoading(false);
    return { success: true, data: jobsData, count, error: null };
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
