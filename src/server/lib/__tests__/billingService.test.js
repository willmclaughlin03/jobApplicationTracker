const crypto = require('crypto');
const { TIERS } = require('../../../shared/constants/tiers.js');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const { BILLING_ENTITLEMENTS } = require('../../../shared/constants/billing.js');

const TEST_BILLING_LOG_HASH_SECRET = 'billing-log-secret-test';
process.env.BILLING_LOG_HASH_SECRET = TEST_BILLING_LOG_HASH_SECRET;

let mockStripeMode = 'test';

const mockStripe = {
  customers: {
    create: jest.fn(),
  },
  subscriptions: {
    retrieve: jest.fn(),
  },
};

const mockSupabaseAdmin = {
  from: jest.fn(),
  rpc: jest.fn(),
};

jest.mock('../stripe.js', () => ({
  stripe: mockStripe,
  getConfiguredStripeMode: () => mockStripeMode,
}));

jest.mock('../supabaseServer.js', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

const {
  BILLING_SYNC_MODES,
  BILLING_WRITE_OUTCOMES,
  STRIPE_EVENT_RECEIPT_RESULTS,
  classifyStripeStatus,
  formatStripeIdForLog,
  getEntitledPriceIdAllowlist,
  getLocalBillingStatus,
  getLocalBillingStatusPrivileged,
  getOrCreateStripeCustomer,
  hasCanonicalBillingEntitlement,
  hashUserIdForIdempotency,
  hashUserIdForLog,
  markSubscriptionDeletedFromEvent,
  recordStripeEventReceipt,
  redactStripeId,
  resolveStorageEntitlement,
  resolveStorageEntitlementPrivileged,
  resolveTailorEntitlement,
  resolveTailorEntitlementPrivileged,
  syncSubscriptionFromStripe,
} = require('../billingService.js');

function createQueryBuilder(plan = {}) {
  const state = {
    selectArgs: [],
    eqArgs: [],
    isArgs: [],
    insertPayload: undefined,
    updatePayload: undefined,
    upsertPayload: undefined,
    upsertOptions: undefined,
  };

  function runTerminal(name) {
    const terminalPlan = plan[name];

    if (terminalPlan instanceof Error) {
      return Promise.reject(terminalPlan);
    }

    if (typeof terminalPlan === 'function') {
      return Promise.resolve().then(() => terminalPlan(state));
    }

    return Promise.resolve(terminalPlan ?? { data: null, error: null });
  }

  const query = {
    select: jest.fn((...args) => {
      state.selectArgs.push(args);
      return query;
    }),
    eq: jest.fn((...args) => {
      state.eqArgs.push(args);
      return query;
    }),
    is: jest.fn((...args) => {
      state.isArgs.push(args);
      return query;
    }),
    insert: jest.fn((payload) => {
      state.insertPayload = payload;
      return query;
    }),
    update: jest.fn((payload) => {
      state.updatePayload = payload;
      return query;
    }),
    upsert: jest.fn((payload, options) => {
      state.upsertPayload = payload;
      state.upsertOptions = options;
      return query;
    }),
    maybeSingle: jest.fn(() => runTerminal('maybeSingle')),
    single: jest.fn(() => runTerminal('single')),
  };

  return { query, state };
}

function createSupabaseClient(config = {}) {
  const tablePlansSource = config.tables
    ?? Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'rpc'));
  const rpcPlansSource = config.rpc ?? {};

  const tablePlanQueues = Object.fromEntries(
    Object.entries(tablePlansSource).map(([table, plans]) => [
      table,
      Array.isArray(plans) ? [...plans] : [plans],
    ])
  );
  const rpcPlanQueues = Object.fromEntries(
    Object.entries(rpcPlansSource).map(([fnName, plans]) => [
      fnName,
      Array.isArray(plans) ? [...plans] : [plans],
    ])
  );

  const buildersByTable = {};
  const rpcCallsByName = {};

  return {
    from: jest.fn((table) => {
      const queue = tablePlanQueues[table];

      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected query for table ${table}`);
      }

      const builder = createQueryBuilder(queue.shift());

      if (!buildersByTable[table]) {
        buildersByTable[table] = [];
      }

      buildersByTable[table].push(builder);
      return builder.query;
    }),
    rpc: jest.fn((fnName, args) => {
      const queue = rpcPlanQueues[fnName];

      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected rpc call for function ${fnName}`);
      }

      const plan = queue.shift();
      const state = { fnName, args };

      if (!rpcCallsByName[fnName]) {
        rpcCallsByName[fnName] = [];
      }

      rpcCallsByName[fnName].push(state);

      if (plan instanceof Error) {
        return Promise.reject(plan);
      }

      if (typeof plan === 'function') {
        return Promise.resolve().then(() => plan(state));
      }

      return Promise.resolve(plan ?? { data: null, error: null });
    }),
    buildersByTable,
    rpcCallsByName,
  };
}

