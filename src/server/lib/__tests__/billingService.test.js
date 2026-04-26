const crypto = require('crypto');
const { TIERS } = require('../../../shared/constants/tiers.js');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const { BILLING_ENTITLEMENTS } = require('../../../shared/constants/billing.js');

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
};

jest.mock('../stripe.js', () => ({
  stripe: mockStripe,
}));

jest.mock('../supabaseServer.js', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

const {
  STRIPE_EVENT_RECEIPT_RESULTS,
  getEntitledPriceIdAllowlist,
  getLocalBillingStatus,
  getOrCreateStripeCustomer,
  hasCanonicalBillingEntitlement,
  markSubscriptionDeletedFromEvent,
  recordStripeEventReceipt,
  resolveStorageEntitlement,
  resolveTailorEntitlement,
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

function createSupabaseClient(plansByTable) {
  const planQueues = Object.fromEntries(
    Object.entries(plansByTable).map(([table, plans]) => [
      table,
      Array.isArray(plans) ? [...plans] : [plans],
    ])
  );
  const buildersByTable = {};

  return {
    from: jest.fn((table) => {
      const queue = planQueues[table];

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
    buildersByTable,
  };
}

function useAdminClient(client) {
  mockSupabaseAdmin.from.mockImplementation(client.from);
  return client;
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

  describe('getLocalBillingStatus', () => {
    const userId = 'user-123';

    it('reads canonical local billing state with a caller-provided client', async () => {
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
    });
  });

  describe('resolveStorageEntitlement', () => {
    const userId = 'user-123';
    const expectedUserIdHash = crypto.createHash('sha256').update(userId).digest('hex');

    it('returns paid for an allowlisted active subscription', async () => {
      const supabaseClient = createSupabaseClient({
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

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.PAID);
      expect(supabaseClient.buildersByTable.billing_subscriptions[0].state.eqArgs).toEqual([
        ['user_id', userId],
      ]);
    });

    it('returns free when no local billing subscription exists', async () => {
      const supabaseClient = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_123' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: null },
        },
      });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
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
      const supabaseClient = createSupabaseClient({
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

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
    });

    it('fails closed to free when a billing read errors', async () => {
      const dbError = new Error('billing read failed');
      const supabaseClient = createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_123' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: dbError },
        },
      });

      const tier = await resolveStorageEntitlement(userId, supabaseClient, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: dbError,
          operation: 'getLocalBillingStatus',
          userIdHash: expectedUserIdHash,
        }),
        'Failed to load local billing status'
      );
      const logData = mockLog.error.mock.calls[0][0];
      expect(logData).not.toHaveProperty('userId');
      expect(JSON.stringify(logData)).not.toContain(userId);
    });

    it('fails closed to free when the resolver is misconfigured', async () => {
      const tier = await resolveStorageEntitlement(userId, null, mockLog);

      expect(tier).toBe(TIERS.FREE);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'getLocalBillingStatus',
          hasUserId: true,
          hasSupabaseClient: false,
        }),
        'Billing status resolver is missing required inputs'
      );
    });
  });

  describe('resolveTailorEntitlement', () => {
    const userId = 'user-tailor';

    it('returns the AI tailor entitlement for an allowlisted active subscription', async () => {
      useAdminClient(createSupabaseClient({
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
      }));

      const result = await resolveTailorEntitlement(userId, mockLog);

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
      useAdminClient(createSupabaseClient({
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
      }));

      const result = await resolveTailorEntitlement(userId, mockLog);

      expect(result).toEqual(
        expect.objectContaining({
          entitled: false,
          code: 'PAYMENT_METHOD_UPDATE_REQUIRED',
          message: ERROR_MESSAGES.PAYMENT_METHOD_UPDATE_REQUIRED,
        })
      );
    });

    it('returns billing sync pending when a customer mapping exists without a local subscription row', async () => {
      useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: { data: { user_id: userId, stripe_customer_id: 'cus_tailor' }, error: null },
        },
        billing_subscriptions: {
          maybeSingle: { data: null, error: null },
        },
      }));

      const result = await resolveTailorEntitlement(userId, mockLog);

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

    it('creates a placeholder billing customer row before persisting a new Stripe customer id', async () => {
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
        { idempotencyKey: expect.stringMatching(/^billing_customer_/) }
      );
      expect(adminClient.buildersByTable.billing_customers[1].state.upsertPayload).toEqual({
        user_id: userId,
      });
      expect(adminClient.buildersByTable.billing_customers[1].state.upsertOptions).toEqual({
        onConflict: 'user_id',
      });
      expect(adminClient.buildersByTable.billing_customers[2].state.updatePayload).toEqual({
        stripe_customer_id: 'cus_new_123',
      });
      expect(adminClient.buildersByTable.billing_customers[2].state.isArgs).toEqual([
        ['stripe_customer_id', null],
      ]);
    });
  });

  describe('syncSubscriptionFromStripe', () => {
    const userId = 'user-sync';

    it('reconciles the canonical Stripe subscription into billing_subscriptions', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_sync_123' },
            error: null,
          },
        },
        billing_subscriptions: [
          {
            maybeSingle: { data: null, error: null },
          },
          {
            single: {
              data: {
                user_id: userId,
                stripe_subscription_id: 'sub_sync_123',
                stripe_customer_id: 'cus_sync_123',
                price_id: 'price_tailor_monthly',
                status: 'active',
                current_period_end: '2029-11-23T00:00:00.000Z',
                cancel_at_period_end: false,
                last_stripe_event_created: '2029-11-14T00:00:00.000Z',
              },
              error: null,
            },
          },
        ],
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { eventCreated: '2029-11-14T00:00:00.000Z' },
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'processed',
          userId,
        })
      );
      expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_sync_123', {
        expand: ['customer', 'items.data.price'],
      });
      expect(adminClient.buildersByTable.billing_customers[0].state.eqArgs).toEqual([
        ['stripe_customer_id', 'cus_sync_123'],
      ]);
      expect(adminClient.buildersByTable.billing_subscriptions[1].state.upsertPayload).toEqual(
        expect.objectContaining({
          user_id: userId,
          stripe_subscription_id: 'sub_sync_123',
          stripe_customer_id: 'cus_sync_123',
          price_id: 'price_tailor_monthly',
          status: 'active',
          cancel_at_period_end: false,
          last_stripe_event_created: '2029-11-14T00:00:00.000Z',
        })
      );
      expect(adminClient.buildersByTable.billing_subscriptions[1].state.upsertOptions).toEqual({
        onConflict: 'user_id',
      });
    });

    it('ignores older Stripe events so they cannot overwrite newer local subscription state', async () => {
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
      }));
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_sync_123',
        customer: 'cus_sync_123',
        status: 'active',
        current_period_end: 1889827200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: 'price_tailor_monthly' } }],
        },
      });

      const result = await syncSubscriptionFromStripe(
        'sub_sync_123',
        { eventCreated: '2029-11-10T00:00:00.000Z' },
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
          userId,
        })
      );
      expect(mockSupabaseAdmin.from).toHaveBeenCalledTimes(2);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'syncSubscriptionFromStripe',
          stripeSubscriptionId: 'sub_sync_123',
        }),
        'Ignoring stale Stripe subscription event during sync'
      );
    });
  });

  describe('recordStripeEventReceipt', () => {
    it('inserts new canonical receipt rows with allowlisted results', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        stripe_event_receipts: [
          {
            maybeSingle: { data: null, error: null },
          },
          {
            single: {
              data: {
                event_id: 'evt_new_123',
                event_type: 'invoice.paid',
                livemode: false,
                stripe_event_created: '2029-11-14T00:00:00.000Z',
                result: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
              },
              error: null,
            },
          },
        ],
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
      expect(adminClient.buildersByTable.stripe_event_receipts[1].state.insertPayload).toEqual({
        event_id: 'evt_new_123',
        event_type: 'invoice.paid',
        livemode: false,
        stripe_event_created: '2029-11-14T00:00:00.000Z',
        result: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
      });
    });

    it('preserves an existing processed receipt instead of downgrading it to duplicate_ignored', async () => {
      useAdminClient(createSupabaseClient({
        stripe_event_receipts: {
          maybeSingle: {
            data: {
              event_id: 'evt_processed_123',
              event_type: 'customer.subscription.updated',
              livemode: false,
              stripe_event_created: '2029-11-14T00:00:00.000Z',
              result: STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED,
            },
            error: null,
          },
        },
      }));

      const result = await recordStripeEventReceipt(
        {
          id: 'evt_processed_123',
          type: 'customer.subscription.updated',
          livemode: false,
          created: '2029-11-14T00:00:00.000Z',
        },
        STRIPE_EVENT_RECEIPT_RESULTS.DUPLICATE_IGNORED,
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'preserved_existing',
          receipt: expect.objectContaining({
            event_id: 'evt_processed_123',
            result: STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED,
          }),
        })
      );
      expect(mockSupabaseAdmin.from).toHaveBeenCalledTimes(1);
    });
  });

  describe('markSubscriptionDeletedFromEvent', () => {
    const userId = 'user-delete';

    it('preserves a safe local terminal snapshot instead of hard-deleting the subscription row', async () => {
      const adminClient = useAdminClient(createSupabaseClient({
        billing_customers: {
          maybeSingle: {
            data: { user_id: userId, stripe_customer_id: 'cus_delete_123' },
            error: null,
          },
        },
        billing_subscriptions: [
          {
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
          {
            single: {
              data: {
                user_id: userId,
                stripe_subscription_id: 'sub_delete_123',
                stripe_customer_id: 'cus_delete_123',
                price_id: 'price_tailor_monthly',
                status: 'canceled',
                current_period_end: '2029-11-30T00:00:00.000Z',
                cancel_at_period_end: true,
                last_stripe_event_created: '2029-11-14T00:00:00.000Z',
              },
              error: null,
            },
          },
        ],
      }));

      const result = await markSubscriptionDeletedFromEvent(
        {
          id: 'sub_delete_123',
          customer: 'cus_delete_123',
          cancel_at_period_end: true,
          current_period_end: null,
          items: { data: [] },
        },
        '2029-11-14T00:00:00.000Z',
        mockLog
      );

      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'processed',
          userId,
          localSubscription: expect.objectContaining({
            status: 'canceled',
          }),
        })
      );
      expect(adminClient.buildersByTable.billing_subscriptions[1].state.upsertPayload).toEqual(
        expect.objectContaining({
          user_id: userId,
          stripe_subscription_id: 'sub_delete_123',
          stripe_customer_id: 'cus_delete_123',
          price_id: 'price_tailor_monthly',
          status: 'canceled',
          cancel_at_period_end: true,
          last_stripe_event_created: '2029-11-14T00:00:00.000Z',
        })
      );
    });
  });
});
