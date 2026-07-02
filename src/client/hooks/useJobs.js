import { useEffect, useCallback, useMemo, useRef } from 'react';
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
  const {
    jobs: allJobs,
    storageSummary,
    loading,
    fetchJobs,
    refreshStorageSummary,
    invalidateJobsFetches,
    applyStorageSummary,
    prependJob,
    updateJobInList,
    removeJobFromList,
  } = query;
  const mutationSequenceRef = useRef(0);

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

  /**
   * Marks the beginning of a count-changing job mutation.
   *
   * Purpose: response-carried storage summaries should only apply directly
   * when no newer add/delete mutation has started since that request began.
   *
   * @returns {number} Monotonic mutation sequence id.
   */
  const beginStorageMutation = useCallback(() => {
    mutationSequenceRef.current += 1;
    return mutationSequenceRef.current;
  }, []);

  /**
   * Applies mutation-returned storage metadata or falls back to status refresh.
   *
   * Purpose: latest mutation summaries can skip the extra read, while stale or
   * missing summaries keep using the existing count-only refresh path.
   *
   * @param {object|null|undefined} nextStorageSummary - Optional mutation summary metadata.
   * @param {number} mutationSequence - Sequence id captured before the mutation request.
   * @returns {void}
   */
  const syncStorageSummaryAfterMutation = useCallback((nextStorageSummary, mutationSequence) => {
    if (
      nextStorageSummary
      && mutationSequence === mutationSequenceRef.current
      && applyStorageSummary(nextStorageSummary)
    ) {
      return;
    }

    void refreshStorageSummary();
  }, [applyStorageSummary, refreshStorageSummary]);

  /**
   * Applies a created job locally and syncs count-only storage metadata.
   *
   * Purpose: the POST response may now carry the server-built summary; when it
   * does not, the existing storage-status refresh remains the compatibility
   * fallback.
   *
   * @param {object} newJob - Created job row returned by the jobs API.
   * @param {object|null} nextStorageSummary - Optional storage summary returned by POST.
   * @param {number} mutationSequence - Sequence id captured before the add request.
   * @returns {void}
   */
  const handleAddJobSuccess = useCallback((newJob, nextStorageSummary, mutationSequence) => {
    prependJob(newJob);
    syncStorageSummaryAfterMutation(nextStorageSummary, mutationSequence);
  }, [prependJob, syncStorageSummaryAfterMutation]);

  /**
   * Removes a deleted job locally and refreshes count-only storage metadata.
   *
   * Purpose: active counts and projected overflow can change after deletes even
   * though the table can update immediately from the deleted row id.
   *
   * @param {string} id - Deleted job id returned by the delete flow.
   * @param {object|null} nextStorageSummary - Optional storage summary returned by DELETE.
   * @param {number} mutationSequence - Sequence id captured before the delete request.
   * @returns {void}
   */
  const handleDeleteJobSuccess = useCallback((id, nextStorageSummary, mutationSequence) => {
    removeJobFromList(id);
    syncStorageSummaryAfterMutation(nextStorageSummary, mutationSequence);
  }, [removeJobFromList, syncStorageSummaryAfterMutation]);

  /**
   * Applies an updated job locally after invalidating older full-list reads.
   *
   * Purpose: a delayed `/api` list response can reflect pre-update data, so
   * successful PUT mutations bump the list request id before local state merge.
   *
   * @param {string} id - Updated job id.
   * @param {object} updates - Validated update payload sent to the API.
   * @returns {void}
   */
  const handleUpdateJobSuccess = useCallback((id, updates) => {
    invalidateJobsFetches();
    updateJobInList(id, updates);
  }, [invalidateJobsFetches, updateJobInList]);

  const add = useAddJob();
  const update = useUpdateJob(handleUpdateJobSuccess);
  const del = useDeleteJob();
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

  /**
   * Adds a job and applies local list/storage updates on success.
   *
   * Purpose: capture mutation ordering before the network request so delayed
   * POST summaries cannot overwrite newer add/delete outcomes.
   *
   * @param {object} jobData - Validated by the server-side job create route.
   * @returns {Promise<object>} The useAddJob mutation result.
   */
  const addJob = useCallback(async (jobData) => {
    const mutationSequence = beginStorageMutation();
    const result = await add.addJob(jobData);

    if (result.success && result.data) {
      handleAddJobSuccess(result.data, result.storageSummary, mutationSequence);
    }

    return result;
  }, [add.addJob, beginStorageMutation, handleAddJobSuccess]);

  const updateJob = update.updateJob;

  /**
   * Deletes a job and applies local list/storage updates on success.
   *
   * Purpose: use a fresh DELETE response summary when present, while
   * keeping the storage-status refresh fallback for older or summary-less responses.
   *
   * @param {string} id - Job id selected for deletion.
   * @returns {Promise<object>} The useDeleteJob mutation result.
   */
  const deleteJob = useCallback(async (id) => {
    const mutationSequence = beginStorageMutation();
    const result = await del.deleteJob(id);

    if (result.success) {
      handleDeleteJobSuccess(id, result.storageSummary, mutationSequence);
    }

    return result;
  }, [beginStorageMutation, del.deleteJob, handleDeleteJobSuccess]);

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
    refreshStorageSummary,
    refetch: fetchJobs,
    currentPage,
    totalCount: filteredJobs.length,
    totalJobs: allJobs.length,
    statusCounts,
    pageSize: PAGE_SIZE,
    goToPage,
  };
}