function useAdminClient(client) {
  mockSupabaseAdmin.from.mockImplementation(client.from);
  mockSupabaseAdmin.rpc.mockImplementation(client.rpc);
  return client;
}

function buildExpectedLogHash(userId) {
  return crypto
    .createHmac('sha256', TEST_BILLING_LOG_HASH_SECRET)
    .update(userId)
    .digest('hex');
}

describe('billingService', () => {
  const originalLogFullBillingIds = process.env.LOG_FULL_BILLING_IDS;
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockStripeMode = 'test';
    delete process.env.LOG_FULL_BILLING_IDS;
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
  });

  afterAll(() => {
    if (originalLogFullBillingIds === undefined) {
      delete process.env.LOG_FULL_BILLING_IDS;
    } else {
      process.env.LOG_FULL_BILLING_IDS = originalLogFullBillingIds;
    }
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

  describe('status classification and logging helpers', () => {
    it('classifies supported and rejected Stripe statuses without widening the allowlist', () => {
      expect(classifyStripeStatus('active')).toEqual({
        normalizedStatus: 'active',
        isSupported: true,
      });
      expect(classifyStripeStatus('trialing')).toEqual({
        normalizedStatus: 'trialing',
        isSupported: false,
      });
      expect(classifyStripeStatus('   ')).toEqual({
        normalizedStatus: '',
        isSupported: false,
      });
    });

    it('redacts Stripe ids by default in test mode but allows full ids at error/debug', () => {
      expect(redactStripeId('cus_1234567890')).toBe('cus_***7890');
      expect(formatStripeIdForLog('sub_1234567890', 'info')).toBe('sub_***7890');
      expect(formatStripeIdForLog('sub_1234567890', 'warn')).toBe('sub_***7890');
      expect(formatStripeIdForLog('sub_1234567890', 'error')).toBe('sub_1234567890');
      expect(formatStripeIdForLog('sub_1234567890', 'debug')).toBe('sub_1234567890');
    });

    it('redacts Stripe ids at every level in live mode unless LOG_FULL_BILLING_IDS=true', () => {
      mockStripeMode = 'live';

      expect(formatStripeIdForLog('evt_1234567890', 'error')).toBe('evt_***7890');
      expect(formatStripeIdForLog('evt_1234567890', 'debug')).toBe('evt_***7890');

      process.env.LOG_FULL_BILLING_IDS = 'true';

      expect(formatStripeIdForLog('evt_1234567890', 'error')).toBe('evt_1234567890');
      expect(formatStripeIdForLog('evt_1234567890', 'debug')).toBe('evt_1234567890');
      expect(formatStripeIdForLog('evt_1234567890', 'info')).toBe('evt_***7890');
      expect(formatStripeIdForLog('evt_1234567890', 'warn')).toBe('evt_***7890');
    });

    it('uses separate log and idempotency hashes', () => {
      const userId = 'user-123';

      expect(hashUserIdForLog(userId)).toBe(buildExpectedLogHash(userId));
      expect(hashUserIdForIdempotency(userId)).toBe(
        crypto.createHash('sha256').update(userId).digest('hex')
      );
      expect(hashUserIdForLog(userId)).not.toBe(hashUserIdForIdempotency(userId));
      expect(hashUserIdForIdempotency(null)).toEqual(expect.any(String));
    });
  });

  describe('getLocalBillingStatus', () => {
    const userId = 'user-123';

    it('reads canonical local billing state with a caller-provided client only', async () => {
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_local_123' },
            error: null,
          },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_local_123',
              stripe_customer_id: 'cus_local_123',
              price_id: 'price_tailor_monthly',
              status: 'active',
              current_period_end: '2026-05-01T00:00:00.000Z',
              cancel_at_period_end: false,
            },
            error: null,
          },
        },
      });

      const status = await getLocalBillingStatus(userId, client, mockLog);

      expect(status).toEqual(
        expect.objectContaining({
          hasCustomerMapping: true,
          hasSubscription: true,
          entitled: true,
          entitlement: BILLING_ENTITLEMENTS.AI_TAILOR,
          tier: TIERS.PAID,
          stripeCustomerId: 'cus_local_123',
          stripeSubscriptionId: 'sub_local_123',
          priceId: 'price_tailor_monthly',
          status: 'active',
        })
      );
      expect(client.from).toHaveBeenCalledWith('billing_customers');
      expect(client.from).toHaveBeenCalledWith('billing_subscriptions');
      expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
    });

    it('fails closed when the request-scoped client is missing or invalid', async () => {
      const status = await getLocalBillingStatus(userId, null, mockLog);

      expect(status.tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'getLocalBillingStatus',
          hasUserId: true,
          hasSupabaseClient: false,
        }),
        'Billing status resolver is missing a request-scoped Supabase client'
      );
    });

    it('fails closed when a billing read errors and keeps userId out of logs', async () => {
      const dbError = new Error('billing read failed');
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_123' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: dbError },
        },
      });

      const status = await getLocalBillingStatus(userId, client, mockLog);

      expect(status.tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: dbError,
          operation: 'getLocalBillingStatus',
          userIdHash: buildExpectedLogHash(userId),
        }),
        'Failed to load local billing status'
      );
      expect(JSON.stringify(mockLog.error.mock.calls[0][0])).not.toContain(userId);
    });

    it('has a privileged wrapper that explicitly routes through supabaseAdmin', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_privileged' },
            error: null,
          },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_privileged',
              stripe_customer_id: 'cus_privileged',
              price_id: 'price_tailor_monthly',
              status: 'active',
              cancel_at_period_end: false,
            },
            error: null,
          },
        },
      }));

      const status = await getLocalBillingStatusPrivileged(userId, mockLog);

      expect(status.tier).toBe(TIERS.PAID);
      expect(adminClient.from).toHaveBeenCalled();
    });
  });

  describe('resolveStorageEntitlement', () => {
    const userId = 'user-storage';

    it('returns paid for an allowlisted active subscription', async () => {
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_123' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: { price_id: 'price_tailor_monthly', status: 'active' },
            error: null,
          },
        },
      });

      const tier = await resolveStorageEntitlement(userId, client, mockLog);

      expect(tier).toBe(TIERS.PAID);
    });

    it.each([
      'past_due',
      'unpaid',
      'canceled',
      'paused',
      'incomplete',
      'incomplete_expired',
      'trialing',
    ])('returns free for non-entitled billing status %s', async (status) => {
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_123' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: { price_id: 'price_tailor_monthly', status },
            error: null,
          },
        },
      });

      const tier = await resolveStorageEntitlement(userId, client, mockLog);

      expect(tier).toBe(TIERS.FREE);
    });

    it('fails closed to free when the request-scoped client is missing', async () => {
      const tier = await resolveStorageEntitlement(userId, null, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'getLocalBillingStatus',
          hasSupabaseClient: false,
        }),
        'Billing status resolver is missing a request-scoped Supabase client'
      );
    });

    it('has a privileged wrapper that routes through supabaseAdmin and preserves fail-closed behavior', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: null, error: new Error('read failed') },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: null },
        },
      }));

      const tier = await resolveStorageEntitlementPrivileged(userId, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'getLocalBillingStatus',
          userIdHash: buildExpectedLogHash(userId),
        }),
        'Failed to load local billing status'
      );
    });
  });

  describe('resolveTailorEntitlement', () => {
    const userId = 'user-tailor';

    it('returns the AI tailor entitlement for an allowlisted active subscription', async () => {
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_tailor' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_tailor',
              stripe_customer_id: 'cus_tailor',
              price_id: 'price_tailor_monthly',
              status: 'active',
              cancel_at_period_end: false,
            },
            error: null,
          },
        },
      });

      const result = await resolveTailorEntitlement(userId, client, mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          entitled: true,
          entitlement: BILLING_ENTITLEMENTS.AI_TAILOR,
          code: null,
          message: null,
        })
      );
    });

    it('returns payment recovery guidance for past_due subscriptions', async () => {
      const client = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_tailor' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_tailor',
              stripe_customer_id: 'cus_tailor',
              price_id: 'price_tailor_monthly',
              status: 'past_due',
            },
            error: null,
          },
        },
      });

      const result = await resolveTailorEntitlement(userId, client, mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          entitled: false,
          code: 'PAYMENT_METHOD_UPDATE_REQUIRED',
          message: ERROR_MESSAGES.PAYMENT_METHOD_UPDATE_REQUIRED,
        })
      );
    });

    it('has a privileged wrapper that explicitly routes through supabaseAdmin', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_tailor' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: null },
        },
      }));

      const result = await resolveTailorEntitlementPrivileged(userId, mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          entitled: false,
          code: 'BILLING_SYNC_PENDING',
          message: ERROR_MESSAGES.BILLING_SYNC_PENDING,
        })
      );
    });
  });

  describe('getOrCreateStripeCustomer', () => {
    const userId = 'user-create-customer';

    it('uses the canonical local customer mapping before any Stripe call', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_existing_123' },
            error: null,
          },
        },
      }));

      const result = await getOrCreateStripeCustomer(userId, 'test@example.com', mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          userId,
          stripeCustomerId: 'cus_existing_123',
          createdInStripe: false,
          createdPlaceholder: false,
        })
      );
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
    });

    it('creates a placeholder row before persisting a new Stripe customer id and uses deterministic idempotency hashing', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: [
          {
            maybeSingle: { data: null, error: null },
          },
          {
            maybeSingle: { data: { user_id: userId, stripe_customer_id: null }, error: null },
          },
          {
            maybeSingle: {
              data: { user_id: userId, stripe_customer_id: 'cus_new_123' },
              error: null,
            },
          },
        ],
      }));
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new_123' });

      const result = await getOrCreateStripeCustomer(userId, 'test@example.com', mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          userId,
          stripeCustomerId: 'cus_new_123',
          createdInStripe: true,
          createdPlaceholder: true,
        })
      );
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        { email: 'test@example.com' },
        {
          idempotencyKey: `billing_customer_${hashUserIdForIdempotency(userId).slice(0, 24)}`,
        }
      );
      expect(adminClient.buildersByTable.billing_customers[1].state.upsertPayload).toEqual({
        user_id: userId,
      });
      expect(adminClient.buildersByTable.billing_customers[2].state.updatePayload).toEqual({
        stripe_customer_id: 'cus_new_123',
      });
    });
  });

  describe('syncSubscriptionFromStripe', () => {
    const userId = 'user-sync';

    it('reconciles event-driven subscription updates through the event RPC', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_sync_123' },
            error: null,
          },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: null },
        },
        rpc: {
          upsert_billing_subscription_if_newer_or_equal: {
            data: {
              applied: true,
              subscription: {
                user_id: userId,
                stripe_subscription_id: 'sub_sync_123',
                stripe_customer_id: 'cus_sync_123',
                price_id: 'price_tailor_monthly',
                status: 'active',
                current_period_end: '2029-11-23T00:00:00.000Z',
                cancel_at_period_end: false,
                last_stripe_event_created: '2029-11-14T00:00:00.000Z',
              },
            },
            error: null,
          },
        },
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        livemode: false,
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { mode: BILLING_SYNC_MODES.EVENT, eventCreated: '2029-11-14T00:00:00.000Z' },
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
          userId,
        })
      );
      expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_sync_123', {
        expand: ['customer', 'items.data.price'],
      });
      expect(adminClient.rpcCallsByName.upsert_billing_subscription_if_newer_or_equal[0].args).toEqual({
        payload: {
          user_id: userId,
          stripe_subscription_id: 'sub_sync_123',
          stripe_customer_id: 'cus_sync_123',
          price_id: 'price_tailor_monthly',
          status: 'active',
          current_period_end: '2029-11-20T00:00:00.000Z',
          cancel_at_period_end: false,
          last_stripe_event_created: '2029-11-14T00:00:00.000Z',
        },
      });
    });

    it('reconciles authoritative subscription updates through the authoritative RPC', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_sync_123' },
            error: null,
          },
        },
        rpc: {
          upsert_billing_subscription_authoritative: {
            data: {
              subscription: {
                user_id: userId,
                stripe_subscription_id: 'sub_sync_123',
                stripe_customer_id: 'cus_sync_123',
                price_id: 'price_tailor_monthly',
                status: 'active',
                current_period_end: '2029-11-23T00:00:00.000Z',
                cancel_at_period_end: false,
                last_stripe_event_created: '2029-11-10T00:00:00.000Z',
              },
            },
            error: null,
          },
        },
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        livemode: false,
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { mode: BILLING_SYNC_MODES.AUTHORITATIVE },
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
          userId,
        })
      );
      expect(adminClient.rpcCallsByName.upsert_billing_subscription_authoritative[0].args).toEqual({
        payload: {
          user_id: userId,
          stripe_subscription_id: 'sub_sync_123',
          stripe_customer_id: 'cus_sync_123',
          price_id: 'price_tailor_monthly',
          status: 'active',
          current_period_end: '2029-11-20T00:00:00.000Z',
          cancel_at_period_end: false,
        },
      });
    });

    it('keeps the JS stale-event check as a fast-path optimization', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_sync_123' },
            error: null,
          },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_sync_123',
              stripe_customer_id: 'cus_sync_123',
              price_id: 'price_tailor_monthly',
              status: 'active',
              last_stripe_event_created: '2029-11-15T00:00:00.000Z',
            },
            error: null,
          },
        },
        rpc: {},
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        livemode: false,
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { mode: BILLING_SYNC_MODES.EVENT, eventCreated: '2029-11-10T00:00:00.000Z' },
        mockLog
      );

      expect(result.outcome).toBe(STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED);
      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'syncSubscriptionFromStripe',
          stripeSubscriptionId: formatStripeIdForLog('sub_sync_123', 'info'),
        }),
        'Ignoring stale Stripe subscription event during sync'
      );
    });

    it('returns unsupported_status_ignored without touching billing tables and emits a structured monitoring log', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_sync_123' },
            error: null,
          },
        },
        rpc: {},
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'trialing',
        livemode: false,
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { mode: BILLING_SYNC_MODES.AUTHORITATIVE },
        mockLog
      );

      expect(result.outcome).toBe(BILLING_WRITE_OUTCOMES.UNSUPPORTED_STATUS_IGNORED);
      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing_unsupported_status',
          operation: 'syncSubscriptionFromStripe',
          userIdHash: buildExpectedLogHash(userId),
          status: 'trialing',
          stripeSubscriptionId: 'sub_sync_123',
        }),
        'Skipped billing write for unsupported Stripe subscription status'
      );
    });

    it('rejects livemode mismatches before any billing-table read or write', async () => {
      mockStripeMode = 'test';
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        livemode: true,
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      await expect(
        syncSubscriptionFromStripe(
          'sub_sync_123',
          { mode: BILLING_SYNC_MODES.AUTHORITATIVE },
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_LIVEMODE_MISMATCH' });

      expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing_livemode_mismatch',
          expectedLivemode: false,
          receivedLivemode: true,
          stripeSubscriptionId: 'sub_sync_123',
        }),
        'Rejected Stripe billing work for the wrong livemode'
      );
    });

    it('rejects deleted Stripe customer objects through the missing-customer path', async () => {
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: { id: 'cus_deleted_123', deleted: true },
        status: 'active',
        livemode: false,
        items: { data: [{ price: { id: 'price_tailor_monthly' } }] },
      });

      await expect(
        syncSubscriptionFromStripe(
          'sub_sync_123',
          { mode: BILLING_SYNC_MODES.AUTHORITATIVE },
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_CUSTOMER_ID_MISSING' });
    });
  });

  describe('recordStripeEventReceipt', () => {
    it('validates receipt input before the RPC merge and returns the RPC result shape', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        rpc: {
          merge_stripe_event_receipt: {
            data: {
              outcome: 'recorded',
              receipt: {
                event_id: 'evt_new_123',
                event_type: 'invoice.paid',
                livemode: false,
                stripe_event_created: '2029-11-14T00:00:00.000Z',
                result: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
              },
            },
            error: null,
          },
        },
      }));

      const result = await recordStripeEventReceipt(
        {
          id: 'evt_new_123',
          type: 'invoice.paid',
          livemode: false,
          created: '2029-11-14T00:00:00.000Z',
        },
        STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'recorded',
          receipt: expect.objectContaining({
            event_id: 'evt_new_123',
            result: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
          }),
        })
      );
      expect(adminClient.rpcCallsByName.merge_stripe_event_receipt[0].args).toEqual({
        p_event_id: 'evt_new_123',
        p_event_type: 'invoice.paid',
        p_livemode: false,
        p_stripe_event_created: '2029-11-14T00:00:00.000Z',
        p_result: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
      });
    });

    it('rejects livemode mismatches before the receipt RPC is called', async () => {
      mockStripeMode = 'test';

      await expect(
        recordStripeEventReceipt(
          {
            id: 'evt_live_123',
            type: 'invoice.paid',
            livemode: true,
            created: '2029-11-14T00:00:00.000Z',
          },
          STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED,
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_LIVEMODE_MISMATCH' });

      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing_livemode_mismatch',
          stripeEventId: 'evt_live_123',
        }),
        'Rejected Stripe billing work for the wrong livemode'
      );
    });

    it('keeps zod validation in JS before the RPC', async () => {
      await expect(
        recordStripeEventReceipt(
          { id: '', type: '', livemode: false, created: null },
          STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED,
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_INVALID_INPUT' });

      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
    });
  });

  describe('markSubscriptionDeletedFromEvent', () => {
    const userId = 'user-delete';

    it('preserves a safe local terminal snapshot through the event RPC', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_delete_123' },
            error: null,
          },
        },
        billing_subscriptions: {
          maybeSingle: {
            data: {
              user_id: userId,
              stripe_subscription_id: 'sub_delete_123',
              stripe_customer_id: 'cus_delete_123',
              price_id: 'price_tailor_monthly',
              status: 'active',
              current_period_end: '2029-11-30T00:00:00.000Z',
              cancel_at_period_end: false,
              last_stripe_event_created: '2029-11-10T00:00:00.000Z',
            },
            error: null,
          },
        },
        rpc: {
          upsert_billing_subscription_if_newer_or_equal: {
            data: {
              applied: true,
              subscription: {
                user_id: userId,
                stripe_subscription_id: 'sub_delete_123',
                stripe_customer_id: 'cus_delete_123',
                price_id: 'price_tailor_monthly',
                status: 'canceled',
                current_period_end: '2029-11-30T00:00:00.000Z',
                cancel_at_period_end: true,
                last_stripe_event_created: '2029-11-14T00:00:00.000Z',
              },
            },
            error: null,
          },
        },
      }));

      const result = await markSubscriptionDeletedFromEvent(
        {
          id: 'sub_delete_123',
          customer: 'cus_delete_123',
          cancel_at_period_end: true,
          current_period_end: null,
          items: { data: [] },
        },
        { eventCreated: '2029-11-14T00:00:00.000Z', livemode: false },
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
          userId,
          localSubscription: expect.objectContaining({
            status: 'canceled',
          }),
        })
      );
      expect(adminClient.rpcCallsByName.upsert_billing_subscription_if_newer_or_equal[0].args).toEqual({
        payload: {
          user_id: userId,
          stripe_subscription_id: 'sub_delete_123',
          stripe_customer_id: 'cus_delete_123',
          price_id: 'price_tailor_monthly',
          status: 'canceled',
          current_period_end: '2029-11-30T00:00:00.000Z',
          cancel_at_period_end: true,
          last_stripe_event_created: '2029-11-14T00:00:00.000Z',
        },
      });
    });

    it('rejects livemode mismatches before any billing-table read or write', async () => {
      await expect(
        markSubscriptionDeletedFromEvent(
          {
            id: 'sub_delete_123',
            customer: 'cus_delete_123',
          },
          { eventCreated: '2029-11-14T00:00:00.000Z', livemode: true },
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_LIVEMODE_MISMATCH' });

      expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
      expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing_livemode_mismatch',
          stripeSubscriptionId: 'sub_delete_123',
        }),
        'Rejected Stripe billing work for the wrong livemode'
      );
    });

    it('rejects deleted Stripe customer objects through the missing-customer path', async () => {
      await expect(
        markSubscriptionDeletedFromEvent(
          {
            id: 'sub_delete_123',
            customer: { id: 'cus_deleted_123', deleted: true },
          },
          { eventCreated: '2029-11-14T00:00:00.000Z', livemode: false },
          mockLog
        )
      ).rejects.toMatchObject({ code: 'BILLING_CUSTOMER_ID_MISSING' });
    });
  });

  describe('missing BILLING_LOG_HASH_SECRET handling', () => {
    const originalSecret = process.env.BILLING_LOG_HASH_SECRET;

    afterEach(() => {
      jest.resetModules();
      jest.clearAllMocks();
      process.env.BILLING_LOG_HASH_SECRET = originalSecret;
    });

    it('warns once at module init, returns null log hashes, and keeps downstream logging working', async () => {
      delete process.env.BILLING_LOG_HASH_SECRET;

      const isolatedLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };
      const isolatedSupabaseAdmin = {
        from: jest.fn(),
        rpc: jest.fn(),
      };
      const isolatedStripe = {
        customers: { create: jest.fn() },
        subscriptions: { retrieve: jest.fn() },
      };

      let isolatedModule;

      jest.isolateModules(() => {
        jest.doMock('../../../shared/logger.js', () => ({
          logger: isolatedLogger,
        }));
        jest.doMock('../stripe.js', () => ({
          stripe: isolatedStripe,
          getConfiguredStripeMode: () => 'test',
        }));
        jest.doMock('../supabaseServer.js', () => ({
          supabaseAdmin: isolatedSupabaseAdmin,
        }));

        isolatedModule = require('../billingService.js');
      });

      expect(isolatedLogger.warn).toHaveBeenCalledTimes(1);
      expect(isolatedModule.hashUserIdForLog('user-missing-secret')).toBeNull();

      const failingClient = {
        from: jest.fn((table) => ({
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue(
                table === 'billing_customers'
                  ? { data: { user_id: 'user-missing-secret', stripe_customer_id: 'cus_123' }, error: null }
                  : { data: null, error: new Error('forced read failure') }
              ),
            })),
          })),
        })),
      };

      const runtimeLog = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const tier = await isolatedModule.resolveStorageEntitlement(
        'user-missing-secret',
        failingClient,
        runtimeLog
      );

      expect(tier).toBe(TIERS.FREE);
      expect(runtimeLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'getLocalBillingStatus',
          userIdHash: null,
        }),
        'Failed to load local billing status'
      );
    });
  });
});
