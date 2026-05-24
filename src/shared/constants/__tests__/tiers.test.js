const { TIERS, TIER_LIMITS, OPERATIONS } = require('../tiers.js');

describe('billing tier invariants', () => {
  it('defines explicit baseline paid limits for existing app operations', () => {
    expect(TIER_LIMITS[TIERS.PAID]).toMatchObject({
      [OPERATIONS.INSERT]: { hourly: null, daily: 1000 },
      [OPERATIONS.UPDATE]: { hourly: null, daily: 10000 },
      [OPERATIONS.READ]: { hourly: null, daily: 50000 },
      [OPERATIONS.DELETE]: { hourly: null, daily: null },
      [OPERATIONS.AUTH]: { hourly: 15, daily: 30 },
      [OPERATIONS.HEALTH]: { hourly: 60, daily: null },
      storage: { maxJobs: 3000, autoDeleteOldest: false },
    });
  });

  it('defines paid billing_read limits that are at least as permissive as free billing_read limits', () => {
    expect(TIER_LIMITS[TIERS.PAID]).toHaveProperty(OPERATIONS.BILLING_READ);
    expect(TIER_LIMITS[TIERS.FREE]).toHaveProperty(OPERATIONS.BILLING_READ);

    const paid = TIER_LIMITS[TIERS.PAID][OPERATIONS.BILLING_READ];
    const free = TIER_LIMITS[TIERS.FREE][OPERATIONS.BILLING_READ];

    expect(paid.hourly).toBeGreaterThanOrEqual(free.hourly);
    expect(paid.daily).toBeGreaterThanOrEqual(free.daily);
  });

  it('defines paid billing_write limits that are at least as permissive as free billing_write limits', () => {
    expect(TIER_LIMITS[TIERS.PAID]).toHaveProperty(OPERATIONS.BILLING_WRITE);
    expect(TIER_LIMITS[TIERS.FREE]).toHaveProperty(OPERATIONS.BILLING_WRITE);

    const paid = TIER_LIMITS[TIERS.PAID][OPERATIONS.BILLING_WRITE];
    const free = TIER_LIMITS[TIERS.FREE][OPERATIONS.BILLING_WRITE];

    expect(paid.hourly).toBeGreaterThanOrEqual(free.hourly);
    expect(paid.daily).toBeGreaterThanOrEqual(free.daily);
  });

  it('pins the raised billing_write limits for free and paid tiers', () => {
    expect(TIER_LIMITS[TIERS.FREE][OPERATIONS.BILLING_WRITE]).toEqual({
      hourly: 60,
      daily: 180,
    });
    expect(TIER_LIMITS[TIERS.PAID][OPERATIONS.BILLING_WRITE]).toEqual({
      hourly: 60,
      daily: 180,
    });
  });

  it('requires explicit billing limits on both free and paid tiers', () => {
    for (const tier of [TIERS.FREE, TIERS.PAID]) {
      expect(TIER_LIMITS[tier]).toHaveProperty(OPERATIONS.BILLING_READ);
      expect(TIER_LIMITS[tier]).toHaveProperty(OPERATIONS.BILLING_WRITE);
    }
  });

  it('keeps paid storage limits above free storage limits', () => {
    expect(TIER_LIMITS[TIERS.PAID].storage.maxJobs).toBeGreaterThan(
      TIER_LIMITS[TIERS.FREE].storage.maxJobs
    );
  });
});
