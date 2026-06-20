import { useEffect, useCallback, useMemo } from 'react';
import { usePagination } from './usePagination.js';
import { useJobsQuery, useAddJob, useUpdateJob, useDeleteJob } from './jobs/index.js';
import { filterJobs } from '../lib/filterJobs.js';

const PAGE_SIZE = 10;
const EMPTY_COUNTS = { applied: 0, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };

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
 * @param {number|null} salaryMin - Minimum salary filter (client-side, no API call)
 * @param {number|null} salaryMax - Maximum salary filter (client-side, no API call)
 * @param {Set<string>|null} selectedDates - Set of "YYYY-MM-DD" strings to filter by applied date
 *
 * Note: allJobs (unfiltered) is intentionally returned for the activity calendar so its heatmap
 * always reflects the user's full history, regardless of any active status/search/salary filters.
 */
export function useJobs(userId, statusFilter = null, searchQuery = '', salaryMin = null, salaryMax = null, selectedDates = null) {
  const { currentPage, setCurrentPage, setTotalCount, goToPage } = usePagination(PAGE_SIZE);

  const query = useJobsQuery();
  const { jobs: allJobs, storageSummary, loading, fetchJobs, prependJob, updateJobInList, removeJobFromList } = query;

  // Load all jobs once on mount; all subsequent filtering is client-side at zero API cost
  useEffect(() => {
    if (userId) fetchJobs();
  }, [userId, fetchJobs]);

  // Full filter including selected dates: drives the job table and pagination
  const filteredJobs = useMemo(
    () => filterJobs(allJobs, statusFilter, searchQuery, salaryMin, salaryMax, selectedDates),
    [allJobs, statusFilter, searchQuery, salaryMin, salaryMax, selectedDates]
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
  }, [statusFilter, searchQuery, salaryMin, salaryMax, selectedDates, setCurrentPage]);

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

  // Derive status counts from the in-memory job list (no extra API call)
  const statusCounts = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const job of allJobs) {
      if (Object.prototype.hasOwnProperty.call(counts, job.status)) {
        counts[job.status]++;
      }
    }
    return counts;
  }, [allJobs]);

  // The inner hooks already return stable useCallback references, so no wrapper needed
  const addJob = add.addJob;
  const updateJob = update.updateJob;
  const deleteJob = del.deleteJob;

  return {
    jobs,
    allJobs,
    filteredJobs,
    storageSummary,
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
    totalJobs: allJobs.length,
    statusCounts,
    pageSize: PAGE_SIZE,
    goToPage,
  };
}
