import { useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

export function useJobsQuery() {
  const [jobs, setJobs] = useState([]);
  const [storageSummary, setStorageSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Fetches all jobs for the authenticated user in a single request.
   *
   * Purpose: Loads the complete job list once on mount so all subsequent
   * filtering (status, search) and pagination happen client-side at zero
   * additional API / rate-limit cost.
   *
   * Connects to:
   * - api.get('/api') — returns { data: { data: Job[], count: number, storageSummary: object } }
   * - normalizeError — converts raw API errors to a consistent shape
   *
   * @returns {Promise<{ success: boolean, data: Job[]|null, count: number, storageSummary: object|null, error: string|null }>}
   */
  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data: response, error: apiError } = await api.get('/api');

    if (apiError || response?.error) {
      const normalizedError = normalizeError(apiError || response?.error, ERROR_MESSAGES.FETCH_FAILED);
      setError(normalizedError);
      setStorageSummary(null);
      setLoading(false);
      return { success: false, data: null, count: 0, storageSummary: null, error: normalizedError };
    }

    const jobsData = response?.data?.data || [];
    const count = response?.data?.count || 0;
    const nextStorageSummary = response?.data?.storageSummary ?? null;

    setJobs(jobsData);
    setStorageSummary(nextStorageSummary);
    setLoading(false);
    return { success: true, data: jobsData, count, storageSummary: nextStorageSummary, error: null };
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
    storageSummary,
    setStorageSummary,
    loading,
    error,
    clearError,
    fetchJobs,
    prependJob,
    updateJobInList,
    removeJobFromList,
  };
}
