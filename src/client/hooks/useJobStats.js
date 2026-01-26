import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';

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

    const { data, error } = await supabase
      .from('jobs')
      .select('status')
      .eq('user_id', userId);

    if (error) {
      console.error('Error fetching job stats:', error);
      setLoading(false);
      return;
    }

    const counts = {
      applied: 0,
      interviewing: 0,
      offered: 0,
      rejected: 0,
      accepted: 0,
    };

    (data || []).forEach(job => {
      if (counts.hasOwnProperty(job.status)) {
        counts[job.status]++;
      }
    });

    setStatusCounts(counts);
    setTotal(data?.length || 0);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    statusCounts,
    total,
    loading,
    refetch: fetchStats,
  };
}
