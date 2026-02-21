/**
 * Pure utility for client-side job filtering.
 *
 * Purpose: Filters a job list by status and/or a company name search query.
 * Extracted as a standalone pure function so it can be unit-tested in
 * isolation from React hooks and API dependencies.
 *
 * Connects to:
 * - useJobs — calls this inside useMemo for zero-API-cost filtering
 *
 * @param {Object[]} jobs - Full job list
 * @param {string|null} statusFilter - Filter by job status; null/'' means no filter
 * @param {string} searchQuery - Case-insensitive company name substring search; '' means no filter
 * @returns {Object[]} Filtered job list (new array reference, original not mutated)
 */
export function filterJobs(jobs, statusFilter, searchQuery) {
  let result = jobs;

  if (statusFilter) {
    result = result.filter(j => j.status === statusFilter);
  }

  const q = searchQuery && searchQuery.trim().toLowerCase();
  if (q) {
    result = result.filter(j => j.company.toLowerCase().includes(q));
  }

  return result;
}
