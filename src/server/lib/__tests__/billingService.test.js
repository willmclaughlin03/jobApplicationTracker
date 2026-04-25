const crypto = require('crypto');
const { TIERS } = require('../../../shared/constants/tiers.js');

const {
  getEntitledPriceIdAllowlist,
  hasCanonicalBillingEntitlement,
  resolveStorageEntitlement,
} = require('../billingService.js');

function createSupabaseClient(result) {
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    maybeSingle: jest.fn(),
  };

  if (result instanceof Error) {
    query.maybeSingle.mockRejectedValue(result);
  } else {
    query.maybeSingle.mockResolvedValue(result);
  }

  return {
    from: jest.fn(() => query),
    query,
  };
}

describe('billingService', () => {
  const originalPriceEnv = process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY;
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
  });

  afterAll(() => {
    if (originalPriceEnv === undefined) {
      delete process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY;
      return;
    }

    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = originalPriceEnv;
  });

  describe('getEntitledPriceIdAllowlist', () => {
    it('returns configured Stripe price ids for canonical entitlement checks', () => {
      const allowlist = getEntitledPriceIdAllowlist({
        STRIPE_PRICE_RESUME_TAILOR_MONTHLY: 'price_tailor_monthly',
      });

      expect(allowlist).toEqual(new Set(['price_tailor_monthly']));
    });

    it('ignores missing or blank env values', () => {
      const allowlist = getEntitledPriceIdAllowlist({
        STRIPE_PRICE_RESUME_TAILOR_MONTHLY: '   ',
      });

      expect(allowlist.size).toBe(0);
    });
  });

  describe('hasCanonicalBillingEntitlement', () => {
    it('returns true for an allowlisted active subscription', () => {
      expect(
        hasCanonicalBillingEntitlement(
          { price_id: 'price_tailor_monthly', status: 'active' },
          new Set(['price_tailor_monthly'])
        )
      ).toBe(true);
    });

    it('returns false when the price id is not allowlisted', () => {
      expect(
        hasCanonicalBillingEntitlement(
          { price_id: 'price_other', status: 'active' },
          new Set(['price_tailor_monthly'])
        )
      ).toBe(false);
    });
  });

  describe('resolveStorageEntitlement', () => {
    const userId = 'user-123';
    const expectedUserIdHash = crypto.createHash('sha256').update(userId).digest('hex');

    it('returns paid for an allowlisted active subscription', async () => {
      const supabaseClient = createSupabaseClient({
        data: { price_id: 'price_tailor_monthly', status: 'active' },
        error: null,
      });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.PAID);
      expect(supabaseClient.from).toHaveBeenCalledWith('billing_subscriptions');
      expect(supabaseClient.query.select).toHaveBeenCalledWith('price_id, status');
      expect(supabaseClient.query.eq).toHaveBeenCalledWith('user_id', userId);
    });

    it('returns free when no local billing subscription exists', async () => {
      const supabaseClient = createSupabaseClient({ data: null, error: null });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
    });

    it('returns free when the price id is not allowlisted', async () => {
      const supabaseClient = createSupabaseClient({
        data: { price_id: 'price_other', status: 'active' },
        error: null,
      });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
    });

    it.each([
      'trialing',
      'past_due',
      'unpaid',
      'canceled',
      'paused',
      'incomplete',
      'incomplete_expired',
    ])('returns free for non-entitled billing status %s', async (status) => {
      const supabaseClient = createSupabaseClient({
        data: { price_id: 'price_tailor_monthly', status },
        error: null,
      });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
    });

    it('fails closed to free when the billing query errors', async () => {
      const dbError = new Error('billing read failed');
      const supabaseClient = createSupabaseClient({ data: null, error: dbError });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: dbError,
          operation: 'resolveStorageEntitlement',
          userIdHash: expectedUserIdHash,
        }),
        'Failed to load local billing subscription'
      );
      const logData = mockLog.error.mock.calls[0][0];
      expect(logData).not.toHaveProperty('userId');
      expect(JSON.stringify(logData)).not.toContain(userId);
    });

    it('fails closed to free when the billing query throws unexpectedly', async () => {
      const queryError = new Error('billing query threw');
      const supabaseClient = createSupabaseClient(queryError);

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: queryError,
          operation: 'resolveStorageEntitlement',
          userIdHash: expectedUserIdHash,
        }),
        'Unexpected error resolving storage entitlement'
      );
      const logData = mockLog.error.mock.calls[0][0];
      expect(logData).not.toHaveProperty('userId');
      expect(JSON.stringify(logData)).not.toContain(userId);
    });

    it('fails closed to free when the resolver is misconfigured', async () => {
      const tier = await resolveStorageEntitlement(userId, null, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });
});
