/**
 * Pure utility for client-side job filtering.
 *
 * Purpose: Filters a job list by status, company name search, and salary range.
 * Extracted as a standalone pure function so it can be unit-tested in
 * isolation from React hooks and API dependencies.
 *
 * Connects to:
 * - useJobs — calls this inside useMemo for zero-API-cost filtering
 *
 * @param {Object[]} jobs - Full job list
 * @param {string|null} statusFilter - Filter by job status; null/'' means no filter
 * @param {string} searchQuery - Case-insensitive company name substring search; '' means no filter
 * @param {number|null} salaryMin - Minimum salary filter; null means no lower bound
 * @param {number|null} salaryMax - Maximum salary filter; null means no upper bound
 * @param {Set<string>|null} selectedDates - Set of "YYYY-MM-DD" strings; null/empty means no date filter
 * @returns {Object[]} Filtered job list (new array reference, original not mutated)
 */
export function filterJobs(jobs, statusFilter, searchQuery, salaryMin = null, salaryMax = null, selectedDates = null) {
  let result = jobs;

  if (statusFilter) {
    result = result.filter(j => j.status === statusFilter);
  }

  const q = searchQuery && searchQuery.trim().toLowerCase();
  if (q) {
    result = result.filter(j => (j.company ?? '').toLowerCase().includes(q));
  }

  if (salaryMin != null || salaryMax != null) {
    result = result.filter(j => {
      if (j.salary_min == null && j.salary_max == null) return true;
      const jobMin = j.salary_min ?? j.salary_max;
      const jobMax = j.salary_max ?? j.salary_min;
      if (salaryMax != null && jobMin > salaryMax) return false;
      if (salaryMin != null && jobMax < salaryMin) return false;
      return true;
    });
  }

  if (selectedDates != null && selectedDates.size > 0) {
    result = result.filter(j => {
      if (!j.created_at) return false;
      // Use local date components (matching getActivityCounts) so the filter
      // agrees with the calendar heatmap for users in non-UTC timezones.
      const d = new Date(j.created_at);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return selectedDates.has(dateStr);
    });
  }

  return result;
}
