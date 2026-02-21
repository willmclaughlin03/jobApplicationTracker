/**
 * Tests for filterJobs utility
 *
 * Purpose: Verify the pure client-side filter function correctly handles all
 * combinations of status filter, search query, and edge case inputs.
 *
 * Connects to: src/client/lib/filterJobs.js
 *
 * Test coverage:
 * - No filters: full list returned
 * - Status filtering: match, no match, falsy values
 * - Search filtering: substring, case-insensitivity, whitespace, null
 * - Combined: status AND search applied together
 * - Edge cases: empty list, original array not mutated
 */

const { filterJobs } = require('../filterJobs.js');

describe('filterJobs', () => {
  const jobs = [
    { id: 1, company: 'Google', status: 'applied' },
    { id: 2, company: 'Apple', status: 'interviewing' },
    { id: 3, company: 'Microsoft', status: 'applied' },
    { id: 4, company: 'Amazon', status: 'rejected' },
    { id: 5, company: 'Google Cloud', status: 'interviewing' },
  ];

  // =========================================================================
  // No filters
  // =========================================================================
  describe('no filters', () => {
    /**
     * Test: Default call returns the full list
     * Reasoning: Base case — no active filter must never hide jobs
     */
    it('should return all jobs when statusFilter is null and searchQuery is empty', () => {
      expect(filterJobs(jobs, null, '')).toEqual(jobs);
    });

    /**
     * Test: Both filters explicitly null
     * Reasoning: Callers may pass null for both; must not throw or filter
     */
    it('should return all jobs when both filters are null', () => {
      expect(filterJobs(jobs, null, null)).toHaveLength(jobs.length);
    });
  });

  // =========================================================================
  // Status filtering
  // =========================================================================
  describe('statusFilter', () => {
    /**
     * Test: Status filter returns only matching jobs
     * Reasoning: Core feature; multiple jobs with same status must all appear
     */
    it('should return only jobs matching the given status', () => {
      const result = filterJobs(jobs, 'applied', '');
      expect(result).toHaveLength(2);
      expect(result.every(j => j.status === 'applied')).toBe(true);
    });

    /**
     * Test: Status that matches nothing returns empty array
     * Reasoning: UI needs to show "no results" correctly
     */
    it('should return empty array when no jobs match the status', () => {
      expect(filterJobs(jobs, 'offer', '')).toHaveLength(0);
    });

    /**
     * Test: null statusFilter skips status filtering
     * Reasoning: null is the default; must behave as "all statuses"
     */
    it('should not filter by status when statusFilter is null', () => {
      expect(filterJobs(jobs, null, '')).toHaveLength(jobs.length);
    });

    /**
     * Test: Empty string statusFilter skips status filtering
     * Reasoning: '' is falsy; same contract as null — "all statuses"
     */
    it('should not filter by status when statusFilter is empty string', () => {
      expect(filterJobs(jobs, '', '')).toHaveLength(jobs.length);
    });
  });

  // =========================================================================
  // Search query filtering
  // =========================================================================
  describe('searchQuery', () => {
    /**
     * Test: Exact (lowercased) company name matches correctly
     * Reasoning: Happy path for search; must return all companies containing the term
     */
    it('should return all jobs whose company includes the search query', () => {
      const result = filterJobs(jobs, null, 'google');
      expect(result).toHaveLength(2);
      expect(result.map(j => j.id)).toEqual([1, 5]);
    });

    /**
     * Test: Partial substring matches are returned
     * Reasoning: Users rarely type the full company name; substring search is the contract
     */
    it('should match partial substrings of the company name', () => {
      const result = filterJobs(jobs, null, 'gle');
      expect(result).toHaveLength(2); // 'Google', 'Google Cloud'
    });

    /**
     * Test: Search is case-insensitive when the query is uppercase
     * Reasoning: Users may type in caps; casing must never affect results
     */
    it('should match case-insensitively with an uppercase query', () => {
      const result = filterJobs(jobs, null, 'APPLE');
      expect(result).toHaveLength(1);
      expect(result[0].company).toBe('Apple');
    });

    /**
     * Test: Search is case-insensitive when the company name has mixed case
     * Reasoning: DB data may have inconsistent casing; must still match
     */
    it('should match case-insensitively against a mixed-case company name', () => {
      const mixedCase = [{ id: 99, company: 'GoOgLe', status: 'applied' }];
      expect(filterJobs(mixedCase, null, 'google')).toHaveLength(1);
    });

    /**
     * Test: Leading and trailing whitespace in the query is trimmed
     * Reasoning: Input fields often send padded strings; trim must happen before match
     */
    it('should trim whitespace from the search query before matching', () => {
      const result = filterJobs(jobs, null, '  google  ');
      expect(result).toHaveLength(2);
    });

    /**
     * Test: Whitespace-only query is treated as no filter
     * Reasoning: .trim() returns '' for whitespace-only input; this is falsy and must
     * behave like an empty string, not as a filter that matches nothing
     */
    it('should return all jobs when searchQuery is whitespace only', () => {
      expect(filterJobs(jobs, null, '   ')).toHaveLength(jobs.length);
    });

    /**
     * Test: Query with no matches returns empty array
     * Reasoning: UI needs to show "no results" when search finds nothing
     */
    it('should return empty array when search query matches no companies', () => {
      expect(filterJobs(jobs, null, 'Netflix')).toHaveLength(0);
    });

    /**
     * Test: null searchQuery does not throw and returns all jobs
     * Reasoning: Callers may pass null before the user has typed anything
     */
    it('should return all jobs when searchQuery is null', () => {
      expect(filterJobs(jobs, null, null)).toHaveLength(jobs.length);
    });
  });

  // =========================================================================
  // Combined status + search
  // =========================================================================
  describe('combined statusFilter and searchQuery', () => {
    /**
     * Test: Both filters are ANDed — only jobs satisfying both conditions returned
     * Reasoning: Selecting a status tab while typing in the search box must narrow
     * results, not widen them
     */
    it('should apply status and search as AND conditions', () => {
      // 'Google' = applied, 'Google Cloud' = interviewing
      const result = filterJobs(jobs, 'interviewing', 'google');
      expect(result).toHaveLength(1);
      expect(result[0].company).toBe('Google Cloud');
    });

    /**
     * Test: Combined filters can yield an empty result
     * Reasoning: No jobs match 'rejected' + 'google'; empty is the correct result
     */
    it('should return empty array when combined filters match nothing', () => {
      const result = filterJobs(jobs, 'rejected', 'google');
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    /**
     * Test: Empty jobs list returns empty array regardless of filters
     * Reasoning: Initial state before fetch completes; must not throw
     */
    it('should return empty array when jobs list is empty', () => {
      expect(filterJobs([], 'applied', 'google')).toHaveLength(0);
    });

    /**
     * Test: Original jobs array is not mutated
     * Reasoning: useMemo correctness depends on reference stability — mutating the
     * source array would break React's change detection
     */
    it('should not mutate the original jobs array', () => {
      const original = [...jobs];
      filterJobs(jobs, 'applied', 'google');
      expect(jobs).toEqual(original);
    });
  });
});
