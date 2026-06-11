const {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_ERRORS,
  JOB_STORAGE_QUERY_STATES,
  JOB_STORAGE_STATES,
  LOCKED_BULK_DELETE_ROW_LIMIT,
} = require('../storage.js');

describe('storage constants', () => {
  it('keeps the named paid-to-free storage limits explicit', () => {
    expect(FREE_ACTIVE_JOB_LIMIT).toBe(300);
    expect(ABSOLUTE_RETAINED_JOB_LIMIT).toBe(3000);
    expect(LOCKED_BULK_DELETE_ROW_LIMIT).toBe(
      ABSOLUTE_RETAINED_JOB_LIMIT - FREE_ACTIVE_JOB_LIMIT
    );
  });

  it('names only the v1 job storage states', () => {
    expect(JOB_STORAGE_STATES).toEqual({
      ACTIVE: 'active',
      LOCKED_OVER_PLAN_LIMIT: 'locked_over_plan_limit',
    });
  });

  it('names the locked archive query and error vocabulary', () => {
    expect(JOB_STORAGE_QUERY_STATES).toEqual({
      LOCKED: 'locked',
    });
    expect(JOB_STORAGE_ERRORS).toEqual({
      JOB_LOCKED_BY_PLAN: 'JOB_LOCKED_BY_PLAN',
    });
  });
});
