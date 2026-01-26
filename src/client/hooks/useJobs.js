import { useEffect, useCallback, useMemo, useRef } from 'react';
import { usePagination } from './usePagination.js';
import { useJobsQuery, useAddJob, useUpdateJob, useDeleteJob } from './jobs/index.js';

const PAGE_SIZE = 10;

export function useJobs(userId, statusFilter = null) {
  const pagination = usePagination(PAGE_SIZE);
  const { currentPage, setTotalCount, goToPage: paginationGoToPage } = pagination;
  const prevFilterRef = useRef(statusFilter);

  const query = useJobsQuery();
  const { jobs, loading, fetchJobs, prependJob, updateJobInList, removeJobFromList } = query;

  const add = useAddJob((newJob) => {
    prependJob(newJob);
    setTotalCount(prev => prev + 1);
  });

  const update = useUpdateJob((id, updates) => {
    updateJobInList(id, updates);
  });

  const del = useDeleteJob((id) => {
    removeJobFromList(id);
    setTotalCount(prev => prev - 1);
  });

  const loadPage = useCallback(async (page = currentPage) => {
    const range = { from: (page - 1) * PAGE_SIZE, to: page * PAGE_SIZE - 1 };
    const result = await fetchJobs(userId, range, statusFilter);
    if (result.success) {
      setTotalCount(result.count);
      paginationGoToPage(page);
    }
    return result;
  }, [userId, currentPage, statusFilter, fetchJobs, setTotalCount, paginationGoToPage]);

  useEffect(() => {
    loadPage(1);
  }, [userId]);

  useEffect(() => {
    if (prevFilterRef.current !== statusFilter) {
      prevFilterRef.current = statusFilter;
      loadPage(1);
    }
  }, [statusFilter, loadPage]);

  const error = useMemo(() =>
    query.error || add.error || update.error || del.error,
    [query.error, add.error, update.error, del.error]
  );

  const clearError = useCallback(() => {
    query.clearError();
    add.clearError();
    update.clearError();
    del.clearError();
  }, [query, add, update, del]);

  const addJob = useCallback((jobData) =>
    add.addJob(userId, jobData),
    [userId, add]
  );

  const updateJob = useCallback((id, updates) =>
    update.updateJob(userId, id, updates),
    [userId, update]
  );

  const deleteJob = useCallback((id) =>
    del.deleteJob(userId, id),
    [userId, del]
  );

  return {
    jobs,
    loading,
    saving: add.saving || update.saving,
    deleting: del.deleting,
    error,
    clearError,
    addJob,
    updateJob,
    deleteJob,
    refetch: loadPage,
    currentPage: pagination.currentPage,
    totalCount: pagination.totalCount,
    pageSize: PAGE_SIZE,
    goToPage: loadPage,
  };
}
