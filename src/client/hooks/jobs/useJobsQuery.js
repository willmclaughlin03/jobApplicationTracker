import { useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../../shared/errors.js';

const STORAGE_STATUS_ENDPOINT = '/api/storage/status';

export function useJobsQuery() {
  const [jobs, setJobs] = useState([]);
  const [storageSummary, setStorageSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const jobsRequestRef = useRef(0);
  const storageSummaryRequestRef = useRef(0);

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
   * @returns {Promise<{ success: boolean, data: Job[]|null, count: number, storageSummary: object|null, error: string|null, stale?: boolean }>}
   */
  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);

    const requestId = jobsRequestRef.current + 1;
    jobsRequestRef.current = requestId;
    let response = null;
    let apiError = null;

    try {
      ({ data: response, error: apiError } = await api.get('/api'));
    } catch (error) {
      apiError = error;
    }

    if (requestId !== jobsRequestRef.current) {
      return { success: false, data: null, count: 0, storageSummary: null, error: null, stale: true };
    }

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

  /**
   * Refreshes storage metadata without replacing the cached job list.
   *
   * Purpose: count-changing mutations update active rows locally, then need a
   * lightweight storage-status read so downgrade warnings and archive counts do
   * not drift until the next full dashboard reload.
   *
   * Connects to:
   * - api.get('/api/storage/status') for count-only storage metadata.
   * - normalizeError for dashboard-safe retry/failure copy.
   *
   * @returns {Promise<{ success: boolean, storageSummary: object|null, error: object|null, stale?: boolean }>}
   */
  const refreshStorageSummary = useCallback(async () => {
    const requestId = storageSummaryRequestRef.current + 1;
    storageSummaryRequestRef.current = requestId;
    let response = null;
    let apiError = null;

    try {
      ({ data: response, error: apiError } = await api.get(STORAGE_STATUS_ENDPOINT));
    } catch (error) {
      apiError = error;
    }

    if (requestId !== storageSummaryRequestRef.current) {
      return { success: false, storageSummary: null, error: null, stale: true };
    }

    if (apiError || response?.error) {
      const errorData = response?.error
        ? { message: response?.message, code: response?.error }
        : apiError;
      const normalizedError = normalizeError(errorData, ERROR_MESSAGES.SERVICE_UNAVAILABLE);
      setError(normalizedError);
      return { success: false, storageSummary: null, error: normalizedError };
    }

    const nextStorageSummary = response?.data ?? null;

    setStorageSummary(nextStorageSummary);
    setError(null);
    return { success: true, storageSummary: nextStorageSummary, error: null };
  }, []);

  /**
   * Applies server-built storage metadata from mutation responses.
   *
   * Purpose: mutation responses can carry the same count-only summary as the
   * storage-status route; bumping the refresh request id prevents older
   * in-flight refreshes from overwriting the newer mutation summary.
   *
   * @param {object|null|undefined} nextStorageSummary - Summary metadata from a mutation response.
   * @returns {boolean} True when the summary was applied.
   */
  const applyStorageSummary = useCallback((nextStorageSummary) => {
    if (!nextStorageSummary) {
      return false;
    }

    storageSummaryRequestRef.current += 1;
    setStorageSummary(nextStorageSummary);
    setError(null);
    return true;
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
    refreshStorageSummary,
    applyStorageSummary,
    prependJob,
    updateJobInList,
    removeJobFromList,
  };
}
