import { useEffect, useCallback, useMemo } from 'react';
import { usePagination } from './usePagination.js';
import { useJobsQuery, useAddJob, useUpdateJob, useDeleteJob } from './jobs/index.js';
import { filterJobs } from '../lib/filterJobs.js';

const PAGE_SIZE = 10;

/**
 * Composes all job state and operations for the job list UI.
 *
 * Purpose: Loads all jobs once on mount, then filters and paginates
 * client-side so that status/search changes cost zero extra API calls.
 *
 * Connects to:
 * - useJobsQuery — fetches + caches the full job list in memory
 * - useAddJob / useUpdateJob / useDeleteJob — CRUD mutations
 * - usePagination — tracks currentPage / totalCount / goToPage
 * - filterJobs — pure client-side filter (status + company name search)
 *
 * @param {string} userId - Authenticated user ID; triggers initial fetch on mount
 * @param {string|null} statusFilter - Filters jobs by status (client-side, no API call)
 * @param {string} searchQuery - Case-insensitive company name search (client-side, no API call)
 */
export function useJobs(userId, statusFilter = null, searchQuery = '') {
  const { currentPage, setCurrentPage, setTotalCount, goToPage } = usePagination(PAGE_SIZE);

  const query = useJobsQuery();
  const { jobs: allJobs, loading, fetchJobs, prependJob, updateJobInList, removeJobFromList } = query;

  // Load all jobs once on mount; all subsequent filtering is client-side at zero API cost
  useEffect(() => {
    if (userId) fetchJobs();
  }, [userId, fetchJobs]);

  // Client-side filter: status + case-insensitive company name search
  const filteredJobs = useMemo(
    () => filterJobs(allJobs, statusFilter, searchQuery),
    [allJobs, statusFilter, searchQuery]
  );

  // Keep usePagination's internal totalPages correct so goToPage can clamp properly
  useEffect(() => {
    setTotalCount(filteredJobs.length);
  }, [filteredJobs.length, setTotalCount]);

  // Reset to page 1 when filters change. Uses setCurrentPage (stable useState setter)
  // rather than goToPage to avoid a double-run caused by goToPage changing reference
  // whenever totalPages updates after setTotalCount.
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, searchQuery, setCurrentPage]);

  // Slice the filtered list for the current page
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const jobs = filteredJobs.slice(pageStart, pageStart + PAGE_SIZE);

  // Pass stable list-mutation helpers directly as onSuccess callbacks
  const add = useAddJob(prependJob);
  const update = useUpdateJob(updateJobInList);
  const del = useDeleteJob(removeJobFromList);

  const error = useMemo(
    () => query.error || add.error || update.error || del.error,
    [query.error, add.error, update.error, del.error]
  );

  const clearError = useCallback(() => {
    query.clearError();
    add.clearError();
    update.clearError();
    del.clearError();
  }, [query.clearError, add.clearError, update.clearError, del.clearError]);

  // The inner hooks already return stable useCallback references, so no wrapper needed
  const addJob = add.addJob;
  const updateJob = update.updateJob;
  const deleteJob = del.deleteJob;

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
    refetch: fetchJobs,
    currentPage,
    totalCount: filteredJobs.length,
    pageSize: PAGE_SIZE,
    goToPage,
  };
}
