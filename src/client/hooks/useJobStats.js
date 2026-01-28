import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { normalizeError, ERROR_MESSAGES } from '../../shared/errors.js';

export function useJobStats(userId) {
  const [statusCounts, setStatusCounts] = useState({
    applied: 0,
    interviewing: 0,
    offered: 0,
    rejected: 0,
    accepted: 0,
  });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  const fetchStats = useCallback(async () => {
    if (!userId) {
      setStatusCounts({
        applied: 0,
        interviewing: 0,
        offered: 0,
        rejected: 0,
        accepted: 0,
      });
      setTotal(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data: response, error: apiError } = await api.get('/api');

    if (apiError || response?.error) {
      const normalizedError = normalizeError(apiError || response?.error, ERROR_MESSAGES.FETCH_FAILED);
      setError(normalizedError);
      setLoading(false);
      return;
    }

    const jobsData = response?.data?.data || [];

    const counts = {
      applied: 0,
      interviewing: 0,
      offered: 0,
      rejected: 0,
      accepted: 0,
    };

    jobsData.forEach(job => {
      if (Object.prototype.hasOwnProperty.call(counts, job.status)) {
        counts[job.status]++;
      }
    });

    setStatusCounts(counts);
    setTotal(jobsData.length);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    statusCounts,
    total,
    loading,
    error,
    clearError,
    refetch: fetchStats,
  };
}
